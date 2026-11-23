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
  const local = { Host: '127.0.0.1:' + port };

  // The page carries no secret, and without a session it is not served at all.
  const bare = await get(port, '/', local);
  assert.equal(bare.status, 403, 'the page needs a session from a launch link');
  assert.ok(!/[a-f0-9]{48,}/.test(bare.body), 'no key or token in what an unauthenticated request receives');

  // A launch link signed with the key from manager.lock opens a session, once.
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'SAP MCP Desktop Bridge', 'manager.lock'), 'utf8'));
  assert.match(String(lock.launchKey), /^[a-f0-9]{64}$/, 'the lock holds the launch key');
  const { launchUrl } = require('../src/launch-auth');
  const link = new URL(launchUrl(`http://127.0.0.1:${port}/`, lock.launchKey));
  const launched = await get(port, link.pathname + link.search, local);
  assert.equal(launched.status, 303, 'a valid launch link redirects');
  assert.equal(launched.headers.location, '/', 'to the clean address');
  const setCookie = String(launched.headers['set-cookie'] || '');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await get(port, link.pathname + link.search, local)).status, 403, 'a launch link works only once');
  const wrongKey = new URL(launchUrl(`http://127.0.0.1:${port}/`, 'ab'.repeat(32)));
  assert.equal((await get(port, wrongKey.pathname + wrongKey.search, local)).status, 403, 'a link signed with another key is refused');

  const page = await get(port, '/', { ...local, Cookie: cookie });
  assert.equal(page.status, 200, 'the page opens with the session');
  assert.ok(!/bridge-token|[a-f0-9]{64}/.test(page.body), 'the page carries no secret');
  assert.equal((await get(port, '/', { Host: 'localhost:' + port, Cookie: cookie })).status, 200, 'localhost authority must work');
  assert.equal((await get(port, '/api/state', { ...local, Cookie: cookie, 'x-bridge-request': '1' })).status, 200);
  assert.equal((await get(port, '/api/state', { ...local, Cookie: cookie })).status, 403, 'the API needs the request header');
  assert.equal((await get(port, '/api/state', { ...local, 'x-bridge-request': '1' })).status, 403, 'the API needs the session');
  assert.equal((await get(port, '/api/state', { ...local, Cookie: 'bridge_session=' + 'cd'.repeat(32), 'x-bridge-request': '1' })).status, 403, 'an invented session is refused');

  // Security headers reach both static and JSON responses.
  assert.match(page.headers['content-security-policy'] || '', /default-src 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');

  // A rebound page presents its own Host: refuse before routing.
  for (const host of ['evil.example.com', 'evil.example.com:' + port, '127.0.0.1:1', 'attacker.test']) {
    const blocked = await get(port, '/', { Host: host, Cookie: cookie });
    assert.equal(blocked.status, 403, 'foreign Host ' + host + ' must be refused');
    // Even holding a valid session, a foreign authority must reach no API route.
    assert.equal((await get(port, '/api/state', { Host: host, Cookie: cookie, 'x-bridge-request': '1' })).status, 403);
    const fresh = new URL(launchUrl(`http://127.0.0.1:${port}/`, lock.launchKey));
    assert.equal((await get(port, fresh.pathname + fresh.search, { Host: host })).status, 403, 'no launch through a foreign Host');
  }
  console.log(
    'PASS: the page carries no secret; a launch link signed with the lock key opens an HttpOnly same-site session once; the API needs session and header; foreign Host refused everywhere.',
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
