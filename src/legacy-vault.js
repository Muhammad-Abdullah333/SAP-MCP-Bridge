'use strict';
const fs = require('fs'),
  path = require('path');
const { spawnSync } = require('child_process');
function candidates() {
  const { legacyHome, legacyIsolated } = require('./paths');
  return [
    ...new Set([
      path.join(legacyHome, 'Documents', 'Codex', 'SAP MCP Connection Manager', 'Data', 'connections.protected'),
      path.join(legacyHome, 'Documents', 'SAP MCP Connection Manager', 'Data', 'connections.protected'),
      path.join(
        process.env.LOCALAPPDATA || path.join(legacyHome, 'AppData', 'Local'),
        'Programs',
        'SAP MCP Connection Manager',
        'Data',
        'connections.protected',
      ),
      // OneDrive redirects Documents to a real synced folder, so an isolated run must skip it.
      ...(!legacyIsolated && process.env.OneDrive
        ? [path.join(process.env.OneDrive, 'Documents', 'SAP MCP Connection Manager', 'Data', 'connections.protected')]
        : []),
    ]),
  ];
}
function decode(protectedText) {
  if (process.platform !== 'win32')
    throw new Error(
      'Windows-protected vaults must first be imported on the original Windows account. Use encrypted Bridge export to transfer them to a Mac.',
    );
  const result = spawnSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'import-vault.ps1')],
    { input: protectedText, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      'Could not decrypt the legacy vault. Use the original Windows account; the source was left unchanged.',
    );
  const vault = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(vault.connections)) throw new Error('The selected file is not a Connection Manager vault.');
  const entries = Object.create(null);
  for (const connection of vault.connections)
    entries[connection.name] = { ...connection.config, enabled: connection.enabled !== false };
  return entries;
}
module.exports = { candidates, decode };
