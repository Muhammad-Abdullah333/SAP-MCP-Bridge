'use strict';
const fs = require('fs'),
  path = require('path');
const TOML = require('./lib/toml');
const { importLegacy } = require('./migration');

function directLegacy(entry) {
  return (
    entry &&
    /(?:^|[\\/])node(?:\.exe)?$/i.test(entry.command || '') &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    /[\\/]abap-adt-mcp[\\/]dist[\\/]index\.js$/i.test(entry.args[0]) &&
    (typeof entry.env?.SAP_SYSTEMS_FILE === 'string' || typeof entry.env?.SAP_SYSTEMS === 'string')
  );
}
function active(entry) {
  return entry && entry.enabled !== false && entry.disabled !== true;
}
function section(text, name, changes) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Custom registration name requires manual migration.');
  const escaped = name.replace(/[-]/g, '\\-');
  const header = new RegExp(
    '^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:' + escaped + '|"' + escaped + '"|\'' + escaped + "')\\s*\\]\\s*(?:#.*)?$",
  );
  const lines = text.split(/\r?\n/),
    start = lines.findIndex(line => header.test(line));
  if (start < 0) throw new Error('Custom registration table format requires manual migration.');
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(changes)) {
    const index = body.findIndex(line => new RegExp('^\\s*' + key + '\\s*=').test(line));
    if (index >= 0) {
      // Do not partially overwrite multiline TOML values.
      try {
        TOML.parse(body[index]);
      } catch (_) {
        throw new Error('Multiline launcher settings require manual migration.');
      }
      body[index] = key + ' = ' + JSON.stringify(value);
    } else body.push(key + ' = ' + JSON.stringify(value));
  }
  lines.splice(start + 1, end - start - 1, ...body);
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}

function manage(file, client, helpers, options = {}) {
  if (!fs.existsSync(file)) return null;
  const original = fs.readFileSync(file, 'utf8'),
    text = original.replace(/^\uFEFF/, '');
  const claude = client === 'Claude Desktop',
    config = claude ? JSON.parse(text) : TOML.parse(text);
  const entries = claude ? config.mcpServers : config.mcp_servers;
  if (!entries) return null;
  const legacy = Object.entries(entries).filter(([, entry]) => active(entry) && directLegacy(entry));
  const bridges = Object.entries(entries).filter(([, entry]) => active(entry) && helpers.isBridge(entry));
  if (!legacy.length && !bridges.length) return null;
  const canonical = 'SAP-Bridge';
  if (!legacy.length && bridges.length === 1 && bridges[0][0] === canonical) return null;
  if (entries[canonical] && !helpers.isBridge(entries[canonical]) && !directLegacy(entries[canonical]))
    throw new Error(
      'SAP-Bridge is already used by a custom connector. Rename that connector in the client configuration, then retry. No configuration was changed.',
    );
  const [name, entry] =
    bridges.find(([id]) => id === canonical) || legacy.find(([id]) => id === canonical) || legacy[0] || bridges[0];
  let next = text;
  const replacements = new Map();
  for (const [id, value] of [...legacy, ...bridges]) {
    replacements.set(
      id,
      id === name
        ? {
            command: helpers.hostCommand().command,
            args: helpers.hostCommand().args,
            ...(!claude ? { enabled: true } : {}),
          }
        : !claude
          ? { enabled: false }
          : null,
    );
  }
  // Validate all rewrites before importing credentials or writing configuration.
  if (!claude) for (const [id, values] of replacements) next = section(next, id, values);
  if (!claude && name !== canonical) {
    if (entries[canonical])
      throw new Error(
        'An inactive SAP-Bridge entry already exists. Resolve it in the client configuration before retrying.',
      );
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const header = new RegExp(
      '^(\\s*\\[\\s*mcp_servers\\s*\\.\\s*)(?:' + escaped + '|"' + escaped + '"|\'' + escaped + "')(?=\\s*[.\\]])",
      'gm',
    );
    next = next.replace(header, '$1SAP-Bridge');
    const proposed = TOML.parse(next);
    if (!proposed.mcp_servers?.[canonical] || proposed.mcp_servers?.[name])
      throw new Error('Custom registration table format requires manual migration.');
  }
  for (const [id, old] of legacy) {
    const source = old.env.SAP_SYSTEMS ? 'Inline SAP systems from ' + id : old.env.SAP_SYSTEMS_FILE;
    if (!old.env.SAP_SYSTEMS && !path.isAbsolute(source))
      throw new Error('Relative SAP systems paths require manual migration.');
    const systems = JSON.parse((old.env.SAP_SYSTEMS || fs.readFileSync(source, 'utf8')).replace(/^\uFEFF/, ''));
    const report = importLegacy({
      entries: systems,
      source,
      secretWriter: options.secretWriter,
      env: { ...process.env, ...old.env },
    });
    if (report.warnings.some(message => !message.includes('previously deleted in Bridge')))
      throw new Error(
        'Some legacy destinations could not be migrated. The original registration was kept. Check Import existing connections.',
      );
  }
  if (claude) {
    for (const [id, values] of replacements) {
      if (values)
        entries[id] = { ...entries[id], ...values, env: { MCP_TOOLSETS: 'focused', ...(entries[id].env || {}) } };
      else delete entries[id];
    }
    if (name !== canonical) {
      entries[canonical] = entries[name];
      delete entries[name];
    }
    next = JSON.stringify(config, null, 2) + '\n';
  } else TOML.parse(next);
  const backup = original !== next ? helpers.backup(file) : null;
  if (original !== next) helpers.atomicWrite(file, next);
  return {
    file,
    backup,
    status: original === next ? 'unchanged' : 'configured',
    message: `SAP-Bridge uses your saved connections. Existing destinations were retained and previously removed destinations skipped. Duplicate SAP launchers were ${claude ? 'removed from active configuration (backup retained)' : 'disabled, with settings retained'}. Restart this client.`,
  };
}
module.exports = { manage, directLegacy, section };
