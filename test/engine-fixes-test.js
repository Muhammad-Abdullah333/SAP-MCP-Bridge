'use strict';
// Bridge's own engine fixes beyond the policy: the data preview runs on the stateless
// clone (so SAP's per-session subroutine pools do not pile up), and positive amounts are
// decoded like negative ones. Runs against the bundled engine with every patch overlaid.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = path.join(__dirname, '..');
const vendor = path.join(project, 'build', 'base-payload', 'app', 'vendor', 'node_modules');
if (!fs.existsSync(path.join(vendor, 'abap-adt-mcp', 'dist', 'index.js'))) {
  console.log('SKIP: the vendored MCP server is not present. Run python packaging/fetch-base.py first.');
  return;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-engine-fixes-'));
const nm = path.join(root, 'node_modules');
fs.cpSync(vendor, nm, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'packaging', 'vendor-patch', 'upstream.json'), 'utf8'));
for (const rel of Object.keys(manifest.files))
  fs.copyFileSync(path.join(project, 'packaging', 'vendor-patch', rel), path.join(root, rel));
const dist = path.join(nm, 'abap-adt-mcp', 'dist');

(async () => {
  // ---- decoding: the blank sign position of a positive amount ---------------
  const { normalizeQueryResult } = require(path.join(dist, 'lib', 'queryDecode.js'));
  const sample = { columns: [{ name: 'POS', type: 'P' }, { name: 'NEG', type: 'P' }, { name: 'TXT', type: 'C' }], values: [{ POS: '100000.00 ', NEG: '2000.00-', TXT: 'A ' }] };
  const decoded = normalizeQueryResult(sample, true).values[0];
  assert.equal(decoded.POS, 100000, 'a positive amount decodes to a number');
  assert.equal(decoded.NEG, -2000, 'a negative amount decodes to a negative number');
  assert.equal(decoded.TXT, 'A ', 'character columns are left exactly as SAP sent them');
  const raw = normalizeQueryResult(sample, false).values[0];
  assert.equal(raw.POS, '100000.00', 'raw: the blank sign position is trimmed');
  assert.equal(raw.NEG, '-2000.00', 'raw: the minus moves to the front');

  // ---- which session a data preview uses ------------------------------------
  const { QueryHandlers } = require(path.join(dist, 'handlers', 'QueryHandlers.js'));
  const result = { columns: [{ name: 'X', type: 'P' }], values: [{ X: '1.00 ' }] };
  const fakeClient = name => {
    const calls = [];
    return { name, calls, runQuery: async () => (calls.push('runQuery'), result), tableContents: async () => (calls.push('tableContents'), result) };
  };

  // Getters are defined, not copied: Object.assign would call them while copying.
  const withClone = (client, getter) => Object.defineProperty(client, 'statelessClone', { get: getter });
  const clone = fakeClient('clone');
  const stateful = withClone(fakeClient('stateful'), () => clone);
  const h = new QueryHandlers(stateful);
  await h.handle('runQuery', { sqlQuery: 'SELECT x FROM t000' });
  await h.handle('tableContents', { ddicEntityName: 'T000' });
  assert.deepEqual(clone.calls, ['runQuery', 'tableContents'], 'basic destinations query on the stateless clone');
  assert.deepEqual(stateful.calls, [], 'the stateful session is not used for a query');

  const sso = withClone(fakeClient('sso'), () => {
    throw new Error('Not logged in');
  });
  await new QueryHandlers(sso).handle('runQuery', { sqlQuery: 'SELECT x FROM t000' });
  assert.deepEqual(sso.calls, ['runQuery'], 'without a clone (SSO) the stateful session is used as before');

  const rfcClone = fakeClient('rfc-clone');
  const rfc = withClone(Object.assign(fakeClient('rfc'), { httpClient: { httpclient: { endStatefulSession() {} } } }), () => rfcClone);
  await new QueryHandlers(rfc).handle('runQuery', { sqlQuery: 'SELECT x FROM t000' });
  assert.deepEqual(rfc.calls, ['runQuery'], 'an RFC destination keeps its own connection');
  assert.deepEqual(rfcClone.calls, [], 'the HTTP clone is never used for an RFC destination');

  const selfClone = fakeClient('self');
  withClone(selfClone, () => selfClone);
  await new QueryHandlers(selfClone).handle('runQuery', { sqlQuery: 'SELECT x FROM t000' });
  assert.deepEqual(selfClone.calls, ['runQuery'], 'a client that is its own clone is used directly');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS: positive and negative amounts decode alike, and the data preview runs on the stateless clone except on SSO and RFC destinations.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
