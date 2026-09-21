'use strict';
const fs = require('fs');
const paths = require('./paths');
async function openDataFolder(openPath, folder = paths.dataDir) {
  fs.mkdirSync(folder, { recursive: true });
  const error = await openPath(folder);
  if (error) throw new Error(`Could not open the Bridge data folder: ${error}. Folder: ${folder}`);
  return { path: folder };
}
module.exports = { openDataFolder };
