'use strict';
// Regression test for the transportRelease "release anyway" re-posts in the patched
// abap-adt-api that Bridge overlays onto the bundled MCP server.
//
// Upstream POSTed relwithignlock and relObjigchkatc without a body, and SAP answered
// 400 "System expected the element '{http://www.sap.com/cts/adt/tm}root'", so a Transport
// of Copies whose objects stay locked in the original request could not be released.
// SAP's handler (CL_CTS_ADT_TM_REST_RES_CONT->POST) deserialises those two actions with
// ST_CTS_ADT_TM_MAIN and takes the request number from the body, not from the URL.
//
// Hermetic like policy-engine-test.js: the vendored tree lives under build/ and is not in
// version control, so the module's two sibling imports are stubbed and SAP is a recorder.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = path.join(__dirname, '..');
const REL = 'node_modules/abap-adt-api/build/api/transports.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-transport-release-'));
const api = path.join(root, 'build', 'api');
fs.mkdirSync(api, { recursive: true });
fs.writeFileSync(
  path.join(root, 'build', 'AdtException.js'),
  "'use strict';\nexports.adtException = m => { throw new Error(m); };\n",
);
fs.writeFileSync(
  path.join(root, 'build', 'utilities.js'),
  "'use strict';\nexports.fullParse = () => ({});\nexports.xmlArray = () => [];\nexports.xmlNodeAttr = n => n;\nexports.xmlNode = () => ({});\n",
);
fs.copyFileSync(path.join(project, 'packaging', 'vendor-patch', REL), path.join(api, 'transports.js'));
const { transportRelease } = require(path.join(api, 'transports.js'));

// The build only overlays files recorded in upstream.json.
const upstream = JSON.parse(fs.readFileSync(path.join(project, 'packaging', 'vendor-patch', 'upstream.json'), 'utf8'));
assert.match(upstream.files[REL]?.upstreamSha256 || '', /^[0-9a-f]{64}$/, 'transports.js patch is not registered in upstream.json');

async function release(...args) {
  const calls = [];
  const h = { request: async (url, options) => (calls.push({ url, options }), { body: '' }) };
  await transportRelease(h, ...args);
  assert.equal(calls.length, 1);
  return calls[0];
}

const TM_TYPE = 'application/vnd.sap.adt.transportorganizer.v1+xml';
const TM_ROOT = '<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"';

(async () => {
  // Plain release: SAP does not read a body for newreleasejobs, so none is sent.
  let c = await release('DEVK900123');
  assert.equal(c.url, '/sap/bc/adt/cts/transportrequests/DEVK900123/newreleasejobs');
  assert.equal(c.options.method, 'POST');
  assert.equal(c.options.body, undefined);

  // The reported failure: ignoreLocks on a TOC whose objects are locked elsewhere.
  // The number goes into the body upper-cased, because SAP takes it from there as is.
  c = await release('devk900123', true);
  assert.equal(c.url, '/sap/bc/adt/cts/transportrequests/devk900123/relwithignlock');
  assert.equal(c.options.headers['Content-Type'], TM_TYPE);
  assert.ok(c.options.body.includes(TM_ROOT), 'relwithignlock body is not a tm:root document');
  assert.ok(c.options.body.includes('tm:useraction="relwithignlock"'));
  assert.ok(c.options.body.includes('tm:number="DEVK900123"'));
  assert.ok(!c.options.body.includes('releaseobjlock'));

  // Ignoring ATC needs a body too; SAP only ignores locks there when releaseobjlock="yes".
  c = await release('DEVK900124', false, true);
  assert.equal(c.url, '/sap/bc/adt/cts/transportrequests/DEVK900124/relObjigchkatc');
  assert.equal(c.options.headers['Content-Type'], TM_TYPE);
  assert.ok(c.options.body.includes('tm:useraction="relObjigchkatc"'));
  assert.ok(c.options.body.includes('tm:number="DEVK900124"'));
  assert.ok(!c.options.body.includes('releaseobjlock'));

  c = await release('DEVK900124', true, true);
  assert.equal(c.url, '/sap/bc/adt/cts/transportrequests/DEVK900124/relObjigchkatc');
  assert.ok(c.options.body.includes('tm:releaseobjlock="yes"'));

  await assert.rejects(release('NOTATR'), /Invalid transport number/);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS: transportRelease sends no body on a plain release and a tm:root body with the upper-cased number on relwithignlock and relObjigchkatc, with releaseobjlock only when locks are ignored too.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
