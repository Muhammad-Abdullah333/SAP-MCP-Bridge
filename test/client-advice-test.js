'use strict';
// Every way client setup can fail, or connect nothing, comes with a plain-language next step,
// and the installer's summary names exactly the clients that need attention.
const assert = require('assert/strict');
const { advise, annotate, summarize } = require('../src/client-advice');

const cases = [
  [
    'Claude Desktop',
    'Existing Claude configuration is invalid JSON; it was left unchanged.',
    /Settings > Developer > Edit Config/,
  ],
  ['Claude Desktop', 'Unsupported Claude configuration; it was left unchanged.', /contains a mistake/],
  ['ChatGPT/Codex', 'Existing Codex configuration is invalid TOML; it was left unchanged.', /Open config\.toml/],
  [
    'ChatGPT/Codex',
    "EPERM: operation not permitted, rename 'a.tmp' -> 'config.toml'",
    /read-only, held open by another program/,
  ],
  ['Claude Desktop', 'EBUSY: resource busy or locked, open', /OneDrive/],
  ['ChatGPT/Codex', 'SAP-Bridge is already used by a custom connector. Rename that connector', /did not create/],
  ['ChatGPT/Codex', 'An inactive SAP-Bridge entry already exists.', /did not create/],
  [
    'ChatGPT/Codex',
    'Duplicate SAP MCP tables already exist; configuration was left unchanged.',
    /more than one SAP-Bridge section/,
  ],
  ['ChatGPT/Codex', 'Bridge launcher has a custom format; configuration was left unchanged.', /edited by hand/],
  ['ChatGPT/Codex', 'Custom registration name requires manual migration.', /older abap-adt-mcp setup/],
  ['ChatGPT/Codex', 'Some legacy destinations could not be migrated.', /older abap-adt-mcp setup/],
  [
    'Configuration recovery',
    'Could not restore C:\\x.json. Use its backup: EPERM',
    /could not put this settings file back/,
  ],
  ['Claude Desktop', 'something nobody anticipated', /Troubleshooting in the Setup Guide/],
];
for (const [client, message, expected] of cases) {
  const text = advise(client, 'error', message);
  assert.match(text, expected, message);
  assert.match(text, /^[\x20-\x7E]*$/, 'advice must be ASCII for the installer: ' + text);
}
assert.match(advise('Claude Desktop', 'configured'), /system tray/);
assert.match(advise('ChatGPT/Codex', 'skipped'), /not found on this computer/);
assert.match(advise('ChatGPT/Codex', 'preserved'), /own SAP-Bridge setup/);
assert.match(advise('Claude Desktop', 'rolled-back'), /another client/);
assert.equal(advise('Claude Desktop', 'unchanged'), '');

// A transactional failure: Codex is broken, Claude was configured and then put back.
const result = annotate({
  clients: [
    {
      client: 'Claude Desktop',
      status: 'rolled-back',
      files: [{ file: 'c.json', status: 'rolled-back', message: 'put back' }],
    },
    {
      client: 'ChatGPT/Codex',
      status: 'error',
      files: [{ file: 'config.toml', status: 'error', message: 'Existing Codex configuration is invalid TOML' }],
    },
  ],
});
assert.match(result.clients[1].advice, /config\.toml/);
assert.match(result.clients[1].files[0].advice, /config\.toml/);
const summary = summarize(result);
assert.match(summary, /^Claude Desktop: Not changed/m);
assert.match(summary, /^ChatGPT\/Codex: Codex's settings file/m);

// Nothing found: no failure to summarize, but each client says how to connect it later.
const none = annotate({
  clients: [
    { client: 'Claude Desktop', status: 'skipped', files: [] },
    { client: 'ChatGPT/Codex', status: 'skipped', files: [] },
  ],
});
assert.equal(summarize(none), '');
assert.match(none.clients[0].advice, /not found/);

// Broken settings files, through the real setup code: the message names the problem and
// where the parser stopped, and the advice is the specific one, not the fallback.
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-advice-'));
const { configureClaudeFile, configureChatGPT } = require('../src/configure');
for (const [client, name, content, configure, where] of [
  ['ChatGPT/Codex', 'config.toml', '[deliberately invalid', configureChatGPT, /row 1, col 16/],
  ['Claude Desktop', 'claude_desktop_config.json', '{"mcpServers": {"a": 1,}}', configureClaudeFile, /position|line/],
]) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  assert.throws(
    () => configure(file),
    error => {
      assert.match(error.message, /is invalid (JSON|TOML); it was left unchanged\./);
      assert.match(error.message, where);
      assert.match(advise(client, 'error', error.message), /contains a mistake/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(file, 'utf8'), content, 'a broken settings file must not be changed');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS: every client setup failure and outcome has a plain-language, installer-safe next step.');
