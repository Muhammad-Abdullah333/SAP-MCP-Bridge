'use strict';
// What the real bundled MCP server tells the model when SAP refuses a change. SAP reports
// a client closed for repository changes (TK730, SCC4) with ExceptionResourceNoAccess, the
// same exception it uses for a lock, and the server used to call it a lock: runSnippet on
// a test client came back with "The object is locked ... SM12". Here a stand-in SAP refuses
// the temporary class runSnippet creates, once as a closed client and once as a real lock.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const project = path.join(__dirname, '..');
const vendor = path.join(project, 'build', 'base-payload', 'app', 'vendor', 'node_modules');
const patches = path.join(project, 'packaging', 'vendor-patch');

if (!fs.existsSync(path.join(vendor, 'abap-adt-mcp', 'dist', 'index.js'))) {
  console.log('SKIP: the vendored MCP server is not present (build/ is not in version control).');
  console.log('      Run python packaging/fetch-base.py to fetch it into build/base-payload/, then run this test.');
  return;
}

// The server and abap-adt-api exactly as the installer ships them: every patched file overlaid.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-error-hints-'));
for (const pkg of ['abap-adt-mcp', 'abap-adt-api']) fs.cpSync(path.join(vendor, pkg), path.join(root, 'node_modules', pkg), { recursive: true });
for (const rel of Object.keys(JSON.parse(fs.readFileSync(path.join(patches, 'upstream.json'), 'utf8')).files)) {
  fs.copyFileSync(path.join(patches, rel), path.join(root, rel));
}

const exception = (message, id, no) =>
  '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
  '<namespace id="com.sap.adt"/><type id="ExceptionResourceNoAccess"/>' +
  `<message lang="EN">${message}</message><localizedMessage lang="EN">${message}</localizedMessage>` +
  `<properties><entry key="T100KEY-ID">${id}</entry><entry key="T100KEY-NO">${no}</entry></properties></exc:exception>`;

/** Start a stand-in SAP that refuses class creation with `body`, run runSnippet, return the error text. */
async function runSnippetAgainst(body) {
  const sap = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('x-csrf-token', 'tok');
      if (req.method === 'POST' && /\/sap\/bc\/adt\/oo\/classes(\?|$)/.test(req.url)) {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/xml');
        res.end(body);
        return;
      }
      res.end('');
    });
  });
  await new Promise(r => sap.listen(0, '127.0.0.1', r));
  const destination = { url: 'http://127.0.0.1:' + sap.address().port, authType: 'basic', client: '120', user: 'u', password: 'p', default: true };
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'node_modules', 'abap-adt-mcp', 'dist', 'index.js')], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, NODE_PATH: vendor, SAP_SYSTEMS: JSON.stringify({ T: destination }), MCP_TOOLSETS: 'core,analysis' },
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('the MCP server did not answer in time')); }, 60000);
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'runSnippet', arguments: { destination: 'T', code: "out->write( 'x' )." } } }) + '\n');
          } else if (message.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve([...(message.result?.content || []), ...(message.error ? [{ text: JSON.stringify(message.error) }] : [])].map(c => c.text || '').join(' '));
          }
        }
      });
      child.on('error', reject);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bridge-error-hints-test', version: '1' } } }) + '\n');
    });
  } finally {
    sap.close();
  }
}

const kindOf = text => {
  const m = text.match(/"kind":"([^"]+)"/);
  return m && m[1];
};

(async () => {
  const closed = await runSnippetAgainst(exception('Changes to repository or cross-client customizing are not permitted', 'TK', '730'));
  assert.equal(kindOf(closed), 'repositoryClosed', 'a client closed for changes must not be reported as a lock: ' + closed.slice(0, 300));
  assert.match(closed, /TK730/, 'the hint names the SAP message');
  assert.doesNotMatch(closed, /SM12|"unLock"/, 'no lock advice for a closed client');

  const locked = await runSnippetAgainst(exception('User OTHERUSER is currently editing ZCL_MCP_SNIP_X', 'EU', '510'));
  assert.equal(kindOf(locked), 'locked', 'a real lock must still be reported as a lock: ' + locked.slice(0, 300));
  assert.match(locked, /SM12/, 'a real lock keeps the lock advice');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS: the real bundled server reports a client closed for changes (TK730) as repositoryClosed, not as a lock, and a real lock still as locked.');
})().catch(error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
