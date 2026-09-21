'use strict';
const fs = require('fs'),
  path = require('path');
const file = path.join(require('./paths').dataDir, 'preferences.json');
function read() {
  try {
    return { theme: 'system', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') return { theme: 'system' };
    throw e;
  }
}
function save(input) {
  const next = read();
  if (input.theme !== undefined) {
    if (!['system', 'light', 'dark'].includes(input.theme)) throw new Error('Invalid theme');
    next.theme = input.theme;
  }
  if (input.setupSeen !== undefined) {
    if (typeof input.setupSeen !== 'boolean') throw new Error('Invalid setup preference');
    next.setupSeen = input.setupSeen;
  }
  fs.writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return next;
}
module.exports = { read, save };
