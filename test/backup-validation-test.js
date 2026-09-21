'use strict';
// An encrypted backup is untrusted input: knowing its passphrase only proves the sender
// chose the contents. Imported records must clear the same bar as the connection form.
const assert = require('assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-backup-validation-'));
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.APPDATA = path.join(root, 'roaming');
process.env.CODEX_HOME = path.join(root, 'codex');
const { createTransfer, seal } = require('../src/transfer');
const { buildDestination } = require('../src/system-config');

const PASSPHRASE = 'a-passphrase-they-told-you';
const launcher = path.join(root, 'ticket-provider.exe'); // absolute, as the form requires

function fixture() {
  let rows = [],
    credentials = {};
  return {
    store: {
      readConnections: () => JSON.parse(JSON.stringify(rows)),
      writeConnections: value => (rows = JSON.parse(JSON.stringify(value))),
    },
    vault: {
      getSecret: id => (credentials[id] ? JSON.parse(JSON.stringify(credentials[id])) : null),
      setSecret: (id, value) => (credentials[id] = value),
      deleteSecret: id => delete credentials[id],
    },
    credentials,
  };
}
function backupOf(connections) {
  const credentials = {};
  for (const item of connections) credentials[item.id] = { password: 'backup-fixture' };
  return seal({ connections, credentials, assets: {} }, PASSPHRASE);
}
const good = {
  id: 'LEGIT',
  url: 'https://sap.example.invalid',
  client: '100',
  user: 'tester',
  language: 'EN',
  authType: 'basic',
  enabled: true,
  default: false,
  insecureTls: false,
  policy: { readOnly: true },
  baseConfig: {},
};

// Each of these would have been stored verbatim before validation was applied.
const rejected = [
  ['SAP client is not three digits', { ...good, id: 'BADCLIENT', client: 'NOT_THREE_DIGITS' }, /three digits/],
  [
    'SSO2 launcher is a relative path',
    { ...good, id: 'RELATIVE', authType: 'sso2', user: '', sso2: { command: 'evil.exe', args: [], timeoutMs: 30000 } },
    /absolute/,
  ],
  [
    'SSO2 paired with disabled TLS verification',
    {
      ...good,
      id: 'INSECURE',
      authType: 'sso2',
      user: '',
      insecureTls: true,
      sso2: { command: launcher, args: [], timeoutMs: 30000 },
    },
    /certificate verification/,
  ],
  [
    'OAuth token endpoint is plain HTTP',
    {
      ...good,
      id: 'OAUTHHTTP',
      authType: 'oauth',
      user: '',
      oauth: { tokenUrl: 'http://auth.example.invalid/token', clientId: 'c', scope: '' },
    },
    /HTTPS/,
  ],
  ['destination URL is not a URL', { ...good, id: 'BADURL', url: 'not-a-url' }, /valid SAP URL/],
];

for (const [name, record, expected] of rejected) {
  const f = fixture();
  const transfer = createTransfer(f.store, f.vault, path.join(root, 'certs'));
  assert.throws(() => transfer.importBackup(backupOf([record]), PASSPHRASE), expected, 'must reject: ' + name);
  // Rejection happens before anything is written, so the import stays atomic.
  assert.deepEqual(f.store.readConnections(), [], 'no connection stored after rejecting: ' + name);
  assert.deepEqual(Object.keys(f.credentials), [], 'no credential stored after rejecting: ' + name);
}

// A record that is merely invalid must not take a valid sibling in with it.
{
  const f = fixture();
  const transfer = createTransfer(f.store, f.vault, path.join(root, 'certs'));
  assert.throws(
    () => transfer.importBackup(backupOf([good, { ...good, id: 'BADCLIENT', client: 'xx' }]), PASSPHRASE),
    /BADCLIENT/,
  );
  assert.deepEqual(f.store.readConnections(), [], 'a rejected record rolls back the whole import');
}

// A legitimate backup still imports, and its policy and settings survive intact.
{
  const f = fixture();
  const transfer = createTransfer(f.store, f.vault, path.join(root, 'certs'));
  const result = transfer.importBackup(backupOf([good]), PASSPHRASE);
  assert.deepEqual(result.imported, ['LEGIT']);
  assert.deepEqual(result.warnings, []);
  const stored = f.store.readConnections()[0];
  assert.equal(stored.client, '100');
  assert.equal(stored.policy.readOnly, true);
  assert.equal(f.vault.getSecret('LEGIT').password, 'backup-fixture');
  assert.equal(buildDestination(stored, f.vault.getSecret('LEGIT')).client, '100');
}

// An absolute launcher path is legal (the form allows one), so it is reported, not hidden.
{
  const f = fixture();
  const transfer = createTransfer(f.store, f.vault, path.join(root, 'certs'));
  const record = {
    ...good,
    id: 'TICKET',
    authType: 'sso2',
    user: '',
    sso2: { command: launcher, args: [], timeoutMs: 30000 },
  };
  const result = transfer.importBackup(backupOf([record]), PASSPHRASE);
  assert.deepEqual(result.imported, ['TICKET']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /external ticket-provider program/);
  assert.ok(result.warnings[0].includes(launcher), 'the warning must name the program that will run');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(
  'PASS: malformed, insecure and relative-launcher backup records are refused atomically; valid backups still import and an absolute launcher path is reported.',
);
