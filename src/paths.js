'use strict';

const os = require('os');
const path = require('path');

const productName = 'SAP MCP Desktop Bridge';
const isWindows = process.platform === 'win32';
const dataDir = isWindows
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), productName)
  : path.join(os.homedir(), 'Library', 'Application Support', productName);

// Legacy discovery reads the previous manager's vault and decrypts real credentials, and
// its locations hang off the home directory rather than any variable a caller overrides.
// Pointing LOCALAPPDATA at a temporary folder is therefore not enough to isolate a run:
// without this override a throwaway manager still finds, decrypts and imports the user's
// actual saved connections. Set SAP_MCP_BRIDGE_LEGACY_HOME for tests and manual checks.
const legacyIsolated = Boolean(process.env.SAP_MCP_BRIDGE_LEGACY_HOME);
const legacyHome = process.env.SAP_MCP_BRIDGE_LEGACY_HOME || os.homedir();

function installDir() {
  if (process.env.SAP_MCP_BRIDGE_HOME) return process.env.SAP_MCP_BRIDGE_HOME;
  return path.resolve(__dirname, '..');
}

module.exports = {
  productName,
  isWindows,
  dataDir,
  connectionsFile: path.join(dataDir, 'connections.json'),
  migrationFile: path.join(dataDir, 'migration.json'),
  legacyHome,
  legacyIsolated,
  legacySystemsFile: path.join(legacyHome, '.abap-adt-mcp', 'systems.json'),
  secretsDir: path.join(dataDir, 'secrets'),
  installDir,
  mcpEntry: path.join(installDir(), 'vendor', 'node_modules', 'abap-adt-mcp', 'dist', 'index.js'),
};
