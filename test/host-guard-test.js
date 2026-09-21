'use strict';
// Integration guard: the manager serves the API token inside index.html, so a page that
// reaches this port after a DNS rebind must not be able to read it. Runs the real manager.
const assert = require('assert/strict'),
  fs = require('fs'),
  http = require('http'),
  os = require('os'),
  path = require('path');
const { spawn } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-host-guard-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  LOCALAPPDATA: root,
  APPDATA: path.join(root, 'roaming'),
  CODEX_HOME: path.join(root, 'codex'),
  USERPROFILE: home,
  HOME: home,
  SAP_MCP_BRIDGE_LEGACY_HOME: home,
  SAP_MCP_BRIDGE_NO_BROWSER: '1',
};
delete env.OneDrive; // keep vault discovery away from the real user's locations
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'manager.js')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '',
  err = '';
child.stdout.on('data', chunk => (out += chunk));
child.stderr.on('data', chunk => (err += chunk));
function get(port, route, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, headers }, response => {
      let body = '';
      response.on('data', chunk => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}
(async () => {
  const deadline = Date.now() + 30000;
  let found;
  while (Date.now() < deadline) {
    found = out.match(/http:[/][/]127[.]0[.]0[.]1:([0-9]+)[/]/);
    if (found) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!found) throw new Error('Manager did not start. stderr: ' + err);
  const port = Number(found[1]);

  // A genuine loopback request still works and still receives the session token.
  const ok = await get(port, '/', { Host: '127.0.0.1:' + port });
  assert.equal(ok.status, 200);
  const token = (ok.body.match(/bridge-token" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(token && token.length >= 32, 'index.html must still deliver the session token');
  assert.equal((await get(port, '/', { Host: 'localhost:' + port })).status, 200, 'localhost authority must work');
  assert.equal((await get(port, '/api/state', { Host: '127.0.0.1:' + port, 'x-bridge-token': token })).status, 200);

  // Security headers reach both static and JSON responses.
  assert.match(ok.headers['content-security-policy'] || '', /default-src 'none'/);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');

  // A rebound page presents its own Host: refuse before routing, and never leak the token.
  for (const host of ['evil.example.com', 'evil.example.com:' + port, '127.0.0.1:1', 'attacker.test']) {
    const blocked = await get(port, '/', { Host: host });
    assert.equal(blocked.status, 403, 'foreign Host ' + host + ' must be refused');
    assert.ok(!blocked.body.includes('bridge-token'), 'foreign Host ' + host + ' must not receive the token');
    // Even holding a valid token, a foreign authority must reach no API route.
    assert.equal((await get(port, '/api/state', { Host: host, 'x-bridge-token': token })).status, 403);
  }
  console.log(
    'PASS: loopback authority served with token and CSP, foreign Host refused on static and API routes even with a valid token.',
  );
})().then(
  () => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  },
  error => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
  },
);
