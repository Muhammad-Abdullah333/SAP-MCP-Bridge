'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-mcp-bridge-test-'));
process.env.LOCALAPPDATA = path.join(temp, 'local');
process.env.APPDATA = path.join(temp, 'roaming');
process.env.CODEX_HOME = path.join(temp, 'codex');
process.env.SAP_MCP_BRIDGE_HOME = path.resolve(__dirname, '..');
const storage = require('../src/storage');
const configure = require('../src/configure');
const paths = require('../src/paths');
const { importLegacy } = require('../src/migration');
const { buildDestination, buildDiscoveryUrl, loadEnabledSystems } = require('../src/system-config');
storage.writeConnections([
  {
    id: 'DEV',
    url: 'https://example.invalid',
    client: '100',
    user: 'TEST',
    enabled: true,
    default: true,
    hasPassword: true,
  },
]);
assert.equal(storage.readConnections()[0].id, 'DEV');
paths.legacySystemsFile = path.join(temp, 'systems.json');
paths.migrationFile = path.join(temp, 'migration.json');
fs.writeFileSync(
  paths.legacySystemsFile,
  JSON.stringify({
    DEV: { url: 'https://must-not-overwrite.invalid', client: '999', user: 'OTHER', password: 'other' },
    QAS: {
      url: 'https://qas.example.invalid',
      client: '200',
      authType: 'basic',
      user: 'QASUSER',
      password: 'secret',
      policy: { readOnly: true },
    },
  }),
);
const captured = {};
const migrated = importLegacy({
  force: true,
  secretWriter: (id, value) => {
    captured[id] = value;
  },
});
assert.deepEqual(migrated.imported, ['QAS']);
assert.deepEqual(migrated.skipped, ['DEV']);
assert.equal(captured.QAS.password, 'secret');
assert.equal(storage.readConnections().find(x => x.id === 'DEV').client, '100');
const qas = storage.readConnections().find(x => x.id === 'QAS');
assert.equal(qas.baseConfig.password, undefined);
assert.equal(qas.baseConfig.policy.readOnly, true);
const destination = buildDestination(qas, captured.QAS);
assert.equal(destination.password, 'secret');
assert.equal(destination.policy.readOnly, true);
assert.equal(destination.client, '200');
const discovery = buildDiscoveryUrl({ url: 'https://sap.example:44300', client: '200', language: 'DE' });
assert.equal(discovery.pathname, '/sap/bc/adt/discovery');
assert.equal(discovery.searchParams.get('sap-client'), '200');
assert.equal(discovery.searchParams.get('sap-language'), 'DE');
const resilient = loadEnabledSystems(
  [qas, { id: 'BROKEN', url: 'https://broken.invalid', client: '300', user: 'BAD', authType: 'basic', enabled: true }],
  id => {
    if (id === 'BROKEN') throw new Error('unreadable secret');
    return captured.QAS;
  },
  () => {},
);
assert.deepEqual(Object.keys(resilient), ['QAS']);
importLegacy({
  force: true,
  secretWriter: () => {
    throw new Error('duplicate should not write a secret');
  },
});
assert.equal(storage.readConnections().filter(x => x.id === 'QAS').length, 1);
fs.mkdirSync(process.env.APPDATA + '/Claude', { recursive: true });
fs.writeFileSync(
  process.env.APPDATA + '/Claude/claude_desktop_config.json',
  JSON.stringify({ keepMe: true, mcpServers: { other: { command: 'other' } } }),
);
const storeClaude = path.join(
  process.env.LOCALAPPDATA,
  'Packages',
  'Claude_test',
  'LocalCache',
  'Roaming',
  'Claude',
  'claude_desktop_config.json',
);
fs.mkdirSync(path.dirname(storeClaude), { recursive: true });
fs.writeFileSync(
  storeClaude,
  JSON.stringify({ storeSetting: true, mcpServers: { otherStore: { command: 'other-store' } } }),
);
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(
  process.env.CODEX_HOME + '/config.toml',
  'model = "example"\n\n[mcp_servers.other]\ncommand = "other"\n',
);
const result = configure.configureAll();
const claude = JSON.parse(fs.readFileSync(result.clients[0].files[0].file, 'utf8'));
assert.ok(claude.mcpServers['SAP-Bridge']);
assert.equal(claude.keepMe, true);
assert.ok(claude.mcpServers.other);
const storeConfig = JSON.parse(fs.readFileSync(storeClaude, 'utf8'));
assert.equal(storeConfig.storeSetting, true);
assert.ok(storeConfig.mcpServers.otherStore);
assert.ok(storeConfig.mcpServers['SAP-Bridge']);
const toml = fs.readFileSync(result.clients[1].files[0].file, 'utf8');
assert.match(toml, /\[mcp_servers\.SAP-Bridge\]/);
assert.match(toml, /MCP_TOOLSETS = "focused"/);
assert.match(toml, /\[mcp_servers\.other\]/);
configure.configureAll();
const second = fs.readFileSync(result.clients[1].files[0].file, 'utf8');
assert.equal((second.match(/BEGIN SAP MCP Desktop Bridge/g) || []).length, 1);
console.log('Self-test passed:', temp);
