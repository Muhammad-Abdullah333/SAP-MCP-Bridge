'use strict';
const assert = require('assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createActivity } = require('../src/activity');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-activity-'));
try {
  const log = createActivity(folder);
  log.add({ message: 'old report', key: 'report' });
  log.clear();
  log.add({ message: 'old report', key: 'report' });
  assert.equal(log.list().length, 0);
  for (let i = 0; i < 220; i++) log.add({ message: 'entry ' + i });
  assert.equal(log.list().length, 200);
  log.add({ message: 'password=SECRET' });
  assert.ok(!JSON.stringify(log.list()).includes('SECRET'));
  for (let i = 0; i < 200; i++) log.add({ message: 'x'.repeat(6000) });
  assert.ok(fs.statSync(path.join(folder, 'activity.json')).size <= 512 * 1024);
  assert.ok(createActivity(folder).list().length);
  log.clear();
  assert.deepEqual(createActivity(folder).list(), []);
  console.log(
    'PASS: persistent activity, retention/count/byte limits, redaction, clear and no stale report resurrection',
  );
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
