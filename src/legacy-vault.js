'use strict';
const fs = require('fs'),
  path = require('path');
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
  let vault;
  try {
    const text = String(protectedText || '').trim();
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('not base64');
    const plain = require('./dpapi').unprotect(Buffer.from(text, 'base64'));
    vault = JSON.parse(plain.toString('utf8').replace(/^\uFEFF/, ''));
    plain.fill(0);
  } catch (_) {
    throw new Error(
      'Could not decrypt the legacy vault. Use the original Windows account; the source was left unchanged.',
    );
  }
  if (!Array.isArray(vault.connections)) throw new Error('The selected file is not a Connection Manager vault.');
  const entries = Object.create(null);
  for (const connection of vault.connections)
    entries[connection.name] = { ...connection.config, enabled: connection.enabled !== false };
  return entries;
}
module.exports = { candidates, decode };
