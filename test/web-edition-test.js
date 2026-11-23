'use strict';
// Web edition: the manager started by src/web.js stops by itself once no tab has checked in
// for the idle time, keeps running while a tab does, and a second start opens the running
// one instead of starting another. The idle time is shortened for the test; the real
// one is 10 minutes. Runs the real launcher, isolated from the user's own data.
const assert = require('assert/strict'),
  fs = require('fs'),
  http = require('http'),
  os = require('os'),
  path = require('path');
const { spawn } = require('child_process');
const { launchUrl } = require('../src/launch-auth');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-web-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const IDLE = 2500;
const env = {
  ...process.env,
  LOCALAPPDATA: root,
  APPDATA: path.join(root, 'roaming'),
  CODEX_HOME: path.join(root, 'codex'),
  USERPROFILE: home,
  HOME: home,
  SAP_MCP_BRIDGE_LEGACY_HOME: home,
  SAP_MCP_BRIDGE_NO_BROWSER: '1',
  SAP_MCP_BRIDGE_IDLE_STOP_MS: String(IDLE),
};
delete env.OneDrive;
const launcher = path.join(__dirname, '..', 'src', 'web.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function start() {
  const child = spawn(process.execPath, [launcher], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = '';
  child.stdout.on('data', chunk => (child.out += chunk));
  child.exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return child;
}
async function portOf(child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const found = child.out.match(/http:[/][/]127[.]0[.]0[.]1:([0-9]+)[/]/);
    if (found) return Number(found[1]);
    await sleep(100);
  }
  throw new Error('Manager did not start: ' + child.out);
}
function request(port, route, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { Host: '127.0.0.1:' + port, ...headers } }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const running = child => child.exitCode === null && child.signalCode === null;

(async () => {
  // 1. Nobody opens a tab: it stops by itself after the idle time.
  const first = start();
  await portOf(first);
  assert.ok(running(first), 'running after start');
  const code = await Promise.race([first.exited, sleep(IDLE * 4).then(() => 'still running')]);
  assert.equal(code, 0, 'stops by itself, cleanly, when no tab checks in');
  assert.ok(!fs.existsSync(path.join(root, 'SAP MCP Desktop Bridge', 'manager.lock')), 'and releases its lock');

  // 2. An open tab keeps it running; a second start opens it instead of starting another.
  const second = start();
  const port = await portOf(second);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'SAP MCP Desktop Bridge', 'manager.lock'), 'utf8'));
  const link = new URL(launchUrl(`http://127.0.0.1:${port}/`, lock.launchKey));
  const cookie = String((await request(port, link.pathname + link.search)).headers['set-cookie']).split(';')[0];
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await request(port, '/api/heartbeat', { Cookie: cookie, 'x-bridge-request': '1' }, 'POST')).status, 200);
    await sleep(IDLE / 3);
  }
  assert.ok(running(second), 'a tab checking in keeps it running past the idle time');

  const third = start();
  const thirdCode = await Promise.race([third.exited, sleep(15000).then(() => 'still running')]);
  assert.equal(thirdCode, 0, 'a second start hands over to the running manager and ends');
  assert.ok(running(second), 'the running manager is unaffected');

  // 3. The tab closes: it stops after the idle time.
  const secondCode = await Promise.race([second.exited, sleep(IDLE * 4).then(() => 'still running')]);
  assert.equal(secondCode, 0, 'stops once the last tab has gone quiet');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS: web edition stops by itself when no tab checks in, stays up while one does, and a second start reuses the running manager.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
