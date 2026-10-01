#!/usr/bin/env node
'use strict';
// Connects Claude Desktop and ChatGPT/Codex; the installer runs this after copying the app.
//   --transactional   if any client fails, put every client's settings back as they were
//   --summary <file>  write what needs the person's attention, in plain language, for the
//                     installer to show
// Exit code: 0 at least one client is connected (or was already), 1 setup failed,
// 2 neither client was found on this computer.
const fs = require('fs');
const { configureAll } = require('./configure');
const { summarize } = require('./client-advice');
const at = process.argv.indexOf('--summary');
const summaryFile = at > 0 ? process.argv[at + 1] : undefined;
function writeSummary(text) {
  if (!summaryFile) return;
  try {
    fs.writeFileSync(summaryFile, text);
  } catch (_) {}
}
try {
  const result = configureAll({ transactional: process.argv.includes('--transactional') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  writeSummary(summarize(result));
  if (result.failed || result.clients.some(client => client.status === 'error')) process.exitCode = 1;
  else if (result.clients.every(client => client.status === 'skipped')) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  writeSummary(`Bridge could not complete the setup: ${error.message}`);
  process.exit(1);
}
