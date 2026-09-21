'use strict';
// The manager side of the safety policy: what it accepts, what it refuses, where it says
// the connection stands, and what it admits it cannot enforce. Anything stored here is
// handed to the MCP server, so a field the server would ignore must never be storable.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-'));
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.APPDATA = path.join(root, 'roaming');
process.env.CODEX_HOME = path.join(root, 'codex');
const policies = require('../src/policy');
const { validate } = require('../src/connections');

// ---- one entry per line, with commas still accepted -------------------------
assert.deepEqual(policies.parseList('Z*\nY*'), ['Z*', 'Y*']);
assert.deepEqual(policies.parseList('Z*\r\nY*\r\n'), ['Z*', 'Y*']);
assert.deepEqual(policies.parseList('Z*, Y*'), ['Z*', 'Y*'], 'older comma-separated policies must survive');
assert.deepEqual(policies.parseList('Z*\n\n  Y*  \n'), ['Z*', 'Y*'], 'blank lines and padding are ignored');
assert.deepEqual(policies.parseList('Z*\nz*'), ['Z*'], 'duplicates differing only in case collapse');
assert.deepEqual(policies.parseList(['Z*', 'Y*']), ['Z*', 'Y*']);
assert.deepEqual(policies.parseList(''), []);
// Semicolons and commas separate entries, so a separator can never sit inside one.
assert.deepEqual(policies.parseList('Z*; DROP'), ['Z*', 'DROP']);
assert.deepEqual(policies.normalise({ deniedTools: 'toolset:git; transportRelease' }).deniedTools, ['toolset:git', 'transportRelease']);

// ---- three levels, about what may be changed --------------------------------
assert.deepEqual(
  policies.LEVELS.map(l => [l.readOnly, l.customOnly]),
  [[true, false], [false, true], [false, false]],
  'levels must run read-only, custom writable, standard writable',
);
for (const level of [0, 1, 2]) {
  assert.equal(policies.levelOf(policies.normalise({ level })), level, 'level ' + level + ' must round-trip');
}
assert.equal(policies.normalise({ level: 0 }).readOnly, true);
assert.equal(policies.normalise({ level: 1 }).customOnly, true);
assert.equal(policies.normalise({ level: 1 }).readOnly, false);
assert.equal(policies.normalise({ level: 2 }).customOnly, false);
assert.throws(() => policies.normalise({ level: 3 }), /between 0 and 2/);

// ---- free SQL is separate from the change level -----------------------------
assert.equal(policies.normalise({ level: 0, allowFreeSql: false }).allowFreeSql, false);
assert.equal(policies.normalise({ level: 0, allowFreeSql: true }).allowFreeSql, true);
assert.equal(policies.levelOf(policies.normalise({ level: 0, allowFreeSql: true })), 0, 'the reading choice must not change the level');

// ---- reading is its own question, with its own choices ----------------------
assert.deepEqual(policies.READ_LEVELS.map(l => l.allowFreeSql), [false, true], 'the safer reading choice comes first');
assert.equal(policies.normalise({ readLevel: 0 }).allowFreeSql, false);
assert.equal(policies.normalise({ readLevel: 1 }).allowFreeSql, true);
assert.throws(() => policies.normalise({ readLevel: 2 }), /may read/);
// The choice round-trips through describe, so the form can select it again.
for (const readLevel of [0, 1]) {
  assert.equal(policies.describe(policies.normalise({ readLevel })).readLevel, readLevel);
}
assert.equal(policies.describe(policies.normalise({ level: 0 })).readLevels.length, 2);
// Reading never changes what may be changed.
assert.equal(policies.levelOf(policies.normalise({ level: 1, readLevel: 1 })), 1);

// ---- a list of nothing but * restricts nothing ------------------------------
assert.equal(policies.isOpenList([]), true);
assert.equal(policies.isOpenList(['*']), true);
assert.equal(policies.isOpenList(['ZA', '*']), true, 'one open entry opens the whole list');
assert.equal(policies.isOpenList(['Z*']), false);
assert.equal(policies.restrictsToCustom(['Z*', 'Y*', '$TMP', '/ACME/APP']), true);
assert.equal(policies.restrictsToCustom(['Z*', 'SAPBASIS']), false, 'one standard package opens it up');
assert.equal(policies.restrictsToCustom(['*']), false);
assert.equal(policies.restrictsToCustom([]), false);

// ---- the level is read from the whole policy, not just the choice -----------
// An allowed-packages list of Z* confines changes to the customer namespace whatever the
// choice was left at, so the reading has to come down to the middle level.
const viaPackages = policies.normalise({ level: 2, allowedPackages: 'Z*\nY*' });
assert.equal(policies.levelOf(viaPackages), 1, 'Z* must pull the level down to custom writable');
// A * entry restricts nothing, so it must not pull the level down.
assert.equal(policies.levelOf(policies.normalise({ level: 2, allowedPackages: '*' })), 2, '* must not look like a restriction');
assert.equal(policies.levelOf(policies.normalise({ level: 2, allowedPackages: 'Z*\nSAPBASIS' })), 2, 'a standard package keeps it at the top level');
// Read-only wins over everything.
assert.equal(policies.levelOf(policies.normalise({ level: 0, allowedPackages: '*' })), 0);

// ---- the score is derived from the whole policy, not the level alone --------
const scoreOf = p => policies.riskOf(policies.normalise(p));
const tight = { allowedTables: 'ZDATA*', allowedTools: 'toolset:source', allowedTransports: 'DEVK9*' };
// Both ends of the scale are reachable, so the reading has somewhere to travel.
assert.equal(scoreOf({ level: 0, allowFreeSql: false, ...tight }), 0, 'the safest policy must reach zero');
assert.equal(scoreOf({ level: 2, allowFreeSql: true }), policies.RISK_MAX, 'the most open policy must reach the top');
// Every dimension moves the score on its own.
const anchored = { level: 1, allowFreeSql: false, ...tight };
assert.equal(scoreOf(anchored), 4, 'the level anchor alone');
assert.equal(scoreOf({ ...anchored, allowFreeSql: true }), 6, 'letting it write its own SQL adds two');
assert.equal(scoreOf({ ...anchored, allowedTables: '' }), 5, 'dropping the table list adds one');
assert.equal(scoreOf({ ...anchored, allowedTools: '' }), 5, 'dropping the tool list adds one');
assert.equal(scoreOf({ ...anchored, allowedTransports: '' }), 5, 'dropping the transport list adds one');
// A deny list counts as narrowing, even with no allow list beside it.
assert.equal(scoreOf({ ...anchored, allowedTables: '', deniedTables: 'USR02' }), 4, 'a deny list narrows table access too');
// A list of only * narrows nothing, so it must score the same as no list at all.
assert.equal(scoreOf({ ...anchored, allowedTables: '*' }), scoreOf({ ...anchored, allowedTables: '' }), '* must not look like a restriction');
// Levels stay strictly ordered when nothing else differs.
assert.ok(scoreOf({ level: 0, allowFreeSql: false }) < scoreOf({ level: 1, allowFreeSql: false }));
assert.ok(scoreOf({ level: 1, allowFreeSql: false }) < scoreOf({ level: 2, allowFreeSql: false }));
assert.deepEqual(policies.RISKS.map(r => r.tone), ['safe', 'caution', 'danger'], 'three ratings: green, yellow, dark red');
assert.deepEqual(policies.RISKS.map(r => r.name), ['Low', 'Medium', 'High']);
// The chosen level is a floor. A connection that may change standard objects must never
// report less than High just because its lists happen to be narrow.
const ratingFor = p => policies.describe(policies.normalise(p)).rating;
assert.equal(ratingFor({ level: 2, readLevel: 0, ...tight }), 'High', 'the top level is always High');
assert.equal(ratingFor({ level: 1, readLevel: 0, ...tight }), 'Medium', 'the middle level is at least Medium');
assert.equal(ratingFor({ level: 0, readLevel: 0, ...tight }), 'Low');
// Opening things up raises it above the floor.
assert.equal(ratingFor({ level: 0, readLevel: 1 }), 'Medium', 'an open policy rises above its floor');
assert.equal(ratingFor({ level: 1, readLevel: 1 }), 'High');
// Every level has a rating at or above its own index, always.
for (const level of [0, 1, 2]) {
  for (const readLevel of [0, 1]) {
    const shown = policies.describe(policies.normalise({ level, readLevel }));
    assert.ok(policies.RISKS.findIndex(r => r.name === shown.rating) >= level, 'level ' + level + ' must never read below its floor');
  }
}
// riskParts itemises where the score came from, and the parts must sum to it.
const parts = policies.riskParts(policies.normalise({ level: 2, allowFreeSql: true }));
assert.equal(parts.reduce((total, part) => total + part.points, 0), policies.RISK_MAX);
assert.deepEqual(parts.map(p => p.key), ['scope', 'sql', 'tables', 'tools', 'transports']);

// ---- describe() is what the form shows --------------------------------------
const safest = policies.describe(policies.normalise({ level: 0, allowFreeSql: false, ...tight }));
assert.equal(safest.level, 0);
assert.equal(safest.tone, 'safe');
assert.equal(safest.rating, 'Low');
assert.equal(safest.risk, 0);
assert.equal(safest.max, policies.RISK_MAX);
assert.deepEqual(policies.RISK_WEIGHTS.scope, [0, 4, 8], 'the three levels anchor the scale');
assert.equal(safest.anchors, undefined, 'the slider is gone, and so is the scale it needed');
assert.match(safest.name, /Read only/);
assert.deepEqual(safest.notes, [], 'the safest setting needs no explanation');

const riskiest = policies.describe(policies.normalise({ level: 2, allowFreeSql: true }));
assert.equal(riskiest.tone, 'danger');
assert.equal(riskiest.rating, 'High');
assert.match(riskiest.name, /Standard and custom can both be changed/);

// When the level is pulled down by a list, the form has to say why.
const pulled = policies.describe(policies.normalise({ level: 2, allowedPackages: 'Z*', allowFreeSql: false }));
assert.equal(pulled.level, 1);
assert.ok(pulled.notes.some(n => /Allowed packages already confines/.test(n)), 'it must explain why the choice moved');
// Nothing user-facing may still talk about a slider or about "ad-hoc SQL".
for (const text of [...pulled.notes, ...policies.describe(policies.normalise({ level: 2 })).notes, ...policies.warnings(policies.normalise({ level: 1, deniedTables: 'USR02' }))]) {
  assert.doesNotMatch(text, /slider/i, 'the slider is gone from the form: ' + text);
  assert.doesNotMatch(text, /ad-hoc/i, 'the engine\'s name for free SQL must not reach the user: ' + text);
}

// A list of only * has to be called out, because it looks configured and is not.
const open = policies.describe(policies.normalise({ level: 1, allowedTables: '*', allowFreeSql: false }));
assert.ok(open.notes.some(n => /Allowed tables contains only \*/.test(n)));
const realList = policies.describe(policies.normalise({ level: 1, allowedTables: 'ZDATA*', allowFreeSql: false }));
assert.ok(!realList.notes.some(n => /contains only \*/.test(n)));

// Ad-hoc SQL is explained wherever it is on, since it is what raises the rating.
assert.ok(policies.describe(policies.normalise({ level: 0, allowFreeSql: true })).notes.some(n => /Adding to the rating beyond the level/.test(n)));

// ---- patterns are checked, so nothing unusable reaches the server -----------
assert.deepEqual(policies.normalise({ allowedPackages: 'Z*\nY*\n$TMP\n/ACME/APP' }).allowedPackages, ['Z*', 'Y*', '$TMP', '/ACME/APP']);
assert.deepEqual(policies.normalise({ allowedTools: 'toolset:data\nget*' }).allowedTools, ['toolset:data', 'get*']);
for (const [field, bad, expected] of [
  ['allowedPackages', 'Z%PKG', /not a valid name/],
  ['deniedTables', 'USR02 OR 1=1', /not a valid name/],
  ['allowedTools', 'runQuery()', /not a tool name/],
  ['deniedTools', 'toolset:git|rm', /not a tool name/],
  ['allowedTransports', 'DEVK9*\n<script>', /not a valid name/],
]) {
  assert.throws(() => policies.normalise({ [field]: bad }), expected, field + ' must refuse: ' + bad);
}
assert.throws(() => policies.normalise({ allowedPackages: 'Z'.repeat(100) }), /too long/);
assert.throws(() => policies.normalise({ deniedTables: Array.from({ length: 201 }, (_, i) => 'T' + i) }), /200 entries/);

// ---- every list field survives a round trip ---------------------------------
const full = policies.normalise({
  level: 1,
  allowFreeSql: false,
  allowedPackages: 'Z*',
  allowedTables: 'ZDATA*',
  allowedTools: 'toolset:source',
  allowedTransports: 'DEVK9*',
  deniedTables: 'USR02',
  deniedTools: 'transportRelease',
});
for (const field of policies.LIST_FIELDS) assert.ok(Array.isArray(full[field]), field + ' must be an array');
assert.equal(full.customOnly, true);
assert.equal(full.readOnly, false);
assert.equal(full.allowFreeSql, false);

// ---- warnings name the real gaps, and never claim more than is enforced -----
const wideOpen = policies.warnings(policies.normalise({ level: 2 }));
assert.ok(wideOpen.some(w => /No safety policy is set/.test(w)), 'an unrestricted connection must say so plainly');

const scoped = policies.warnings(policies.normalise({ level: 1 }));
assert.ok(scoped.some(w => /apply to changes, not to reading/.test(w)), 'package scope must not be mistaken for a read restriction');
assert.ok(!scoped.some(w => /No safety policy is set/.test(w)));

const denied = policies.warnings(policies.normalise({ level: 2, deniedTables: 'USR02', allowFreeSql: true }));
assert.ok(denied.some(w => /built at runtime inside ABAP source/.test(w)), 'the SQL-text limitation must be stated');
const noSql = policies.warnings(policies.normalise({ level: 2, deniedTables: 'USR02', allowFreeSql: false }));
assert.ok(!noSql.some(w => /built at runtime inside ABAP source/.test(w)), 'that warning must disappear once ad-hoc SQL is off');

const both = policies.warnings(policies.normalise({ level: 1, allowedPackages: 'Z*' }));
assert.ok(both.some(w => /satisfy both/.test(w)), 'composed package gates must be explained');

// ---- the namespace limit says what it does not cover, until that is closed ----
// A small stand-in catalogue keeps this hermetic; the runtime test checks the same
// matching against the real engine and the real tool list.
const catalogue = {
  tools: [
    { name: 'transportRelease', toolset: 'transports', writes: true },
    { name: 'transportInfo', toolset: 'transports', writes: false },
    { name: 'debuggerSetVariableValue', toolset: 'debugger', writes: true },
    { name: 'pushRepo', toolset: 'git', writes: true },
    { name: 'atcRequestExemption', toolset: 'atc', writes: true },
    { name: 'getObjectSource', toolset: 'source', writes: false },
  ],
};
const gap = p => policies.warnings(policies.normalise(p), catalogue).find(w => /does not cover/.test(w));
// Code the AI runs is its own group, named tool by tool because it shares toolsets with
// tools that are needed. CODE closes it completely.
const CODE = 'runSnippet\nrunClass\nunitTestRun';
assert.match(gap({ level: 1 }), /transport control, the debugger, abapGit, ATC exemptions or running ABAP it writes/, 'the middle level must name all five gaps');
assert.match(gap({ level: 1 }), /Add toolset:transports, toolset:debugger, toolset:git, toolset:atc, runSnippet, runClass, unitTestRun to Denied tools/);
assert.equal(gap({ level: 0 }), undefined, 'read only has no such gap');
assert.equal(gap({ level: 2 }), undefined, 'the top level promises nothing about namespaces');
// Exactly what the form adds when the middle level is chosen: unit tests are left
// available on purpose, so they must still be named, and nothing already closed is.
assert.match(
  gap({ level: 1, deniedTools: 'toolset:debugger\ntoolset:git\nrunSnippet\nrunClass' }),
  /does not cover transport control, ATC exemptions or running ABAP it writes, which stay available whatever namespace they touch\. Add toolset:transports, toolset:atc, unitTestRun to Denied tools to close them\./,
);
// A toolset pattern reaches named tools too: analysis holds runSnippet and runClass.
assert.match(gap({ level: 1, deniedTools: 'toolset:analysis' }), /Add toolset:transports, toolset:debugger, toolset:git, toolset:atc, unitTestRun to/);
// Closing a group removes it from the sentence; closing all five removes the sentence.
assert.match(gap({ level: 1, deniedTools: 'toolset:transports\ntoolset:debugger\n' + CODE }), /does not cover abapGit or ATC exemptions, which stay/);
assert.match(gap({ level: 1, deniedTools: 'toolset:transports\ntoolset:debugger\ntoolset:git\n' + CODE }), /does not cover ATC exemptions, which stays available whatever namespace it touches\. Add toolset:atc to Denied tools to close it\./);
assert.equal(gap({ level: 1, deniedTools: 'toolset:transports\ntoolset:debugger\ntoolset:git\ntoolset:atc\n' + CODE }), undefined, 'a closed gap must stop being reported');
// A tool-name pattern counts too, and a read tool left open does not keep a group open.
assert.doesNotMatch(gap({ level: 1, deniedTools: 'transport*' }), /transport control/);
// An allowed list that leaves them out closes them as well.
assert.equal(gap({ level: 1, allowedTools: 'toolset:source' }), undefined, 'an allowed list without these groups closes them');
assert.match(gap({ level: 1, allowedTools: 'toolset:source\npushRepo' }), /does not cover abapGit,/, 'only what the allowed list lets through is named');
// Without a catalogue only a whole-toolset denial counts, so it over-warns rather than under-warns.
const blind = p => policies.warnings(policies.normalise(p), { tools: [] }).find(w => /does not cover/.test(w));
assert.match(blind({ level: 1, deniedTools: 'transport*' }), /transport control/, 'unknown tool names must not be assumed closed');
assert.doesNotMatch(blind({ level: 1, deniedTools: 'toolset:transports' }), /transport control/);

// Warnings speak only when they have something to say. A locked-down connection has
// nothing wrong with it, so the box stays empty rather than showing standing boilerplate.
assert.deepEqual(policies.warnings(policies.normalise({ level: 0, readLevel: 0, ...tight })), [], 'the safest policy warns about nothing');
assert.ok(policies.warnings(policies.normalise({ level: 2, readLevel: 1 })).length > 0, 'an open one still does');

// ---- the connection form applies all of it ----------------------------------
const base = { id: 'POLICY', url: 'https://sap.example.invalid', client: '100', user: 'tester' };
const fresh = validate({ ...base });
assert.equal(fresh.policy.readOnly, true, 'a new connection must still default to read-only');
assert.equal(fresh.policy.allowFreeSql, false, 'and to no ad-hoc SQL');
assert.equal(policies.describe(fresh.policy).tone, 'safe', 'a new connection must read as low risk');

const configured = validate({ ...base, policy: { level: 1, allowedPackages: 'Z*\nY*', allowFreeSql: false } });
assert.equal(configured.policy.customOnly, true);
assert.deepEqual(configured.policy.allowedPackages, ['Z*', 'Y*']);
assert.throws(() => validate({ ...base, policy: { allowedPackages: 'Z*\nbad name' } }), /not a valid name/, 'the form must refuse an unusable pattern');

// An existing policy is preserved when the caller sends none.
const kept = validate({ ...base }, { ...base, policy: { readOnly: false, customOnly: true, allowedPackages: ['ZFIN*'] } });
assert.equal(kept.policy.customOnly, true);
assert.deepEqual(kept.policy.allowedPackages, ['ZFIN*']);
assert.equal(kept.policy.readOnly, false);
assert.equal(policies.levelOf(kept.policy), 1);

// A legacy policy carried in baseConfig is still honoured and normalised.
const legacy = validate({ ...base }, { ...base, baseConfig: { policy: { readOnly: true, allowedPackages: 'Z*,Y*' } } });
assert.equal(legacy.policy.readOnly, true);
assert.deepEqual(legacy.policy.allowedPackages, ['Z*', 'Y*'], 'a comma-separated legacy list must convert cleanly');
assert.equal(policies.levelOf(legacy.policy), 0);

fs.rmSync(root, { recursive: true, force: true });
console.log('PASS: line-based lists with legacy commas, three change levels, reading asked as its own question, open-list detection, level derived from the whole policy, risk tones, describe() wording, pattern refusal, honest warnings and preservation of existing and legacy policies.');
