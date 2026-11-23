#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { readConnections, writeConnections } = require('./storage');
const { setSecret, getSecret, deleteSecret } = require('./secrets');
const { configureAll, readSetupReport, registrationWarnings } = require('./configure');
const { importCertificate } = require('./certificates');
const { importLegacy, importAll } = require('./migration');
const { createService, publicItem } = require('./connections');
const connectionsService = createService();
const activity = require('./activity').createActivity(paths.dataDir);
const transfer = require('./transfer').createTransfer();
const { ensureDir } = require('./storage');
const { buildDiscoveryUrl } = require('./system-config');
const { ALIVE_ROUTE, MANAGER_APP, inspectLock } = require('./manager-lock');
const { LAUNCH_ROUTE, createLaunchAuth, launchUrl, parseLaunchPath } = require('./launch-auth');

ensureDir(paths.dataDir);
const managerLock = path.join(paths.dataDir, 'manager.lock');
const auth = createLaunchAuth();
// Web edition: the browser tab is the only window, so the manager stops by itself once no
// tab has checked in for a while (src/web.js sets this). The desktop window stops it on close.
const webEdition = process.env.SAP_MCP_BRIDGE_WEB === '1';
// SAP_MCP_BRIDGE_IDLE_STOP_MS exists for the tests only (test/web-edition-test.js).
const IDLE_STOP_MS = Number(process.env.SAP_MCP_BRIDGE_IDLE_STOP_MS) > 0 ? Number(process.env.SAP_MCP_BRIDGE_IDLE_STOP_MS) : 10 * 60 * 1000;
let lastSeen = Date.now();
function openBrowser(url) {
  if (process.env.SAP_MCP_BRIDGE_NO_BROWSER === '1') return;
  const command = paths.isWindows ? 'explorer.exe' : '/usr/bin/open';
  spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
// The lock names the running manager and holds the launch key that opens it, so it is
// written for the user only (the data folder already is on Windows).
function writeLock(fd, url) {
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, url, launchKey: auth.launchKey }));
}
function takeLock() {
  const fd = fs.openSync(managerLock, 'wx', 0o600);
  writeLock(fd, null);
  fs.closeSync(fd);
  return true;
}
async function acquireManagerLock() {
  try {
    return takeLock();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const found = await inspectLock(managerLock);
    if (found.state !== 'stale') {
      // Already running: open it again rather than starting a second one.
      if (found.url && found.launchKey) openBrowser(launchUrl(found.url, found.launchKey));
      return false;
    }
    try {
      fs.unlinkSync(managerLock);
    } catch (_) {}
    return takeLock();
  }
}
function releaseManagerLock() {
  try {
    const raw = fs.readFileSync(managerLock, 'utf8');
    const record = raw.trim().startsWith('{') ? JSON.parse(raw) : { pid: Number(raw) };
    if (Number(record.pid) === process.pid) fs.unlinkSync(managerLock);
  } catch (_) {}
}
process.on('exit', releaseManagerLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Importing from earlier managers and from abap-adt-mcp's own settings happens only when
// the person asks (Import, Import vault). Scanning Documents/OneDrive and decrypting what
// it finds on every start is what antivirus behaviour monitoring calls credential theft.
let migrationSummary;

const publicDir = path.join(__dirname, 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// A DNS-rebound page reaches this port carrying its own Host header, so refuse any
// authority that is not the loopback address we actually bound. Access itself comes from
// the launch code and session cookie (src/launch-auth.js).
let boundPort = 0;
function loopbackHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}` || host === `[::1]:${boundPort}`;
}
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...securityHeaders,
  });
  res.end(body);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '',
      tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 40 * 1024 * 1024) {
        tooLarge = true;
        data = '';
        reject(new Error('Request is too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        reject(new Error('Invalid request'));
      }
    });
    req.on('error', reject);
  });
}

async function api(req, res, route) {
  if (!auth.authorised(req)) return json(res, 403, { error: 'Unauthorized request.' });
  lastSeen = Date.now();
  try {
    if (route === '/api/heartbeat' && req.method === 'POST') return json(res, 200, { ok: true });
    if (route === '/api/preferences') {
      const preferences = require('./preferences');
      if (req.method === 'GET') return json(res, 200, preferences.read());
      if (req.method === 'POST') return json(res, 200, preferences.save(await body(req)));
    }
    if (route === '/api/activity') {
      if (req.method === 'GET') return json(res, 200, { entries: activity.list() });
      if (req.method === 'POST') return json(res, 200, { entries: activity.add(await body(req)) });
      if (req.method === 'DELETE') return json(res, 200, { entries: activity.clear() });
    }
    if (req.method === 'GET' && route === '/api/state') {
      return json(res, 200, {
        version: require('../package.json').version,
        platform: process.platform,
        dataDir: paths.dataDir,
        clientSetup: readSetupReport(),
        registrationWarnings: registrationWarnings(),
        migration: migrationSummary,
        connections: readConnections().map(publicItem),
      });
    }
    if (req.method === 'POST' && route === '/api/save') {
      const input = await body(req);
      return json(res, 200, { ok: true, connection: connectionsService.save(input) });
    }
    if (req.method === 'POST' && route === '/api/delete') {
      const input = await body(req);
      const id = String(input.id || '');
      connectionsService.remove(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/api/test') {
      const prepared = connectionsService.prepare(await body(req));
      return json(res, 200, await require('./diagnostics').testDraft(prepared.item, prepared.secret));
    }
    if (req.method === 'POST' && route === '/api/diagnostics')
      return json(res, 200, await require('./diagnostics').diagnose((await body(req)).id));
    if (req.method === 'GET' && route === '/api/tools') {
      return json(res, 200, require('./tool-catalogue').catalogue());
    }
    if (req.method === 'POST' && route === '/api/policy-preview') {
      // One source of truth for what a policy means: the form asks the manager rather
      // than reimplementing the rules, so the warnings shown are the ones that apply.
      const draft = (await body(req)).policy || {};
      const policies = require('./policy');
      const policy = policies.normalise(draft);
      return json(res, 200, { policy, ...policies.describe(policy), warnings: policies.warnings(policy) });
    }
    if (req.method === 'POST' && route === '/api/duplicate')
      return json(res, 200, { connection: connectionsService.duplicate((await body(req)).id) });
    if (req.method === 'POST' && route === '/api/reveal') {
      const id = (await body(req)).id;
      if (!readConnections().some(x => x.id === id)) throw new Error('Connection not found.');
      return json(res, 200, { password: getSecret(id)?.password || '' });
    }
    if (req.method === 'POST' && route === '/api/export')
      return json(res, 200, { backup: transfer.exportBackup((await body(req)).passphrase) });
    if (req.method === 'POST' && route === '/api/restore') {
      const input = await body(req);
      return json(res, 200, transfer.importBackup(input.backup, input.passphrase));
    }
    if (req.method === 'POST' && route === '/api/import-vault') {
      const input = await body(req);
      migrationSummary = importLegacy({
        entries: require('./legacy-vault').decode(input.content),
        source: input.name || 'Selected legacy vault',
      });
      return json(res, 200, migrationSummary);
    }
    if (req.method === 'POST' && route === '/api/apply') return json(res, 200, { ok: true, result: configureAll() });
    if (req.method === 'POST' && route === '/api/certificate')
      return json(res, 200, importCertificate(await body(req)));
    if (req.method === 'POST' && route === '/api/import') {
      migrationSummary = importAll({ force: true });
      return json(res, 200, { ok: true, migration: migrationSummary });
    }
    if (req.method === 'POST' && route === '/api/open-folder') {
      fs.mkdirSync(paths.dataDir, { recursive: true });
      const command = paths.isWindows
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
        : '/usr/bin/open';
      await new Promise((resolve, reject) => {
        const child = spawn(command, [paths.dataDir], { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return json(res, 200, { ok: true, path: paths.dataDir });
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
}

// Shown for an expired or reused launch link, or the bare address typed by hand.
function openFromIcon(res) {
  const text = 'This SAP MCP Connection Manager link has expired or was already used. Open the manager from its Start menu icon.';
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SAP MCP Connection Manager</title></head><body><p>${text}</p></body></html>`;
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders });
  res.end(page);
}

const server = http.createServer((req, res) => {
  if (!loopbackHost(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders });
    return res.end('Forbidden');
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === ALIVE_ROUTE) return json(res, 200, { app: MANAGER_APP, pid: process.pid });
  if (url.pathname === LAUNCH_ROUTE || url.pathname.startsWith(LAUNCH_ROUTE + '/')) {
    const link = parseLaunchPath(url.pathname);
    const session = link && auth.redeem(link.nonce, link.code);
    if (!session) return openFromIcon(res);
    lastSeen = Date.now();
    // Redirect to the clean address, so the one-time code stays out of the page.
    res.writeHead(303, { Location: '/', 'Set-Cookie': auth.cookie(session), ...securityHeaders });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);
  let relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[a-zA-Z0-9._-]+$/.test(relative)) {
    res.writeHead(404);
    return res.end();
  }
  // The page is only for a window or tab that was opened through a launch code.
  if (relative === 'index.html' && !auth.hasSession(req)) return openFromIcon(res);
  const file = path.join(publicDir, relative);
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', ...securityHeaders });
    res.end(content);
  } catch (_) {
    res.writeHead(404);
    res.end();
  }
});

acquireManagerLock()
  .then(acquired => {
    if (!acquired) process.exit(0);
    server.listen(0, '127.0.0.1', () => {
      boundPort = server.address().port;
      const url = `http://127.0.0.1:${boundPort}/`;
      writeLock(managerLock, url);
      openBrowser(launchUrl(url, auth.launchKey));
      process.stdout.write(`SAP MCP Desktop Bridge is running at ${url}\n`);
      if (webEdition && process.stdin.isTTY) {
        // The address above is not a way in by itself (it needs a session). If no browser
        // tab opened, Enter opens a fresh one-time link, also shown here to paste by hand.
        process.stdout.write(
          'If no browser tab opened, press Enter in this window to open the manager again.\n',
        );
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', () => {
          const link = launchUrl(url, auth.launchKey);
          openBrowser(link);
          process.stdout.write(`Opening the manager. If no tab opens, paste this one-time link (valid for 1 minute):\n${link}\n`);
        });
        process.stdin.resume();
      }
      if (webEdition) {
        lastSeen = Date.now();
        setInterval(
          () => {
            if (Date.now() - lastSeen > IDLE_STOP_MS) {
              process.stdout.write('No manager tab has been open for a while; stopping. Open it again from its icon.\n');
              process.exit(0);
            }
          },
          Math.min(30 * 1000, Math.max(250, IDLE_STOP_MS / 4)),
        ).unref();
      }
    });
  })
  .catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
