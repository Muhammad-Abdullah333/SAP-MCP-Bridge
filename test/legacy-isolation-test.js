'use strict';
// Legacy discovery decrypts real credentials from the previous manager's locations, and
// those hang off the home directory. Overriding LOCALAPPDATA alone does not move them, so
// a throwaway run used to import the user's actual saved connections. This checks that
// SAP_MCP_BRIDGE_LEGACY_HOME moves every one of them, and that nothing else changes.
const assert = require('assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');
const { spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-legacy-isolation-'));

// Stands in for the user's real home: a vault location the test must never reach into.
const realHome = path.join(root, 'real-home');
fs.mkdirSync(path.join(realHome, '.abap-adt-mcp'), { recursive: true });
fs.writeFileSync(
  path.join(realHome, '.abap-adt-mcp', 'systems.json'),
  JSON.stringify({
    REAL_SYSTEM: { url: 'https://real.example.invalid', client: '100', user: 'real-user', password: 'real-password' },
  }),
);
const isolatedHome = path.join(root, 'isolated-home');
fs.mkdirSync(isolatedHome, { recursive: true });
const oneDrive = path.join(root, 'onedrive');

const probe = [
  'const paths=require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'paths.js')) + ');',
  'const vault=require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'legacy-vault.js')) + ');',
  'const migration=require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'migration.js')) + ');',
  'let report;',
  'try{report=migration.importLegacy({force:true,secretWriter:()=>{}});}catch(error){report={status:"error",imported:[],warnings:[error.message]};}',
  'process.stdout.write(JSON.stringify({legacyHome:paths.legacyHome,legacyIsolated:paths.legacyIsolated,legacySystemsFile:paths.legacySystemsFile,candidates:vault.candidates(),imported:report.imported,status:report.status}));',
].join('\n');

function run(extraEnv, label) {
  const dataDir = fs.mkdtempSync(path.join(root, label + '-data-'));
  const env = {
    ...process.env,
    LOCALAPPDATA: dataDir,
    APPDATA: path.join(dataDir, 'roaming'),
    CODEX_HOME: path.join(dataDir, 'codex'),
    USERPROFILE: realHome,
    HOME: realHome,
    OneDrive: oneDrive,
    ...extraEnv,
  };
  delete env.SAP_MCP_BRIDGE_LEGACY_HOME;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, label + ' probe failed: ' + result.stderr);
  return JSON.parse(result.stdout);
}

// Without the override, discovery follows the home directory. This is the behaviour that
// made an "isolated" run read the real vault, and it is what the override has to move.
const unisolated = run({}, 'unisolated');
assert.equal(unisolated.legacyIsolated, false);
assert.equal(unisolated.legacyHome, realHome);
assert.ok(unisolated.legacySystemsFile.startsWith(realHome), 'systems.json is located from the home directory');
assert.deepEqual(
  unisolated.imported,
  ['REAL_SYSTEM'],
  'a run without the override still imports from the home directory',
);
assert.ok(
  unisolated.candidates.some(file => file.startsWith(oneDrive)),
  'OneDrive Documents is searched by default',
);

// With the override, every discovery location moves and nothing reaches the real home.
const isolated = run({ SAP_MCP_BRIDGE_LEGACY_HOME: isolatedHome }, 'isolated');
assert.equal(isolated.legacyIsolated, true);
assert.equal(isolated.legacyHome, isolatedHome);
assert.ok(isolated.legacySystemsFile.startsWith(isolatedHome));
assert.deepEqual(isolated.imported, [], 'nothing from the real home may be imported');
assert.equal(isolated.status, 'not-found');
for (const file of isolated.candidates) {
  assert.ok(!file.startsWith(realHome), 'candidate must not reach the real home: ' + file);
  assert.ok(!file.startsWith(oneDrive), 'OneDrive Documents must be skipped when isolated: ' + file);
}
// The vault the override was meant to hide is still sitting there, untouched.
assert.ok(fs.existsSync(path.join(realHome, '.abap-adt-mcp', 'systems.json')), 'the source file is never modified');

fs.rmSync(root, { recursive: true, force: true });
console.log(
  'PASS: legacy vault and systems.json discovery follow SAP_MCP_BRIDGE_LEGACY_HOME, an isolated run imports nothing from the real home and skips OneDrive, and default discovery is unchanged.',
);
