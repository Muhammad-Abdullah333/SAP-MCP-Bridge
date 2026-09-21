'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const { ensureDir } = require('./storage');

function helper() {
  return path.join(__dirname, 'windows-secret-store.ps1');
}

function runWindows(action, id, value) {
  ensureDir(paths.secretsDir);
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = spawnSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper(),
      '-Action',
      action,
      '-Id',
      id,
      '-Store',
      paths.secretsDir,
    ],
    { input: value === undefined ? '' : JSON.stringify(value), encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw new Error(`Secure storage could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Secure storage failed').trim());
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function runMac(action, id, value) {
  const service = `com.sap-mcp-desktop-bridge.${id}`;
  if (action === 'set') {
    const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
    const result = spawnSync(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-a', 'sap-mcp-desktop-bridge', '-s', service, '-w', payload],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error((result.stderr || 'Keychain write failed').trim());
    return { ok: true };
  }
  if (action === 'get') {
    const result = spawnSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', 'sap-mcp-desktop-bridge', '-s', service, '-w'],
      { encoding: 'utf8' },
    );
    if (result.error) throw new Error('Keychain could not start: ' + result.error.message);
    if (result.status === 44) return null;
    if (result.status !== 0)
      throw new Error('Keychain access failed or was cancelled. Saved credentials were not changed.');
    return JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'));
  }
  const result = spawnSync(
    '/usr/bin/security',
    ['delete-generic-password', '-a', 'sap-mcp-desktop-bridge', '-s', service],
    { encoding: 'utf8' },
  );
  return { ok: result.status === 0 || /could not be found/i.test(result.stderr || '') };
}

function call(action, id, value) {
  id = require('./identity').key(id);
  if (process.platform === 'win32') return runWindows(action, id, value);
  if (process.platform === 'darwin') return runMac(action, id, value);
  throw new Error('Secure credential storage is supported on Windows and macOS.');
}

module.exports = {
  setSecret: (id, value) => call('set', id, value),
  getSecret: id => call('get', id),
  deleteSecret: id => call('delete', id),
};
