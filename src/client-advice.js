'use strict';
// What a client-setup result means for the person and what to do about it, in plain
// language. configure.js attaches it to every result (the manager shows it, and it is kept
// in client-setup.json), and configure-cli.js hands it to the installer. ASCII only: the
// installer reads the text as ANSI.
const retry = 'then open SAP MCP Connection Manager and choose Configure MCP clients.';

function settingsFile(client) {
  return client === 'Claude Desktop'
    ? "Claude Desktop's settings file (claude_desktop_config.json)"
    : "Codex's settings file (config.toml)";
}

function howToOpen(client) {
  return client === 'Claude Desktop'
    ? 'In Claude Desktop open Settings > Developer > Edit Config'
    : 'Open config.toml (its location is shown in Logs) in a text editor';
}

// First match wins: the restore failure carries the underlying file error in its text.
const failures = [
  [
    /Could not restore/i,
    () =>
      'Bridge could not put this settings file back as it was. Replace it with the backup named in this message before starting the client.',
  ],
  [
    /invalid JSON|invalid TOML|Unsupported Claude configuration|proposed configuration is invalid/i,
    client =>
      `${settingsFile(client)} contains a mistake, often a missing or extra comma or bracket, so Bridge left it untouched. ${howToOpen(client)}, correct it or put back one of the .backup files next to it, ${retry}`,
  ],
  [
    /EPERM|EACCES|EBUSY|EROFS|ENOSPC|operation not permitted|resource busy|read-only|no space/i,
    client =>
      `Bridge could not save ${settingsFile(client)}. It may be read-only, held open by another program (for example OneDrive syncing or antivirus), or the disk may be full. Quit ${client}, make sure the file is not read-only, ${retry}`,
  ],
  [
    /already used by a custom connector|inactive SAP-Bridge entry/i,
    client =>
      `${client} already has a connector named SAP-Bridge that Bridge did not create. Rename or remove it in ${client}'s settings, ${retry}`,
  ],
  [
    /Duplicate SAP MCP tables/i,
    client =>
      `${settingsFile(client)} contains more than one SAP-Bridge section. Delete the extra [mcp_servers.SAP-Bridge] section, ${retry}`,
  ],
  [
    /launcher has a custom format/i,
    client =>
      `The SAP-Bridge section in ${settingsFile(client)} was edited by hand in a layout Bridge does not change automatically. Delete that section, ${retry} Bridge writes it again.`,
  ],
  [
    /manual migration|legacy destinations could not be migrated/i,
    client =>
      `${client} has an older abap-adt-mcp setup that Bridge cannot convert automatically. Add those SAP systems in Bridge (Import existing connections may do it for you), remove the old entry from ${client}'s settings, ${retry}`,
  ],
];

function advise(client, status, message = '') {
  if (status === 'configured')
    return client === 'Claude Desktop'
      ? 'Quit Claude Desktop completely and reopen it (closing its window can leave it running in the system tray).'
      : 'Quit Codex completely and reopen it to load the Bridge.';
  if (status === 'unchanged') return '';
  if (status === 'skipped')
    return `${client} was not found on this computer. If you install it later, open SAP MCP Connection Manager and choose Configure MCP clients.`;
  if (status === 'preserved')
    return `${client} already has its own SAP-Bridge setup, so Bridge left it alone. To let Bridge manage it, remove that entry from ${client}'s settings, ${retry}`;
  if (status === 'rolled-back')
    return `Not changed, because setup failed for another client. Once that is fixed, choose Configure MCP clients.`;
  const found = failures.find(([pattern]) => pattern.test(message));
  // Unrecognised: say what Bridge was told, since the installer shows no other message.
  return found
    ? found[1](client)
    : `Bridge left ${client}'s settings unchanged because: ${String(message).split('\n')[0]} Troubleshooting in the Setup Guide lists the usual causes.`;
}

// Adds an "advice" text to each client and file of a configureAll() result.
function annotate(result) {
  for (const client of result.clients || []) {
    for (const file of client.files || []) file.advice = advise(client.client, file.status, file.message);
    const attention = (client.files || []).find(file => ['error', 'rolled-back', 'preserved'].includes(file.status));
    client.advice = attention ? attention.advice : advise(client.client, client.status, client.message);
  }
  return result;
}

// What the installer shows: one line per client that needs the person's attention.
function summarize(result) {
  return (result.clients || [])
    .filter(client => ['error', 'rolled-back'].includes(client.status))
    .map(client => `${client.client}: ${client.advice || advise(client.client, client.status, client.message)}`)
    .join('\n\n');
}

module.exports = { advise, annotate, summarize };
