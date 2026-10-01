'use strict';
// Windows Data Protection (DPAPI) for the signed-in Windows account, called in-process
// through crypt32.dll. Earlier versions ran a hidden PowerShell script for every password
// read or write; antivirus behaviour monitoring treats a hidden script that decrypts saved
// secrets as credential theft. The scope (CurrentUser), flags and lack of extra entropy
// match .NET's ProtectedData, so secrets saved by those versions decrypt unchanged.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const UI_FORBIDDEN = 0x1;
let api;

function koffiPath() {
  const candidates = [
    path.join(paths.installDir(), 'vendor', 'node_modules', 'koffi'),
    // A source checkout: packaging/fetch-base.py installs the vendored modules here.
    path.join(__dirname, '..', 'build', 'base-payload', 'app', 'vendor', 'node_modules', 'koffi'),
  ];
  const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  if (!found) throw new Error('Secure storage component is missing. Reinstall the Bridge.');
  return found;
}

function load() {
  if (api) return api;
  const koffi = require(koffiPath());
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('DATA_BLOB', { cbData: 'uint32_t', pbData: 'void *' });
  api = {
    koffi,
    protect: crypt32.func(
      'bool __stdcall CryptProtectData(DATA_BLOB *pDataIn, const char16_t *szDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ DATA_BLOB *pDataOut)',
    ),
    unprotect: crypt32.func(
      'bool __stdcall CryptUnprotectData(DATA_BLOB *pDataIn, void *ppszDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ DATA_BLOB *pDataOut)',
    ),
    free: kernel32.func('void * __stdcall LocalFree(void *hMem)'),
  };
  return api;
}

function transform(name, input, failure) {
  const { koffi, free, ...calls } = load();
  if (!input.length) throw new Error(failure);
  const output = {};
  const ok =
    name === 'protect'
      ? calls.protect({ cbData: input.length, pbData: input }, '', null, null, null, UI_FORBIDDEN, output)
      : calls.unprotect({ cbData: input.length, pbData: input }, null, null, null, null, UI_FORBIDDEN, output);
  if (!ok || !output.pbData) throw new Error(failure);
  try {
    return Buffer.from(koffi.decode(output.pbData, koffi.array('uint8_t', output.cbData, 'Typed')));
  } finally {
    free(output.pbData);
  }
}

module.exports = {
  protect: plain => transform('protect', plain, 'Windows could not encrypt the credential.'),
  unprotect: data => transform('unprotect', data, 'Windows could not decrypt the credential for this account.'),
};
