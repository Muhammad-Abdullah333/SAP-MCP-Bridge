#!/usr/bin/env node
'use strict';
const { configureAll } = require('./configure');
try {
  const result = configureAll({ transactional: process.argv.includes('--transactional') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed || result.clients.some(client => client.status === 'error')) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
