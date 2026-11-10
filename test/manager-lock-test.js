'use strict';
// Closing the app or restarting Windows leaves manager.lock behind, and Windows reuses its
// process id for another program. The manager used to take that as "already running", so it never started and the
// app showed an empty window on every launch. Runs the real manager against each lock.
const assert = require('assert/strict'),
  fs = require('fs'),
  http = require('http'),
  os = require('os'),
  path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ALIVE_ROUTE, MANAGER_APP, inspectLock } = require('../src/manager-lock');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-manager-lock-'));
const home = path.join(root, 'home');
const data = path.join(root, 'SAP MCP Desktop Bridge');
const lock = path.join(data, 'manager.lock');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(data, { recursive: true });
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

const children = [];
function startManager() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'manager.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.out = '';
  child.err = '';
  child.exited = new Promise(resolve => child.on('exit', resolve));
  child.stdout.on('data', chunk => (child.out += chunk));
  child.stderr.on('data', chunk => (child.err += chunk));
  return child;
}
async function waitForUrl(child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const found = child.out.match(/http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]/);
    if (found) return found[0];
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Manager did not start (exit ${child.exitCode}). stderr: ${child.err}`);
}
function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body }));
      })
      .on('error', reject);
  });
}
function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const urlOf = server => `http://127.0.0.1:${server.address().port}/`;
const close = server => new Promise(resolve => server.close(resolve));
const writeLock = (pid, url) => fs.writeFileSync(lock, JSON.stringify({ pid, url }));
const age = ms => fs.utimesSync(lock, new Date(Date.now() - ms), new Date(Date.now() - ms));
const stop = async child => {
  child.kill();
  await child.exited;
};
// A process id that is certainly not in use: its owner has already exited.
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;

async function assertTakesOver() {
  const child = startManager();
  const url = await waitForUrl(child);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { pid: child.pid, url });
  const alive = await get(new URL(ALIVE_ROUTE, url));
  assert.equal(alive.status, 200);
  assert.deepEqual(JSON.parse(alive.body), { app: MANAGER_APP, pid: child.pid });
  await stop(child);
}

(async () => {
  // Decisions on each kind of lock.
  fs.rmSync(lock, { force: true });
  assert.equal((await inspectLock(lock)).state, 'stale', 'no lock');
  fs.writeFileSync(lock, 'not a lock {');
  assert.equal((await inspectLock(lock)).state, 'stale', 'unreadable lock');
  writeLock(deadPid, 'http://127.0.0.1:1/');
  assert.equal((await inspectLock(lock)).state, 'stale', 'owner has exited');
  writeLock(process.pid, null);
  assert.equal((await inspectLock(lock)).state, 'starting', 'a manager that has not begun listening');
  age(60000);
  assert.equal((await inspectLock(lock)).state, 'stale', 'never began listening');
  fs.writeFileSync(lock, String(process.pid));
  age(60000);
  assert.equal((await inspectLock(lock)).state, 'stale', 'old plain-number lock');
  writeLock(process.pid, 'https://example.com/');
  assert.equal((await inspectLock(lock)).state, 'stale', 'an address that is not this machine is never contacted');

  // The port was reused by something that is not this manager.
  for (const [name, reply] of [
    ['a web server', () => 'hello'],
    ['JSON from another program', () => '{"pid":' + process.pid + '}'],
    ['a different manager', () => JSON.stringify({ app: MANAGER_APP, pid: process.pid + 1 })],
  ]) {
    const other = await listen((_req, res) => res.end(reply()));
    writeLock(process.pid, urlOf(other));
    assert.equal((await inspectLock(lock)).state, 'stale', name);
    await close(other);
  }

  // A silent server is given up on rather than waited for.
  const silent = await listen(() => {});
  writeLock(process.pid, urlOf(silent));
  assert.equal((await inspectLock(lock)).state, 'stale', 'a server that never answers');
  silent.closeAllConnections();
  await close(silent);

  // The reported failure: the process id now belongs to a live program, the port is dead.
  const closed = await listen(() => {});
  const deadUrl = urlOf(closed);
  await close(closed);
  writeLock(process.pid, deadUrl);
  await assertTakesOver();

  // Same, with something else now listening on the old port.
  const stranger = await listen((_req, res) => res.end('hello'));
  writeLock(process.pid, urlOf(stranger));
  await assertTakesOver();
  await close(stranger);

  // A genuine running manager still wins: the second start leaves it alone.
  fs.rmSync(lock, { force: true });
  const first = startManager();
  const url = await waitForUrl(first);
  assert.deepEqual(await inspectLock(lock), { state: 'running', url });
  const before = fs.readFileSync(lock, 'utf8');
  const second = startManager();
  assert.equal(await second.exited, 0);
  assert.equal(second.out, '', 'a second manager must not start a server');
  assert.equal(fs.readFileSync(lock, 'utf8'), before, 'the running manager keeps its lock');
  assert.equal((await get(new URL(ALIVE_ROUTE, url))).status, 200, 'the running manager keeps serving');
  await stop(first);

  // The route is behind the same loopback guard as everything else.
  const guarded = startManager();
  const guardedUrl = new URL(await waitForUrl(guarded));
  const foreign = await new Promise((resolve, reject) => {
    http
      .get(
        {
          host: '127.0.0.1',
          port: guardedUrl.port,
          path: ALIVE_ROUTE,
          headers: { Host: 'evil.example.com' },
          agent: false,
        },
        response => resolve(response.statusCode),
      )
      .on('error', reject);
  });
  assert.equal(foreign, 403);
  await stop(guarded);

  console.log(
    'PASS: a leftover lock is taken over whether its process id was reused or its port now serves something else; a genuine running manager keeps its lock; the alive check is loopback-guarded.',
  );
})().then(
  () => {
    children.forEach(child => child.kill());
    fs.rmSync(root, { recursive: true, force: true });
  },
  error => {
    children.forEach(child => child.kill());
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
  },
);
