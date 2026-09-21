'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDataFolder } = require('../src/open-data-folder');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-folder-test-'));
  try {
    const folder = path.join(root, 'data with spaces');
    const result = await openDataFolder(async actual => {
      assert.equal(actual, folder);
      assert.ok(fs.statSync(actual).isDirectory());
      return '';
    }, folder);
    assert.equal(result.path, folder);
    await assert.rejects(
      openDataFolder(async () => 'Access denied', folder),
      /Access denied/,
    );
    await assert.rejects(
      openDataFolder(async () => {
        throw new Error('OS launch failed');
      }, folder),
      /OS launch failed/,
    );
    console.log('PASS: folder creation, exact path and native open failure propagation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
