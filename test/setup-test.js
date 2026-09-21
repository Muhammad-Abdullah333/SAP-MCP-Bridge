const assert = require('assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-setup-'));
process.env.LOCALAPPDATA = root;
const paths = require('../src/paths');
fs.mkdirSync(paths.dataDir, { recursive: true });
const prefs = require('../src/preferences');
prefs.save({ theme: 'dark' });
prefs.save({ setupSeen: true });
assert.deepEqual(prefs.read(), { theme: 'dark', setupSeen: true });
prefs.save({ theme: 'system' });
assert.equal(prefs.read().setupSeen, true);
assert.throws(() => prefs.save({ theme: 'wrong' }));
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/errors.js'), 'utf8'), context);
for (const [message, section] of [
  ['401 Unauthorized', 'guide-login'],
  ['403 Forbidden', 'guide-login'],
  ['Choose a .pem, .crt, or .cer certificate.', 'guide-tls'],
  ['CERT_HAS_EXPIRED', 'guide-tls'],
  ['ENOTFOUND', 'guide-url'],
  ['Invalid passphrase', 'guide-backup'],
  ['unusual failure', 'guide-troubleshooting'],
])
  assert.equal(context.explainError(message).section, section);
const configure = require('../src/configure'),
  TOML = require('../src/lib/toml');
for (const type of ['Claude Desktop', 'ChatGPT/Codex']) {
  const file = path.join(root, type === 'Claude Desktop' ? 'claude.json' : 'codex.toml');
  const entry = { command: 'node', args: configure.hostCommand().args, env: { CUSTOM: 'keep' } };
  const original =
    type === 'Claude Desktop'
      ? JSON.stringify({ mcpServers: { 'abap-adt-mcp': entry, other: { command: 'keep' } } })
      : '[mcp_servers."abap-adt-mcp"]\ncommand="node"\nargs=' +
        JSON.stringify(entry.args) +
        '\n[mcp_servers."abap-adt-mcp".env]\nCUSTOM="keep"\n[mcp_servers.other]\ncommand="keep"\n';
  fs.writeFileSync(file, original);
  const apply = () =>
    type === 'Claude Desktop' ? configure.configureClaudeFile(file) : configure.configureChatGPT(file);
  const result = apply();
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  const config =
    type === 'Claude Desktop' ? JSON.parse(fs.readFileSync(file)) : TOML.parse(fs.readFileSync(file, 'utf8'));
  const entries = config.mcpServers || config.mcp_servers;
  assert.ok(entries['SAP-Bridge']);
  assert.ok(!entries['abap-adt-mcp']);
  assert.equal(entries['SAP-Bridge'].env.CUSTOM, 'keep');
  assert.equal(entries.other.command, 'keep');
  assert.equal(apply().status, 'unchanged');
}
console.log(
  'PASS: setup/theme preference preservation, error guidance, canonical JSON/TOML rename, backup, unrelated entries and idempotence',
);
