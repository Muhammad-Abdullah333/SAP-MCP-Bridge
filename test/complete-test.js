'use strict';
const assert = require('assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-complete-'));
process.env.LOCALAPPDATA = path.join(temp, 'local');
process.env.APPDATA = path.join(temp, 'roaming');
process.env.CODEX_HOME = path.join(temp, 'codex');
const clone = x => JSON.parse(JSON.stringify(x));
function fixture() {
  let rows = [];
  const credentials = {};
  let fail = false;
  return {
    store: {
      readConnections: () => clone(rows),
      writeConnections: value => {
        if (fail) throw new Error('disk failure');
        rows = clone(value);
      },
    },
    vault: {
      getSecret: id => (credentials[id] ? clone(credentials[id]) : null),
      setSecret: (id, value) => (credentials[id] = clone(value)),
      deleteSecret: id => delete credentials[id],
    },
    fail: value => (fail = value),
  };
}
const { createService, validate } = require('../src/connections'),
  { buildDestination } = require('../src/system-config');
const f = fixture(),
  service = createService(f.store, f.vault);
const base = {
  id: 'Dev.one.' + 'x'.repeat(65),
  url: 'https://example.invalid',
  client: '100',
  user: 'tester',
  password: 'test-secret',
  enabled: true,
};
let saved = service.save(base);
assert.equal(saved.policy.readOnly, true);
assert.equal(saved.id, base.id);
f.vault.setSecret(base.id, { password: 'test-secret', gitPassword: 'extra-secret', tlsPassphrase: 'tls-secret' });
const copy = service.duplicate(base.id);
assert.deepEqual(f.vault.getSecret(copy.id), f.vault.getSecret(base.id));
assert.equal(copy.default, false);
const renamed = service.save({
  ...base,
  password: '',
  originalId: base.id,
  id: 'Renamed.system',
  policy: { readOnly: false, allowedPackages: 'ZONE, ZTWO', deniedTables: 'SECRET', deniedTools: 'deleteObject' },
  servername: 'sap.example',
});
assert.equal(f.vault.getSecret(renamed.id).gitPassword, 'extra-secret');
assert.equal(
  f.store.readConnections().find(x => x.id === base.id),
  undefined,
);
const dest = buildDestination(f.store.readConnections()[0], f.vault.getSecret(renamed.id));
assert.equal(dest.tls.servername, 'sap.example');
assert.deepEqual(dest.policy.allowedPackages, ['ZONE', 'ZTWO']);
assert.throws(() => service.save({ ...base, id: renamed.id, isNew: true }), /already exists/);
assert.throws(() => service.save({ ...base, originalId: copy.id, id: renamed.id }), /already exists/);
f.fail(true);
assert.throws(() => service.save({ ...base, id: 'Failure' }), /disk failure/);
assert.equal(f.vault.getSecret('Failure'), null);
f.fail(false);
for (const authType of ['sso', 'sso2', 'oauth']) {
  const input = { ...base, id: authType, user: '', password: '', authType };
  if (authType === 'oauth') {
    input.oauth = { tokenUrl: 'https://auth.example/token', clientId: 'client', scope: 'sap' };
    input.oauthClientSecret = 'oauth-secret';
  }
  if (authType === 'sso2') input.sso2 = { command: path.join(temp, 'ticket-provider.exe'), args: [], timeoutMs: 30000 };
  const value = service.save(input);
  assert.equal(value.authType, authType);
}
assert.throws(
  () =>
    validate({
      ...base,
      authType: 'sso2',
      insecureTls: true,
      sso2: { command: path.join(temp, 'ticket.exe'), args: [] },
    }),
  /certificate verification/,
);
const existing = { ...base, policy: undefined };
assert.equal(validate({ ...base, password: '' }, existing).policy.readOnly, false);
// The form no longer sends a logon language. Saving must keep the stored one rather than
// quietly resetting a German connection to English, and a new connection starts in English.
const { language: _dropped, ...withoutLanguage } = base;
assert.equal(validate(withoutLanguage, { ...base, language: 'DE' }).language, 'DE', 'a save must keep the stored language');
assert.equal(validate(withoutLanguage).language, 'EN', 'a new connection logs on in English');
assert.equal(validate({ ...withoutLanguage, language: 'fr' }, { ...base, language: 'DE' }).language, 'FR', 'an explicit language still wins');
const { createTransfer, seal, unseal } = require('../src/transfer');
const cert = path.join(temp, 'ca.pem');
fs.writeFileSync(cert, require('tls').rootCertificates[0]);
const withCert = service.save({ ...base, id: 'Certificate', ca: cert });
const transfer = createTransfer(f.store, f.vault, path.join(temp, 'source-data'));
const backup = transfer.exportBackup('long-export-passphrase');
assert.ok(!JSON.stringify(backup).includes('test-secret'));
assert.throws(() => unseal(backup, 'incorrect-passphrase'), /Incorrect/);
const broken = { ...backup, tag: Buffer.alloc(16).toString('base64') };
assert.throws(() => unseal(broken, 'long-export-passphrase'), /Incorrect/);
const target = fixture();
const restore = createTransfer(target.store, target.vault, path.join(temp, 'destination'));
const result = restore.importBackup(backup, 'long-export-passphrase');
assert.equal(result.imported.length, f.store.readConnections().length);
const restored = target.store.readConnections().find(x => x.id === 'Certificate');
assert.ok(restored.ca.startsWith(path.join(temp, 'destination')));
assert.equal(fs.readFileSync(restored.ca, 'utf8'), fs.readFileSync(cert, 'utf8'));
assert.equal(target.vault.getSecret('Renamed.system').gitPassword, 'extra-secret');
assert.equal(restore.importBackup(backup, 'long-export-passphrase').imported.length, 0);
const untouched = JSON.stringify(target.store.readConnections());
assert.throws(() => restore.importBackup(broken, 'long-export-passphrase'));
assert.equal(JSON.stringify(target.store.readConnections()), untouched);
const storage = require('../src/storage'),
  migration = require('../src/migration');
storage.writeConnections([]);
const collected = {};
const imported = migration.importLegacy({
  entries: {
    ['Old.disabled.' + 'x'.repeat(45)]: {
      url: 'https://example.invalid',
      client: '100',
      user: 'x',
      password: 'legacy-secret',
      authType: 'basic',
      enabled: false,
      policy: { readOnly: true },
      tls: { servername: 'legacy.example' },
    },
  },
  source: 'test legacy vault',
  secretWriter: (id, value) => (collected[id] = value),
});
assert.equal(imported.imported.length, 1);
assert.equal(storage.readConnections()[0].enabled, false);
assert.equal(storage.readConnections()[0].default, false);
assert.equal(storage.readConnections()[0].baseConfig.tls.servername, 'legacy.example');
const configure = require('../src/configure');
const good = path.join(temp, 'claude.json'),
  bad = path.join(temp, 'bad.toml');
fs.writeFileSync(good, '{"mcpServers":{"other":{"command":"keep"}}}');
fs.writeFileSync(bad, '[broken');
const goodBefore = fs.readFileSync(good);
const configResult = configure.configureAll({
  transactional: true,
  report: false,
  clients: [
    { client: 'Claude Desktop', files: [good] },
    { client: 'ChatGPT/Codex', files: [bad] },
  ],
});
assert.equal(configResult.rolledBack, true);
assert.deepEqual(fs.readFileSync(good), goodBefore);
assert.equal(fs.readFileSync(bad, 'utf8'), '[broken');
console.log(
  'PASS: extended names, rename, duplicate secrets, auth modes, policy defaults, credential rollback, encrypted transfer, tamper rejection, certificate portability, disabled legacy migration and client-config rollback.',
);
