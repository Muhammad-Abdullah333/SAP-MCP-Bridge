#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { readConnections } = require('./storage');
const { getSecret } = require('./secrets');
const { loadEnabledSystems } = require('./system-config');

function fail(message) {
  process.stderr.write(`[SAP MCP Desktop Bridge] ${message}\n`);
  process.exit(1);
}

try {
  if (!fs.existsSync(paths.mcpEntry)) fail(`Bundled MCP server is missing: ${paths.mcpEntry}`);
  const enabled = readConnections().filter(item => item.enabled !== false);
  if (!enabled.length) fail('No enabled SAP connections. Open SAP MCP Desktop Bridge and add or enable one.');
  const systems = loadEnabledSystems(enabled, getSecret, (id, error) => {
    process.stderr.write(`[SAP MCP Desktop Bridge] Skipping ${id}: ${error.message}\n`);
  });
  if (!Object.keys(systems).length)
    fail('No SAP connections could be loaded. Check credentials in SAP MCP Desktop Bridge.');
  const child = spawn(process.execPath, [paths.mcpEntry], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, SAP_SYSTEMS: JSON.stringify(systems), MCP_TOOLSETS: process.env.MCP_TOOLSETS || 'focused' },
  });
  child.on('error', error => fail(error.message));
  child.on('exit', (code, signal) => (process.exitCode = signal ? 1 : code || 0));
} catch (error) {
  fail(error.message);
}
