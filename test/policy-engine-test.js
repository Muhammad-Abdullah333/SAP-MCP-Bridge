'use strict';
// Exercises the patched policy engine that Bridge overlays onto the bundled MCP server.
// Every case below is a decision that reaches SAP or does not, so each gate is asserted
// in both directions: what it must block, and what it must still allow.
//
// Hermetic by design: the vendored tree lives under build/ and is not in version control,
// so the test stands up a minimal toolManifest with the real read/write classification of
// the tools it uses. test/policy-runtime-test.js covers the real bundled server.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-engine-'));
const dist = path.join(root, 'dist');
fs.mkdirSync(path.join(dist, 'lib'), { recursive: true });

// Read/write classification copied from the real manifest. runQuery and tableContents are
// READ tools, which is why readOnly alone does not keep anyone out of a sensitive table.
const READ_ONLY = ['getObjectSource', 'tableContents', 'runQuery', 'systemProfile', 'listSystems', 'healthcheck'];
fs.writeFileSync(
  path.join(dist, 'toolManifest.js'),
  [
    "'use strict';",
    `exports.READ_ONLY_TOOLS = new Set(${JSON.stringify(READ_ONLY)});`,
    "exports.TOOLSETS = { data: { handlers: ['dataH'] }, git: { handlers: ['gitH'] }, source: { handlers: ['srcH'] } };",
    "exports.TOOL_ROUTES = { dataH: ['runQuery', 'tableContents'], gitH: ['gitPullRepo', 'pushRepo'], srcH: ['setObjectSource', 'editObjectSource'] };",
    '',
  ].join('\n'),
);
fs.copyFileSync(path.join(__dirname, '..', 'packaging', 'vendor-patch', 'node_modules', 'abap-adt-mcp', 'dist', 'lib', 'policy.js'), path.join(dist, 'lib', 'policy.js'));
const { evaluatePolicy, parsePolicy, tablesInSql } = require(path.join(dist, 'lib', 'policy.js'));

// Stands in for SAP: anything whose URL mentions a z/y object sits in a custom package.
const ctx = { resolvePackage: async url => (/\/(z|y)/i.test(url) ? 'ZCUSTOM' : 'SAPBASIS') };

let checked = 0;
async function expect(outcome, name, policy, tool, args, gate) {
  const r = await evaluatePolicy(policy, tool, args, ctx);
  const want = outcome === 'allow';
  assert.equal(r.allowed, want, `${name}: expected ${outcome}, got ${r.allowed ? 'allow' : 'deny'}${r.reason ? ' (' + r.reason + ')' : ''}`);
  if (gate) assert.equal(r.gate, gate, `${name}: expected gate ${gate}, got ${r.gate}`);
  checked += 1;
}
const allow = (...a) => expect('allow', ...a);
const deny = (...a) => expect('deny', ...a);

const zWrite = { objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_demo', source: 'x' };
const stdWrite = { objectSourceUrl: '/sap/bc/adt/programs/programs/rsusr002', source: 'x' };
const activation = n => ({ objects: JSON.stringify(Array.from({ length: n }, (_, i) => ({ 'adtcore:uri': i === n - 1 ? '/sap/bc/adt/programs/programs/rsusr002' : '/sap/bc/adt/oo/classes/zcl_ok' }))) });

(async () => {
  // ---- readOnly, unchanged by the patch ------------------------------------
  await deny('readOnly blocks a source write', { readOnly: true }, 'setObjectSource', zWrite, 'readOnly');
  await deny('readOnly blocks runClass', { readOnly: true }, 'runClass', { className: 'CL_ANY' }, 'readOnly');
  await deny('readOnly blocks runSnippet', { readOnly: true }, 'runSnippet', { code: 'DELETE FROM ztab.' }, 'readOnly');
  await allow('readOnly still allows reads', { readOnly: true }, 'getObjectSource', { objectSourceUrl: '/x' });
  // Worth stating outright: read-only does not keep anyone out of table data.
  await allow('readOnly does NOT block reading a table', { readOnly: true }, 'tableContents', { ddicEntityName: 'USR02' });

  // ---- wildcards, which already worked upstream ----------------------------
  await allow('Z* allows a custom write', { allowedPackages: ['Z*', 'Y*'] }, 'setObjectSource', zWrite);
  await deny('Z* blocks a standard write', { allowedPackages: ['Z*', 'Y*'] }, 'setObjectSource', stdWrite, 'allowedPackages');

  // ---- runClass: ungated upstream, gated now -------------------------------
  await deny('runClass is gated by allowedPackages', { allowedPackages: ['Z*'] }, 'runClass', { className: 'CL_STANDARD_DANGEROUS' }, 'allowedPackages');
  await allow('runClass on a custom class is allowed', { allowedPackages: ['Z*'] }, 'runClass', { className: 'ZCL_MINE' });
  await deny('runClass with no class name is refused when closed', { allowedPackages: ['Z*'] }, 'runClass', {}, 'allowedPackages');

  // ---- activation: upstream stopped checking after 50 ----------------------
  await deny('activation checks past the 50th object', { allowedPackages: ['Z*'] }, 'activateObjects', activation(51), 'allowedPackages');
  await deny('activation checks the 200th object', { allowedPackages: ['Z*'] }, 'activateObjects', activation(200), 'allowedPackages');
  await deny('an oversized activation batch is refused, not half-checked', { allowedPackages: ['Z*'] }, 'activateObjects', activation(201), 'allowedPackages');
  await allow('an all-custom activation passes', { allowedPackages: ['Z*'] }, 'activateObjects', { objects: JSON.stringify([{ 'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_ok' }]) });

  // ---- quoted identifiers: the deniedTables bypass -------------------------
  await deny('deniedTables blocks a direct read', { deniedTables: ['USR02'] }, 'tableContents', { ddicEntityName: 'USR02' }, 'deniedTables');
  await deny('deniedTables blocks plain SQL', { deniedTables: ['USR02'] }, 'runQuery', { sqlQuery: 'SELECT * FROM USR02' }, 'deniedTables');
  for (const [label, sql] of [
    ['double-quoted', 'SELECT * FROM "USR02"'],
    ['single-quoted', "SELECT * FROM 'USR02'"],
    ['bracketed', 'SELECT * FROM [USR02]'],
    ['backquoted', 'SELECT * FROM `USR02`'],
    ['quoted in a JOIN', 'SELECT * FROM ZOK JOIN "USR02" ON 1=1'],
  ]) {
    await deny(`deniedTables blocks a ${label} identifier`, { deniedTables: ['USR02'] }, 'runQuery', { sqlQuery: sql }, 'deniedTables');
  }
  await deny('deniedTables still matches by wildcard', { deniedTables: ['PA*'] }, 'runQuery', { sqlQuery: 'SELECT * FROM PA0008' }, 'deniedTables');
  await allow('an unrelated table is unaffected', { deniedTables: ['USR02'] }, 'runQuery', { sqlQuery: 'SELECT * FROM ZMINE' });
  assert.deepEqual(tablesInSql('SELECT * FROM "USR02" JOIN ZB ON 1=1').sort(), ['USR02', 'ZB']);

  // ---- allowFreeSql --------------------------------------------------------
  await deny('allowFreeSql:false blocks runQuery outright', { allowFreeSql: false }, 'runQuery', { sqlQuery: 'SELECT * FROM "USR02"' }, 'allowFreeSql');
  await deny('allowFreeSql:false blocks tableContents with SQL', { allowFreeSql: false }, 'tableContents', { sqlQuery: 'SELECT 1' }, 'allowFreeSql');
  await allow('allowFreeSql:false still allows a named table read', { allowFreeSql: false }, 'tableContents', { ddicEntityName: 'ZMINE' });

  // ---- allowedTables: new -------------------------------------------------
  await allow('allowedTables permits a listed table', { allowedTables: ['ZMINE*'] }, 'tableContents', { ddicEntityName: 'ZMINE_DATA' });
  await deny('allowedTables refuses an unlisted table', { allowedTables: ['ZMINE*'] }, 'tableContents', { ddicEntityName: 'USR02' }, 'allowedTables');
  await deny('allowedTables refuses unlisted SQL', { allowedTables: ['ZMINE*'] }, 'runQuery', { sqlQuery: 'SELECT * FROM USR02' }, 'allowedTables');
  await deny('allowedTables refuses a quoted unlisted table', { allowedTables: ['ZMINE*'] }, 'runQuery', { sqlQuery: 'SELECT * FROM "USR02"' }, 'allowedTables');
  await deny('allowedTables is closed when the target is undeterminable', { allowedTables: ['ZMINE*'] }, 'runQuery', { sqlQuery: 'WITH x AS (VALUES 1) SELECT * FROM x2' }, 'allowedTables');
  await deny('allowedTables also covers a table named in written source', { allowedTables: ['ZMINE*'] }, 'setObjectSource', { objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_demo', source: 'SELECT * FROM USR02.' }, 'allowedTables');

  // ---- allowedTools: new ---------------------------------------------------
  await allow('allowedTools permits a listed tool', { allowedTools: ['getObjectSource'] }, 'getObjectSource', { objectSourceUrl: '/x' });
  await deny('allowedTools refuses an unlisted tool', { allowedTools: ['getObjectSource'] }, 'deleteObject', { objectUrl: '/sap/bc/adt/oo/classes/zcl_demo' }, 'allowedTools');
  await allow('allowedTools accepts a wildcard', { allowedTools: ['get*'] }, 'getObjectSource', { objectSourceUrl: '/x' });
  await allow('allowedTools accepts a toolset', { allowedTools: ['toolset:data'] }, 'runQuery', { sqlQuery: 'SELECT * FROM ZMINE' });
  await deny('a tool outside the allowed toolset is refused', { allowedTools: ['toolset:data'] }, 'setObjectSource', zWrite, 'allowedTools');
  // The connection has to be usable at all: session and health tools stay reachable.
  for (const tool of ['login', 'logout', 'dropSession', 'listSystems', 'healthcheck', 'systemProfile']) {
    await allow(`allowedTools never locks out ${tool}`, { allowedTools: ['getObjectSource'] }, tool, {});
  }
  // exportPackageSources writes source to local disk, so it is NOT treated as always-safe.
  await deny('allowedTools covers exportPackageSources', { allowedTools: ['getObjectSource'] }, 'exportPackageSources', {}, 'allowedTools');

  // ---- customOnly: new -----------------------------------------------------
  await deny('customOnly blocks a standard write', { customOnly: true }, 'setObjectSource', stdWrite, 'customOnly');
  await allow('customOnly allows a custom write', { customOnly: true }, 'setObjectSource', zWrite);
  await allow('customOnly leaves reads alone', { customOnly: true }, 'getObjectSource', { objectSourceUrl: '/sap/bc/adt/programs/programs/rsusr002' });
  await deny('customOnly blocks creating in a standard package', { customOnly: true }, 'createObject', { parentName: 'SAPBASIS' }, 'customOnly');
  await allow('customOnly allows creating in a Z package', { customOnly: true }, 'createObject', { parentName: 'ZDEMO' });
  await allow('customOnly allows a local $TMP object', { customOnly: true }, 'createObject', { parentName: '$TMP' });
  await allow('customOnly allows a customer namespace package', { customOnly: true }, 'createObject', { parentName: '/ACME/APP' });
  await deny('customOnly blocks running a standard class', { customOnly: true }, 'runClass', { className: 'CL_STANDARD_DANGEROUS' }, 'customOnly');
  await deny('customOnly blocks moving an object into a standard package', { customOnly: true }, 'changePackageExecute', { newPackage: 'SAPBASIS' }, 'customOnly');
  await deny('customOnly refuses a write whose package cannot be derived', { customOnly: true }, 'gitPullRepo', { transport: 'DEVK900001' }, 'customOnly');
  await deny('customOnly reports its own reason, not allowedPackages', { customOnly: true }, 'setObjectSource', stdWrite, 'customOnly');

  // ---- a write with no target must not slip past the package gate ----------
  // The branch that resolves an object's package used to require the target argument to
  // be present. Without it the gate was skipped entirely and the call was allowed, so a
  // closed policy silently permitted eleven write tools. Each is asserted here because a
  // gate that fails open is worse than no gate: the user is told they are protected.
  for (const [tool, arg] of Object.entries({
    setObjectSource: 'objectSourceUrl',
    editObjectSource: 'objectSourceUrl',
    setMethodSource: 'classUrl',
    atcApplyQuickfix: 'objectSourceUrl',
    deleteObject: 'objectUrl',
    lock: 'objectUrl',
    activateByName: 'objectUrl',
    setDomainProperties: 'domainUrl',
    setDataElementProperties: 'dataElementUrl',
    setTextElements: 'objectUrl',
    changePackagePreview: 'objectUrl',
  })) {
    await deny(`${tool} with no target is refused on a closed policy`, { customOnly: true }, tool, {}, 'customOnly');
    await allow(`${tool} still works on a custom object`, { customOnly: true }, tool, { [arg]: '/sap/bc/adt/programs/programs/zmine' });
    await deny(`${tool} is still refused on a standard object`, { customOnly: true }, tool, { [arg]: '/sap/bc/adt/programs/programs/rsusr002' }, 'customOnly');
    // An open policy has no package gate at all, so the refusal must not leak into it.
    await allow(`${tool} with no target is untouched when no package policy is set`, {}, tool, {});
  }
  await deny('createTestInclude with no class is refused on a closed policy', { customOnly: true }, 'createTestInclude', {}, 'customOnly');
  await allow('createTestInclude still works for a custom class', { customOnly: true }, 'createTestInclude', { clas: 'ZCL_MINE' });
  await deny('changePackageExecute with no target package is refused', { customOnly: true }, 'changePackageExecute', {}, 'customOnly');

  // ---- the two package gates compose --------------------------------------
  await deny('a Z package outside allowedPackages is still refused', { customOnly: true, allowedPackages: ['ZFIN*'] }, 'createObject', { parentName: 'ZHR' }, 'allowedPackages');
  await deny('a standard package inside allowedPackages is still refused', { customOnly: true, allowedPackages: ['SAP*'] }, 'createObject', { parentName: 'SAPBASIS' }, 'customOnly');
  await allow('a package satisfying both gates passes', { customOnly: true, allowedPackages: ['ZFIN*'] }, 'createObject', { parentName: 'ZFIN_CORE' });

  // ---- allowedTransports, unchanged by the patch --------------------------
  await deny('creating a transport is refused when the list is set', { allowedTransports: ['DEVK9*'] }, 'createTransport', {}, 'allowedTransports');
  await deny('an unlisted transport is refused', { allowedTransports: ['DEVK9*'] }, 'setObjectSource', { ...zWrite, transport: 'PRDK900001' }, 'allowedTransports');
  await allow('a listed transport passes', { allowedTransports: ['DEVK9*'] }, 'setObjectSource', { ...zWrite, transport: 'DEVK900123' });

  // ---- an empty policy must not block anything ----------------------------
  await allow('an empty policy allows everything', {}, 'setObjectSource', stdWrite);
  await allow('an absent policy allows everything', undefined, 'deleteObject', { objectUrl: '/x' });

  // ---- parsePolicy round-trips the new fields -----------------------------
  const parsed = parsePolicy({ customOnly: true, allowedTables: ['ZA', 'ZB'], allowedTools: 'getObjectSource,runQuery', readOnly: false });
  assert.equal(parsed.customOnly, true);
  assert.deepEqual(parsed.allowedTables, ['ZA', 'ZB']);
  assert.deepEqual(parsed.allowedTools, ['getObjectSource', 'runQuery']);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`PASS: ${checked} policy decisions - readOnly, wildcards, runClass gating, full activation checking, quoted-identifier SQL, allowFreeSql, allowedTables, allowedTools, customOnly, gate composition and transports.`);
})().catch(error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
