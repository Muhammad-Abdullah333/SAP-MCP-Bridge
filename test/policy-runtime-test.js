'use strict';
// End-to-end proof that the safety policy is enforced by the real bundled MCP server,
// not merely stored by the manager. The server is started with the patched policy engine
// and a destination pointing at an unreachable host, then driven over stdio like a client.
//
// The tell is where a call stops. A policy denial is returned before any SAP contact and
// names its gate ("Policy: <tool> blocked on destination T (<gate>)"). A call the policy
// permits gets past that point and fails trying to reach SAP instead. So "blocked by
// policy" and "allowed through" are distinguishable without a live SAP system.
//
// Gates that need the package of an existing object have to ask SAP to resolve it, so the
// cases here use tools that carry the package in their own arguments. The full decision
// matrix, including resolved packages, is in test/policy-engine-test.js.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const project = path.join(__dirname, '..');
const vendor = path.join(project, 'build', 'base-payload', 'app', 'vendor', 'node_modules');
const patch = path.join(project, 'packaging', 'vendor-patch', 'node_modules', 'abap-adt-mcp', 'dist', 'lib', 'policy.js');

if (!fs.existsSync(path.join(vendor, 'abap-adt-mcp', 'dist', 'index.js'))) {
  console.log('SKIP: the vendored MCP server is not present (build/ is not in version control).');
  console.log('      Unpack the pinned base package into build/base-payload/ to run this test.');
  return;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-runtime-'));
const server = path.join(root, 'node_modules', 'abap-adt-mcp');
fs.mkdirSync(path.dirname(server), { recursive: true });
fs.cpSync(path.join(vendor, 'abap-adt-mcp'), server, { recursive: true });
// Overlay exactly what the installer ships, so this tests the patched engine.
fs.copyFileSync(patch, path.join(server, 'dist', 'lib', 'policy.js'));

/** Run one server session with `policy` and return the result of each call, in order. */
function session(policy, calls) {
  return new Promise((resolve, reject) => {
    const destination = { url: 'https://unreachable.invalid', client: '100', user: 'u', password: 'p', default: true, policy };
    const child = spawn(process.execPath, [path.join(server, 'dist', 'index.js')], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NODE_PATH: vendor, SAP_SYSTEMS: JSON.stringify({ T: destination }), MCP_TOOLSETS: 'core,source,data,objects,runtime,analysis' },
    });
    const results = new Map();
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the MCP server did not answer in time')); }, 90000);
    const done = () => {
      clearTimeout(timer);
      child.kill();
      resolve(calls.map((_, i) => results.get(i + 2) ?? ''));
    };
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          calls.forEach((call, i) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: call.tool, arguments: { destination: 'T', ...call.args } } }) + '\n'));
        } else if (message.id >= 2) {
          results.set(message.id, [...(message.result?.content || []), ...(message.error ? [{ text: JSON.stringify(message.error) }] : [])].map(c => c.text || '').join(' '));
          if (results.size === calls.length) done();
        }
      }
    });
    child.on('error', reject);
    child.on('exit', () => { if (results.size < calls.length) { clearTimeout(timer); reject(new Error('the MCP server exited early')); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bridge-policy-runtime-test', version: '1' } } }) + '\n');
  });
}

const blockedBy = (text, gate) => /Policy:/.test(text) && new RegExp('\\(' + gate + '\\)').test(text);
const blockedAtAll = text => /Policy:/.test(text);

let checks = 0;
let agreements = 0;
function assertBlocked(text, gate, name) {
  assert.ok(blockedBy(text, gate), `${name}: expected a ${gate} denial, got: ${text.slice(0, 180)}`);
  checks += 1;
}
function assertAllowed(text, name) {
  // It must fail — there is no SAP here — but not at the policy gate.
  assert.ok(!blockedAtAll(text), `${name}: the policy blocked a call it should permit: ${text.slice(0, 180)}`);
  checks += 1;
}

(async () => {
  // A read-only destination refuses writes and still permits reads.
  {
    const [write, read, runClass] = await session({ readOnly: true }, [
      { tool: 'setObjectSource', args: { objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_x', source: 'x' } },
      { tool: 'getObjectSource', args: { objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_x' } },
      { tool: 'runClass', args: { className: 'CL_ANY' } },
    ]);
    assertBlocked(write, 'readOnly', 'readOnly must block a source write');
    assertAllowed(read, 'readOnly must still permit a read');
    assertBlocked(runClass, 'readOnly', 'readOnly must block running a class');
  }

  // Only custom objects may be changed. createObject carries its package in its arguments.
  {
    const [std, custom, local] = await session({ customOnly: true }, [
      { tool: 'createObject', args: { objtype: 'CLAS/OC', name: 'ZCL_NEW', parentName: 'SAPBASIS', description: 'x' } },
      { tool: 'createObject', args: { objtype: 'CLAS/OC', name: 'ZCL_NEW', parentName: 'ZDEMO', description: 'x' } },
      { tool: 'createObject', args: { objtype: 'CLAS/OC', name: 'ZCL_NEW', parentName: '$TMP', description: 'x' } },
    ]);
    assertBlocked(std, 'customOnly', 'customOnly must block creating in a standard package');
    assertAllowed(custom, 'customOnly must permit a Z package');
    assertAllowed(local, 'customOnly must permit $TMP');
  }

  // An allowed-packages list, closed, using the package in the arguments.
  {
    const [outside, inside] = await session({ allowedPackages: ['ZFIN*'] }, [
      { tool: 'createObject', args: { objtype: 'CLAS/OC', name: 'ZCL_NEW', parentName: 'ZHR', description: 'x' } },
      { tool: 'createObject', args: { objtype: 'CLAS/OC', name: 'ZCL_NEW', parentName: 'ZFIN_CORE', description: 'x' } },
    ]);
    assertBlocked(outside, 'allowedPackages', 'allowedPackages must block a package outside the list');
    assertAllowed(inside, 'allowedPackages must permit a package in the list');
  }

  // Tool allow and deny lists.
  {
    const [denied, allowed] = await session({ allowedTools: ['getObjectSource'] }, [
      { tool: 'runQuery', args: { sqlQuery: 'SELECT * FROM ZMINE' } },
      { tool: 'getObjectSource', args: { objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_x' } },
    ]);
    assertBlocked(denied, 'allowedTools', 'allowedTools must block a tool off the list');
    assertAllowed(allowed, 'allowedTools must permit a tool on the list');
  }
  {
    const [denied] = await session({ deniedTools: ['toolset:data'] }, [{ tool: 'runQuery', args: { sqlQuery: 'SELECT * FROM ZMINE' } }]);
    assertBlocked(denied, 'deniedTools', 'deniedTools must block a whole toolset');
  }

  // Table gates, including the quoted identifier that used to slip through.
  {
    const [plain, quoted, other] = await session({ deniedTables: ['USR02'] }, [
      { tool: 'runQuery', args: { sqlQuery: 'SELECT * FROM USR02' } },
      { tool: 'runQuery', args: { sqlQuery: 'SELECT * FROM "USR02"' } },
      { tool: 'runQuery', args: { sqlQuery: 'SELECT * FROM ZMINE' } },
    ]);
    assertBlocked(plain, 'deniedTables', 'deniedTables must block a plain identifier');
    assertBlocked(quoted, 'deniedTables', 'deniedTables must block a quoted identifier');
    assertAllowed(other, 'deniedTables must leave an unrelated table alone');
  }
  {
    const [unlisted, listed] = await session({ allowedTables: ['ZMINE*'] }, [
      { tool: 'tableContents', args: { ddicEntityName: 'USR02' } },
      { tool: 'tableContents', args: { ddicEntityName: 'ZMINE_DATA' } },
    ]);
    assertBlocked(unlisted, 'allowedTables', 'allowedTables must block an unlisted table');
    assertAllowed(listed, 'allowedTables must permit a listed table');
  }
  {
    const [freeSql, named] = await session({ allowFreeSql: false }, [
      { tool: 'runQuery', args: { sqlQuery: 'SELECT * FROM "USR02"' } },
      { tool: 'tableContents', args: { ddicEntityName: 'ZMINE' } },
    ]);
    assertBlocked(freeSql, 'allowFreeSql', 'ad-hoc SQL must be refused when it is turned off');
    assertAllowed(named, 'a named table read must still be permitted');
  }

  // A write whose target is missing must not slip past the package gate. This is the one
  // that matters most through a real client: the gate used to be skipped entirely when
  // the object argument was absent, so the server answered "allowed" while the manager
  // was telling the user that standard objects were protected.
  // There is no SAP in this harness, so the package of an existing object can never be
  // looked up; only the no-target case can be decided here. The engine test covers the
  // custom and standard outcomes with a stand-in for SAP.
  {
    const [noTarget, noUrl] = await session({ customOnly: true }, [
      { tool: 'setObjectSource', args: { source: 'x' } },
      { tool: 'deleteObject', args: {} },
    ]);
    assertBlocked(noTarget, 'customOnly', 'a source write with no target must be refused, not waved through');
    assertBlocked(noUrl, 'customOnly', 'a delete with no target must be refused, not waved through');
  }

  // The manager's warning about groups the namespace limit does not cover is decided by
  // its own copy of the tool-list matching. If that copy ever disagreed with the engine,
  // the form could report a group as closed while the server still let it through. So
  // every tool in those groups is put to the real engine under a spread of tool lists.
  {
    const { evaluatePolicy } = require(path.join(server, 'dist', 'lib', 'policy.js'));
    const policies = require('../src/policy');
    const { catalogue } = require('../src/tool-catalogue');
    const groups = new Set(policies.UNGATED_GROUPS.filter(g => g.toolset).map(g => g.toolset));
    const named = policies.UNGATED_GROUPS.flatMap(g => g.tools || []);
    // The named code-running tools carry their toolset in the manager, so toolset: patterns
    // can reach them without a catalogue. That copy must match the real server.
    for (const tool of named) {
      const real = catalogue().tools.find(t => t.name === tool.name);
      assert.ok(real, tool.name + ' must exist in the real server');
      assert.equal(real.toolset, tool.toolset, tool.name + ' belongs to toolset ' + real.toolset);
    }
    const members = catalogue().tools.filter(t => groups.has(t.toolset) || named.some(n => n.name === t.name));
    assert.ok(members.length >= 23, 'the real catalogue must supply the ungated groups, found ' + members.length);
    const lists = [
      {},
      { deniedTools: ['toolset:transports'] },
      { deniedTools: ['transport*', 'debugger?et*'] },
      { deniedTools: ['toolset:de*', 'pushRepo'] },
      { allowedTools: ['toolset:source'] },
      { allowedTools: ['toolset:git', 'transportInfo'] },
      { allowedTools: ['*'], deniedTools: ['atc*'] },
      { deniedTools: ['toolset:debugger', 'toolset:git', 'runSnippet', 'runClass'] },
      { deniedTools: ['toolset:analysis'] },
      { allowedTools: ['toolset:tests', 'run*'] },
    ];
    const ctx = { resolvePackage: async () => 'ZCUSTOM' };
    for (const list of lists) {
      for (const tool of members) {
        const engine = (await evaluatePolicy(list, tool.name, {}, ctx)).allowed;
        assert.equal(policies.toolPermitted(list, tool.name, tool.toolset), engine, `${tool.name} under ${JSON.stringify(list)}: manager says ${!engine}, engine says ${engine}`);
        agreements += 1;
      }
    }
  }

  // No policy at all: nothing is blocked, which is what the manager warns about.
  {
    const [write] = await session(undefined, [{ tool: 'setObjectSource', args: { objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_x', source: 'x' } }]);
    assertAllowed(write, 'a destination with no policy must not be blocked by one');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`PASS: ${checks} decisions enforced by the real bundled MCP server - readOnly, customOnly, allowedPackages, allowedTools, deniedTools, deniedTables including quoted identifiers, allowedTables, allowFreeSql and writes with no target. The manager agreed with the real engine on ${agreements} tool-list decisions behind its namespace warning.`);
})().catch(error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
