'use strict';

// Decides whether manager.lock describes a manager that is really running. A process id
// alone cannot: the lock outlives the manager when the app closes it or Windows restarts,
// Windows hands the id to another program, and the app then waits on a server that no
// longer exists and shows an empty window.
const fs = require('fs');
const http = require('http');

const MANAGER_APP = 'sap-mcp-connection-manager';
const ALIVE_ROUTE = '/alive';
const ANSWER_MS = 2000;
// A lock without an address belongs to a manager between taking the lock and listening.
const STARTING_MS = 30000;

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim().startsWith('{') ? JSON.parse(raw) : { pid: Number(raw), url: null };
  } catch (_) {
    return { pid: 0, url: null };
  }
}

function lockAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch (_) {
    return Infinity;
  }
}

function answersAsManager(record) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(String(record.url))) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = http.get(new URL(ALIVE_ROUTE, record.url), { agent: false, timeout: ANSWER_MS }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (text.length < 1024) text += chunk;
      });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try {
          const answer = JSON.parse(text);
          resolve(answer.app === MANAGER_APP && answer.pid === Number(record.pid));
        } catch (_) {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

// running: that manager answered at url. starting: it has not begun listening yet.
// stale: nothing is behind the lock, whatever the process id now belongs to.
async function inspectLock(file) {
  const record = readLock(file);
  if (!pidIsRunning(Number(record.pid))) return { state: 'stale' };
  if (!record.url) return { state: lockAge(file) < STARTING_MS ? 'starting' : 'stale' };
  return (await answersAsManager(record)) ? { state: 'running', url: record.url } : { state: 'stale' };
}

module.exports = { ALIVE_ROUTE, MANAGER_APP, inspectLock };
