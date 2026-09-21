'use strict';
// An exported backup holds every saved SAP password, so the key-derivation cost is what
// an offline attacker has to pay per guess. Version 2 raises it and records it; version 1
// backups must keep opening, and a hostile envelope must not be able to dictate the cost.
const assert = require('assert/strict'),
  crypto = require('crypto'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-backup-kdf-'));
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.APPDATA = path.join(root, 'roaming');
process.env.CODEX_HOME = path.join(root, 'codex');
const { seal, unseal } = require('../src/transfer');

const PASSPHRASE = 'a-sufficiently-long-passphrase';
const payload = { connections: [], credentials: {}, assets: {}, canary: 'round-trip' };

// Exports use version 2 and state their cost, so it can be raised again later.
const envelope = seal(payload, PASSPHRASE);
assert.equal(envelope.version, 2);
assert.equal(envelope.kdf, 'scrypt');
assert.deepEqual(envelope.params, { N: 131072, r: 8, p: 1 });
assert.ok(envelope.params.N > 16384, 'cost must exceed the Node default version 1 relied on');
assert.equal(unseal(envelope, PASSPHRASE).canary, 'round-trip');
assert.throws(() => unseal(envelope, 'the-wrong-passphrase'), /Incorrect passphrase/);

// A version 1 backup written by an earlier release must still open.
function sealVersion1(value, password) {
  const salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32); // Node defaults, as backup format version 1 used
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('SAP-MCP-BACKUP-1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    format: 'SAP-MCP-BACKUP',
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}
const legacy = sealVersion1(payload, PASSPHRASE);
assert.equal(unseal(legacy, PASSPHRASE).canary, 'round-trip', 'version 1 backups must remain readable');
assert.throws(() => unseal(legacy, 'the-wrong-passphrase'), /Incorrect passphrase/);

// A cost outside the accepted band is refused before any derivation is attempted, so a
// hostile envelope cannot demand gigabytes of memory on import.
for (const [name, params] of [
  ['absurd work factor', { N: 1 << 22, r: 8, p: 1 }],
  ['absurd block size', { N: 131072, r: 32, p: 1 }],
  ['not a power of two', { N: 100000, r: 8, p: 1 }],
  ['below the floor', { N: 1024, r: 8, p: 1 }],
  ['non-integer', { N: 131072.5, r: 8, p: 1 }],
  ['bad parallelism', { N: 131072, r: 8, p: 0 }],
]) {
  const started = Date.now();
  assert.throws(
    () => unseal({ ...envelope, params }, PASSPHRASE),
    /Unsupported backup key-derivation parameters/,
    'must refuse: ' + name,
  );
  assert.ok(Date.now() - started < 2000, 'refusal must be immediate, not after deriving: ' + name);
}
assert.throws(() => unseal({ ...envelope, params: undefined }, PASSPHRASE), /Invalid backup header/);
assert.throws(() => unseal({ ...envelope, version: 3 }, PASSPHRASE), /Unsupported encrypted backup format/);

// A cost inside the band but not the one used still fails: the parameters are bound into
// the ciphertext, so a rewritten header cannot be passed off as genuine.
assert.throws(
  () => unseal({ ...envelope, params: { N: 32768, r: 8, p: 1 } }, PASSPHRASE),
  /Incorrect passphrase or damaged backup/,
);

// Tampering with the ciphertext or tag is still caught.
assert.throws(
  () => unseal({ ...envelope, tag: Buffer.alloc(16).toString('base64') }, PASSPHRASE),
  /Incorrect passphrase/,
);

fs.rmSync(root, { recursive: true, force: true });
console.log(
  'PASS: exports use scrypt N=131072 with recorded parameters, version 1 backups still open, out-of-band costs are refused before derivation and a rewritten cost fails authentication.',
);
