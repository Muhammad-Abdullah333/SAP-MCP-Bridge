'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const { ensureDir } = require('./storage');

// One DPAPI-protected file per connection: <id>.bin holds the UTF-8 JSON of its secrets.
function runWindows(action, id, value) {
  if (!/^[A-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid credential identifier.');
  ensureDir(paths.secretsDir);
  const file = path.join(paths.secretsDir, `${id}.bin`);
  const dpapi = require('./dpapi');
  if (action === 'set') {
    const plain = Buffer.from(value === undefined ? 'null' : JSON.stringify(value), 'utf8');
    try {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, dpapi.protect(plain), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      plain.fill(0);
    }
    return { ok: true };
  }
  if (action === 'get') {
    if (!fs.existsSync(file)) return null;
    const plain = dpapi.unprotect(fs.readFileSync(file));
    try {
      const text = plain.toString('utf8').replace(/^\uFEFF/, '');
      return text ? JSON.parse(text) : null;
    } finally {
      plain.fill(0);
    }
  }
  fs.rmSync(file, { force: true });
  return { ok: true };
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
