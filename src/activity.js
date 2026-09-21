'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function createActivity(folder) {
  const file = path.join(folder, 'activity.json');
  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return { entries: [], seen: [] };
      throw e;
    }
  }
  function write(data) {
    fs.mkdirSync(folder, { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function add(input) {
    const data = read();
    const key = input.key ? crypto.createHash('sha256').update(String(input.key)).digest('hex') : null;
    if (key && data.seen.includes(key)) return data.entries;
    if (key) data.seen = [...data.seen, key].slice(-100);
    const message = String(input.message || '')
      .replace(/(password|authorization|cookie|clientSecret|access_token)\s*[:=]\s*[^\r\n]+/gi, '$1=[redacted]')
      .slice(0, 6000);
    const date = new Date(input.at || Date.now());
    data.entries.push({
      at: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
      level: input.level === 'error' ? 'error' : 'info',
      message,
    });
    data.entries = data.entries.slice(-200);
    while (Buffer.byteLength(JSON.stringify(data)) > 512 * 1024 && data.entries.length) data.entries.shift();
    write(data);
    return data.entries;
  }
  return {
    list: () => read().entries,
    add,
    clear: () => {
      const data = read();
      data.entries = [];
      write(data);
      return [];
    },
  };
}
module.exports = { createActivity };
