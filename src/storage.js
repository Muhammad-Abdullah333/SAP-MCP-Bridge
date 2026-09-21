'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readConnections() {
  try {
    const value = JSON.parse(fs.readFileSync(paths.connectionsFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(value))
      throw new Error('The saved connection list has an invalid format; it was left unchanged.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Could not read saved connections: ${error.message}`);
  }
}

function writeConnections(connections) {
  ensureDir(paths.dataDir);
  const temp = `${paths.connectionsFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(connections, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(paths.connectionsFile)) fs.copyFileSync(paths.connectionsFile, paths.connectionsFile + '.previous');
  fs.renameSync(temp, paths.connectionsFile);
  try {
    fs.chmodSync(paths.connectionsFile, 0o600);
  } catch (_) {}
}

const deletedFile = path.join(paths.dataDir, 'deleted-connections.json');
function readDeletionHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(deletedFile, 'utf8').replace(/^\uFEFF/, ''));
    const history = Array.isArray(raw) ? { ids: raw, destinations: [] } : raw;
    if (
      !history ||
      !Array.isArray(history.ids) ||
      !Array.isArray(history.destinations) ||
      [...history.ids, ...history.destinations].some(id => typeof id !== 'string')
    )
      throw new Error('Invalid deleted-connection history.');
    return history;
  } catch (error) {
    if (error.code === 'ENOENT') return { ids: [], destinations: [] };
    throw error;
  }
}
function writeDeletionHistory(history) {
  ensureDir(paths.dataDir);
  const temporary = deletedFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(
    temporary,
    JSON.stringify(
      { ids: [...new Set(history.ids.map(id => id.toUpperCase()))], destinations: [...new Set(history.destinations)] },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  fs.renameSync(temporary, deletedFile);
}
function readDeletedIds() {
  return readDeletionHistory().ids;
}
function destinationIdentity(item) {
  let url = String(item.url || '')
    .trim()
    .replace(/\/$/, '');
  try {
    url = new URL(url).toString().replace(/\/$/, '');
  } catch (_) {}
  return require('crypto')
    .createHash('sha256')
    .update(
      JSON.stringify([
        url,
        String(item.client || ''),
        String(item.user || item.username || ''),
        String(item.authType || 'basic').toLowerCase(),
      ]),
    )
    .digest('hex');
}

module.exports = {
  ensureDir,
  readConnections,
  writeConnections,
  readDeletedIds,
  readDeletionHistory,
  writeDeletionHistory,
  destinationIdentity,
};
