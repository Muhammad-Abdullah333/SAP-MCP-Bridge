'use strict';
const assert = require('assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-delete-'));
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.APPDATA = path.join(root, 'roaming');
process.env.CODEX_HOME = path.join(root, 'codex');
const storage = require('../src/storage'),
  { createService } = require('../src/connections'),
  { importLegacy } = require('../src/migration'),
  { registrationWarnings } = require('../src/configure');
const credentials = {};
const vault = {
  getSecret: id => credentials[id] || null,
  setSecret: (id, value) => {
    credentials[id] = value;
  },
  deleteSecret: id => {
    delete credentials[id];
  },
};
const service = createService(storage, vault);
service.save({
  id: 'DEV.120',
  url: 'https://example.invalid',
  client: '120',
  user: 'fixture',
  password: 'fixture-only',
});
service.remove('DEV.120');
assert.equal(storage.readConnections().length, 0);
assert.equal(credentials['DEV.120'], undefined);
const report = importLegacy({
  force: true,
  entries: { 'dev.120': { url: 'https://example.invalid', client: '120', user: 'fixture', password: 'fixture-only' } },
  secretWriter: () => {
    throw new Error('Deleted connection must not write secrets');
  },
});
assert.equal(report.imported.length, 0);
assert.match(report.warnings[0], /previously deleted/);
assert.equal(storage.readConnections().length, 0);
const alias = importLegacy({
  entries: {
    ORIGINAL_NAME: { url: 'https://example.invalid/', client: '120', user: 'fixture', password: 'fixture-only' },
  },
  secretWriter: () => {
    throw new Error('Deleted destination alias must not write secrets');
  },
});
assert.equal(alias.imported.length, 0);
assert.match(alias.warnings[0], /previously deleted/);
// Deletion metadata is durable and a failed secret deletion restores both records.
service.save({ id: 'KEEP', url: 'https://example.invalid', client: '110', user: 'fixture', password: 'fixture-only' });
const failing = createService(storage, {
  ...vault,
  deleteSecret: () => {
    throw new Error('vault failure');
  },
});
assert.throws(() => failing.remove('KEEP'), /vault failure/);
assert.equal(storage.readConnections()[0].id, 'KEEP');
assert.ok(!storage.readDeletedIds().includes('KEEP'));
// Explicit creation remains possible after deletion.
service.save({
  id: 'DEV.120',
  isNew: true,
  url: 'https://example.invalid',
  client: '120',
  user: 'fixture',
  password: 'fixture-only',
});
assert.equal(storage.readConnections().length, 2);
const config = path.join(root, 'config.toml');
fs.writeFileSync(
  config,
  '[mcp_servers.abap-adt]\ncommand="node"\nargs=["legacy-abap-adt-mcp/index.js"]\nenabled=true\n',
);
const clients = [{ client: 'ChatGPT/Codex', files: [config] }];
assert.match(registrationWarnings(clients)[0], /independent of Bridge/);
fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('enabled=true', 'enabled=false'));
assert.deepEqual(registrationWarnings(clients), []);
console.log(
  'PASS: delete removes metadata/secrets, repeated legacy import respects durable deletion, failed deletion rolls back, explicit recreation works, and independent MCP registrations are reported.',
);

const { configureChatGPT, hostCommand } = require('../src/configure'),
  TOML = require('../src/lib/toml');
const source = path.join(root, 'legacy-systems.json');
const systems = {
  'DEV.120': { url: 'https://example.invalid', client: '120', user: 'fixture', password: 'fixture-only' },
  'OLD.110': { url: 'https://example.invalid', client: '110', user: 'legacy', password: '${env:LEGACY_TEST_PASSWORD}' },
};
service.remove('DEV.120');
fs.writeFileSync(source, JSON.stringify(systems));
const originalSource = fs.readFileSync(source);
const legacyText =
  '# retain this comment\n[mcp_servers.abap-adt]\ncommand="node"\nargs=["/old/node_modules/abap-adt-mcp/dist/index.js"]\nenabled=true\n[mcp_servers.abap-adt.env]\nSAP_SYSTEMS_FILE=' +
  JSON.stringify(source) +
  '\nLEGACY_TEST_PASSWORD="migration-fixture"\n[mcp_servers.abap-adt-mcp]\ncommand=' +
  JSON.stringify(hostCommand().command) +
  '\nargs=' +
  JSON.stringify(hostCommand().args) +
  '\n[mcp_servers.unrelated]\ncommand="keep-this"\n';
fs.writeFileSync(config, legacyText);
const adopted = configureChatGPT(config, { secretWriter: vault.setSecret });
assert.ok(adopted.backup);
assert.equal(fs.readFileSync(adopted.backup, 'utf8'), legacyText);
const adoptedText = fs.readFileSync(config, 'utf8'),
  parsed = TOML.parse(adoptedText);
assert.ok(adoptedText.includes('# retain this comment'));
assert.deepEqual(parsed.mcp_servers['SAP-Bridge'].args, hostCommand().args);
assert.equal(parsed.mcp_servers['abap-adt-mcp'].enabled, false);
assert.equal(parsed.mcp_servers.unrelated.command, 'keep-this');
assert.equal(credentials['OLD.110'].password, 'migration-fixture');
assert.ok(!storage.readConnections().some(x => x.id === 'DEV.120'));
assert.deepEqual(fs.readFileSync(source), originalSource);
configureChatGPT(config, { secretWriter: vault.setSecret });
assert.equal(fs.readFileSync(config, 'utf8'), adoptedText);
assert.deepEqual(registrationWarnings(clients), []);
console.log(
  'PASS: supported legacy registration migrates to SAP-Bridge, imports credentials, preserves source/comment/unrelated connector, skips deleted destinations, disables duplicate and remains idempotent.',
);
