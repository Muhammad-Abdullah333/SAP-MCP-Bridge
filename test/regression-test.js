'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upgrade-test-'));
process.env.LOCALAPPDATA = path.join(temp, 'local');
process.env.APPDATA = path.join(temp, 'roaming');
process.env.CODEX_HOME = path.join(temp, 'codex');
const config = require('../src/configure');
const { importCertificate } = require('../src/certificates');
const { buildDestination } = require('../src/system-config');
const { setSecret, getSecret } = require('../src/secrets');
function put(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const env = {
  LOCALAPPDATA: path.join(temp, 'detect-local'),
  APPDATA: path.join(temp, 'detect-roaming'),
  ProgramFiles: path.join(temp, 'programs'),
  CODEX_HOME: path.join(temp, 'detect-codex'),
  PATH: '',
};
let clients = config.detectClients({ home: temp, env, platform: 'win32' });
assert.deepEqual(
  clients.map(c => c.files.length),
  [0, 0],
);
assert.deepEqual(
  config.configureAll({ clients, report: false }).clients.map(c => c.status),
  ['skipped', 'skipped'],
);
assert.ok(!fs.existsSync(env.CODEX_HOME));
put(path.join(env.LOCALAPPDATA, 'Programs', 'Claude', 'Claude.exe'));
clients = config.detectClients({ home: temp, env, platform: 'win32' });
assert.deepEqual(
  clients.map(c => c.files.length),
  [1, 0],
);
let report = config.configureAll({ clients, report: false });
assert.equal(report.clients[0].status, 'configured');
fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Packages', 'OpenAI.Codex_test'), { recursive: true });
clients = config.detectClients({ home: temp, env, platform: 'win32' });
assert.deepEqual(
  clients.map(c => c.files.length),
  [1, 1],
);
report = config.configureAll({ clients, report: false });
assert.equal(report.clients[1].status, 'configured');
assert.equal(config.configureAll({ clients, report: false }).clients[1].status, 'unchanged');
const manual =
  '[mcp_servers.SAP-Bridge]\ncommand = "my-node"\nargs = ["my-server.js"]\n\n[mcp_servers.SAP-Bridge.env]\nCUSTOM = "keep"\n\n[mcp_servers.other]\ncommand = "other"\n';
const manualFile = path.join(temp, 'manual.toml');
put(manualFile, manual);
assert.equal(config.configureChatGPT(manualFile).status, 'preserved');
assert.equal(fs.readFileSync(manualFile, 'utf8'), manual);
const quoted = manual.replaceAll('mcp_servers.SAP-Bridge', 'mcp_servers."SAP-Bridge"');
assert.equal(config.updateCodexText(quoted).text, quoted);
const old =
  '[mcp_servers.SAP-Bridge]\ncommand = "old-node"\nargs = ["C:\\\\old\\\\SAP MCP Desktop Bridge\\\\src\\\\host.js"]\nenabled = false\nstartup_timeout_sec = 60\n\n[mcp_servers.SAP-Bridge.env]\nMCP_TOOLSETS = "core"\nCUSTOM = "keep"\n\n[mcp_servers.other]\ncommand = "other"\n';
const upgradeFile = path.join(temp, 'upgrade.toml');
put(upgradeFile, old);
const upgraded = config.configureChatGPT(upgradeFile);
assert.equal(upgraded.status, 'configured');
assert.equal(fs.readFileSync(upgraded.backup, 'utf8'), old);
const updated = fs.readFileSync(upgradeFile, 'utf8');
assert.ok(updated.includes('enabled = false'));
assert.ok(updated.includes('MCP_TOOLSETS = "core"'));
assert.ok(updated.includes('CUSTOM = "keep"'));
assert.equal((updated.match(/\[mcp_servers.SAP-Bridge.env\]/g) || []).length, 1);
assert.equal(config.configureChatGPT(upgradeFile).status, 'unchanged');
const claudeFile = path.join(temp, 'claude.json');
const manualClaude = JSON.stringify({
  mcpServers: { 'SAP-Bridge': { command: 'manual' }, other: { command: 'other' } },
  keep: true,
});
put(claudeFile, manualClaude);
assert.equal(config.configureClaudeFile(claudeFile).status, 'preserved');
assert.equal(fs.readFileSync(claudeFile, 'utf8'), manualClaude);
put(
  claudeFile,
  JSON.stringify({
    mcpServers: {
      'SAP-Bridge': {
        command: 'old-node',
        args: ['C:/old/SAP MCP Desktop Bridge/src/host.js'],
        env: { CUSTOM: 'keep', MCP_TOOLSETS: 'core' },
      },
      other: { command: 'other' },
    },
    keep: true,
  }),
);
const before = fs.readFileSync(claudeFile, 'utf8');
const changed = config.configureClaudeFile(claudeFile);
assert.equal(fs.readFileSync(changed.backup, 'utf8'), before);
assert.equal(JSON.parse(fs.readFileSync(claudeFile)).mcpServers['SAP-Bridge'].env.CUSTOM, 'keep');
put(claudeFile, '{broken');
report = config.configureAll({
  clients: [
    { client: 'Claude Desktop', files: [claudeFile] },
    { client: 'ChatGPT/Codex', files: [upgradeFile] },
  ],
  report: false,
});
assert.equal(report.clients[0].status, 'error');
assert.equal(report.clients[1].status, 'unchanged');
assert.equal(fs.readFileSync(claudeFile, 'utf8'), '{broken');
const pem = tls.rootCertificates[0];
for (const ext of ['pem', 'crt', 'cer', 'CER']) {
  const bytes = ext === 'cer' ? new crypto.X509Certificate(pem).raw : Buffer.from(pem);
  const imported = importCertificate({ name: `test.${ext}`, content: bytes.toString('base64') });
  assert.ok(imported.path.startsWith(process.env.LOCALAPPDATA));
  assert.equal(
    new crypto.X509Certificate(fs.readFileSync(imported.path)).fingerprint256,
    new crypto.X509Certificate(pem).fingerprint256,
  );
}
assert.throws(() => importCertificate({ name: 'bad.exe', content: Buffer.from(pem).toString('base64') }));
assert.throws(() =>
  importCertificate({ name: 'bad.pem', content: Buffer.from('not a certificate').toString('base64') }),
);
assert.throws(() =>
  importCertificate({ name: 'key.pem', content: Buffer.from(pem + '\nPRIVATE KEY').toString('base64') }),
);
const item = {
  id: 'DEV',
  url: 'https://example.invalid',
  client: '100',
  user: 'test',
  ca: '',
  baseConfig: { tls: { ca: 'old.pem', servername: 'sap.example' }, policy: { readOnly: true } },
};
const destination = buildDestination(item, { password: 'test' });
assert.equal(destination.tls.ca, undefined);
assert.equal(destination.tls.servername, 'sap.example');
assert.equal(destination.policy.readOnly, true);
try {
  setSecret('UPGRADE', { password: 'unchanged-test-password', gitPassword: 'preserve-extra-secret' });
  assert.equal(getSecret('UPGRADE').gitPassword, 'preserve-extra-secret');
} catch (error) {
  if (!error.message.includes('EPERM')) throw error;
  console.log('Nested PowerShell blocked by sandbox; verify the DPAPI helper directly.');
}
console.log('Regression checks passed. Isolated fixtures:', temp);
const macHome = path.join(temp, 'mac-home');
const macEnv = { PATH: '', CODEX_HOME: path.join(macHome, '.codex') };
assert.deepEqual(
  config.detectClients({ home: macHome, env: macEnv, platform: 'darwin' }).map(c => c.files.length),
  [0, 0],
);
fs.mkdirSync(path.join(macHome, 'Applications', 'Claude.app'), { recursive: true });
fs.mkdirSync(path.join(macHome, 'Applications', 'Codex.app'), { recursive: true });
assert.deepEqual(
  config.detectClients({ home: macHome, env: macEnv, platform: 'darwin' }).map(c => c.files.length),
  [1, 1],
);
console.log('macOS client-location fixtures passed.');
