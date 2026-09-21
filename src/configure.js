'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const TOML = require('./lib/toml');

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
  return copy;
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function hostCommand() {
  return { command: process.execPath, args: [path.join(paths.installDir(), 'src', 'host.js')] };
}
function children(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(x => x.isDirectory())
      .map(x => x.name);
  } catch (_) {
    return [];
  }
}
function detectClients(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const win = (options.platform || process.platform) === 'win32';
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programs = env.ProgramFiles || 'C:\\Program Files';
  const config = win
    ? path.join(roaming, 'Claude', 'claude_desktop_config.json')
    : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const packages = win ? children(path.join(local, 'Packages')) : [];
  const claude = [];
  const appExists = names => names.some(name => fs.existsSync(name));
  const claudeInstalled = win
    ? appExists([
        path.join(local, 'Programs', 'Claude', 'Claude.exe'),
        path.join(local, 'AnthropicClaude', 'claude.exe'),
        path.join(programs, 'Claude', 'Claude.exe'),
      ])
    : appExists(['/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app')]);
  if (claudeInstalled || fs.existsSync(config)) claude.push(config);
  for (const name of packages.filter(x => /^Claude_/i.test(x)))
    claude.push(path.join(local, 'Packages', name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  const codex = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  const openaiInstalled = win
    ? packages.some(x => /^(OpenAI\.(Codex|ChatGPT)|ChatGPT_|Codex_)/i.test(x)) ||
      appExists([
        path.join(local, 'Programs', 'Codex', 'Codex.exe'),
        path.join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
        path.join(programs, 'Codex', 'Codex.exe'),
      ])
    : appExists([
        '/Applications/Codex.app',
        '/Applications/ChatGPT.app',
        path.join(home, 'Applications', 'Codex.app'),
        path.join(home, 'Applications', 'ChatGPT.app'),
      ]);
  const cliInstalled = String(env.PATH || '')
    .split(win ? ';' : ':')
    .filter(Boolean)
    .some(dir => (win ? ['codex.exe', 'codex.cmd'] : ['codex']).some(name => fs.existsSync(path.join(dir, name))));
  return [
    { client: 'Claude Desktop', files: [...new Set(claude)] },
    { client: 'ChatGPT/Codex', files: openaiInstalled || cliInstalled || fs.existsSync(codex) ? [codex] : [] },
  ];
}
function isBridge(entry) {
  return (
    Array.isArray(entry?.args) &&
    entry.args.some(
      arg =>
        /[\\/]src[\\/]host\.js$/i.test(String(arg)) &&
        (/SAP MCP Desktop Bridge/i.test(arg) || String(arg) === hostCommand().args[0]),
    )
  );
}
function configureClaudeFile(file, options = {}) {
  const managed = require('./manage-registrations').manage(
    file,
    'Claude Desktop',
    { isBridge, hostCommand, backup, atomicWrite },
    options,
  );
  if (managed) return managed;
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let config;
  try {
    config = original ? JSON.parse(original.replace(/^\uFEFF/, '')) : {};
  } catch (_) {
    throw new Error('Existing Claude configuration is invalid JSON; it was left unchanged.');
  }
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== 'object' ||
    (config.mcpServers !== undefined &&
      (!config.mcpServers || Array.isArray(config.mcpServers) || typeof config.mcpServers !== 'object'))
  )
    throw new Error('Unsupported Claude configuration; it was left unchanged.');
  config.mcpServers ||= {};
  const existing = config.mcpServers['SAP-Bridge'];
  if (existing && !isBridge(existing))
    return {
      file,
      status: 'preserved',
      message: 'Existing manual SAP-Bridge setup preserved. Bridge did not replace it.',
    };
  config.mcpServers['SAP-Bridge'] = {
    ...(existing || {}),
    ...hostCommand(),
    env: { MCP_TOOLSETS: 'focused', ...(existing?.env || {}) },
  };
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (original === next) return { file, status: 'unchanged', message: 'Bridge is already configured.' };
  const before = backup(file);
  atomicWrite(file, next);
  return { file, backup: before, status: 'configured', message: 'Bridge configured. Restart this client to load it.' };
}
// Only change simple launcher assignments in a positively identified Bridge table.
// Never remove or rewrite an unrelated/manual TOML table.
function updateCodexText(text) {
  try {
    TOML.parse(text.replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new Error('Existing Codex configuration is invalid TOML; it was left unchanged.');
  }
  const lines = text.split(/\r?\n/);
  const table =
    /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:SAP-Bridge|"SAP-Bridge"|'SAP-Bridge')\s*\]\s*(?:#.*)?$/;
  const starts = lines.map((line, i) => (table.test(line) ? i : -1)).filter(i => i >= 0);
  if (starts.length > 1) throw new Error('Duplicate SAP MCP tables already exist; configuration was left unchanged.');
  const entry = hostCommand();
  if (starts.length) {
    const start = starts[0];
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const section = lines.slice(start + 1, end);
    const commandLine = section.findIndex(line => /^\s*command\s*=/.test(line));
    const argsLine = section.findIndex(line => /^\s*args\s*=/.test(line));
    let args;
    try {
      args = JSON.parse((section[argsLine] || '').replace(/^\s*args\s*=\s*/, ''));
    } catch (_) {}
    if (!isBridge({ args }))
      return {
        text,
        status: 'preserved',
        message: 'Existing manual SAP-Bridge setup preserved. Bridge did not replace it.',
      };
    if (commandLine < 0 || argsLine < 0 || !/^\s*command\s*=\s*"(?:[^"\\]|\\.)*"\s*$/.test(section[commandLine]))
      throw new Error('Bridge launcher has a custom format; configuration was left unchanged.');
    section[commandLine] = `command = ${JSON.stringify(entry.command)}`;
    section[argsLine] = `args = ${JSON.stringify(entry.args)}`;
    lines.splice(start + 1, end - start - 1, ...section);
    return {
      text: lines.join(text.includes('\r\n') ? '\r\n' : '\n'),
      status: 'configured',
      message: 'Bridge launcher updated; existing settings preserved.',
    };
  }
  // Inline/dotted or nested-only definitions need explicit handling, not a competing table.
  if (/^[^#\r\n]*["']?SAP-Bridge["']?\s*[.\]=]/m.test(text) || /^\s*mcp_servers\s*=/m.test(text))
    return { text, status: 'preserved', message: 'Custom MCP configuration preserved; automatic editing was skipped.' };
  const block = [
    '# BEGIN SAP MCP Desktop Bridge',
    '[mcp_servers.SAP-Bridge]',
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    '',
    '[mcp_servers.SAP-Bridge.env]',
    'MCP_TOOLSETS = "focused"',
    '# END SAP MCP Desktop Bridge',
    '',
  ].join('\n');
  return {
    text: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`,
    status: 'configured',
    message: 'Bridge configured. Restart this client to load it.',
  };
}
function configureChatGPT(
  file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
  options = {},
) {
  const managed = require('./manage-registrations').manage(
    file,
    'ChatGPT/Codex',
    { isBridge, hostCommand, backup, atomicWrite },
    options,
  );
  if (managed) return managed;
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const result = updateCodexText(original);
  try {
    TOML.parse(result.text.replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new Error('The proposed configuration is invalid; the existing file was left unchanged.');
  }
  if (result.status === 'preserved') return { file, status: result.status, message: result.message };
  if (original === result.text) return { file, status: 'unchanged', message: 'Bridge is already configured.' };
  const before = backup(file);
  atomicWrite(file, result.text);
  return { file, backup: before, status: result.status, message: result.message };
}
function configureAll(options = {}) {
  const detected = options.clients || detectClients();
  const snapshots = new Map();
  if (options.transactional)
    for (const client of detected)
      for (const file of client.files) snapshots.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
  const clients = detected.map(client => {
    if (!client.files.length)
      return {
        client: client.client,
        status: 'skipped',
        message: 'No installed client or existing configuration was found.',
        files: [],
      };
    const files = client.files.map(file => {
      try {
        return client.client === 'Claude Desktop' ? configureClaudeFile(file) : configureChatGPT(file);
      } catch (error) {
        return { file, status: 'error', message: error.message };
      }
    });
    return {
      client: client.client,
      status: files.some(x => x.status === 'error')
        ? 'error'
        : files.some(x => x.status === 'configured')
          ? 'configured'
          : files[0].status,
      files,
    };
  });
  const failed = clients.some(client => client.status === 'error');
  let rolledBack = false;
  if (options.transactional && failed) {
    rolledBack = true;
    for (const [file, bytes] of snapshots) {
      try {
        if (bytes === null) {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } else atomicWrite(file, bytes);
      } catch (error) {
        rolledBack = false;
        clients.push({
          client: 'Configuration recovery',
          status: 'error',
          files: [],
          message: `Could not restore ${file}. Use its backup: ${error.message}`,
        });
      }
    }
    for (const client of clients)
      for (const file of client.files || [])
        if (file.status === 'configured') {
          file.status = 'rolled-back';
          file.message = 'Installation failed; the previous configuration was restored.';
          client.status = 'rolled-back';
        }
  }
  const result = { ranAt: new Date().toISOString(), clients, rolledBack, failed };
  if (options.report !== false) {
    try {
      atomicWrite(path.join(paths.dataDir, 'client-setup.json'), `${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      if (options.transactional)
        for (const [file, bytes] of snapshots) {
          if (bytes === null) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
          } else atomicWrite(file, bytes);
        }
      throw error;
    }
  }
  return result;
}
function readSetupReport() {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'client-setup.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}
function registrationWarnings(clients = detectClients()) {
  const warnings = [];
  for (const client of clients)
    for (const file of client.files) {
      try {
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const entries = client.client === 'Claude Desktop' ? JSON.parse(text).mcpServers : TOML.parse(text).mcp_servers;
        for (const [name, entry] of Object.entries(entries || {})) {
          if (!entry || entry.enabled === false || entry.disabled === true) continue;
          if (
            !/abap|sap/i.test(
              name + ' ' + entry.command + ' ' + (Array.isArray(entry.args) ? entry.args.join(' ') : ''),
            )
          )
            continue;
          if (isBridge(entry)) continue;
          warnings.push(
            `${client.client}: active registration "${name}" is independent of Bridge. Deleting a Bridge connection will not remove destinations exposed by it. Configuration: ${file}`,
          );
        }
      } catch (error) {
        warnings.push(`${client.client}: could not inspect MCP registrations: ${error.message}`);
      }
    }
  return warnings;
}
module.exports = {
  configureAll,
  configureClaudeFile,
  configureChatGPT,
  hostCommand,
  detectClients,
  updateCodexText,
  readSetupReport,
  registrationWarnings,
};
