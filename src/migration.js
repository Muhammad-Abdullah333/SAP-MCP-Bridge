'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const { ensureDir, readConnections, writeConnections, readDeletionHistory, destinationIdentity } = require('./storage');
const { setSecret } = require('./secrets');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function take(object, parts) {
  let parent = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!parent || typeof parent !== 'object') return undefined;
    parent = parent[parts[index]];
  }
  if (!parent || typeof parent !== 'object') return undefined;
  const key = parts[parts.length - 1];
  const value = parent[key];
  delete parent[key];
  return value;
}

function resolveSecret(value, missing, label, env = process.env) {
  if (typeof value !== 'string' || !value) return undefined;
  const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!match) return value;
  if (env[match[1]]) return env[match[1]];
  missing.push(`${label} uses unavailable environment variable ${match[1]}`);
  return undefined;
}

function writeMarker(summary) {
  ensureDir(paths.dataDir);
  const temp = `${paths.migrationFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, paths.migrationFile);
}

function importLegacy(options = {}) {
  const secretWriter = options.secretWriter || setSecret;
  const force = Boolean(options.force || options.entries);
  if (!force && fs.existsSync(paths.migrationFile)) {
    try {
      return JSON.parse(fs.readFileSync(paths.migrationFile, 'utf8'));
    } catch (_) {}
  }
  const summary = {
    source: options.source || paths.legacySystemsFile,
    imported: [],
    skipped: [],
    warnings: [],
    ranAt: new Date().toISOString(),
  };
  if (!options.entries && !fs.existsSync(paths.legacySystemsFile)) {
    summary.status = 'not-found';
    if (!force) writeMarker(summary);
    return summary;
  }
  let systems;
  try {
    systems = options.entries || JSON.parse(fs.readFileSync(paths.legacySystemsFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Existing systems.json is not valid JSON: ${error.message}`);
  }
  if (!systems || typeof systems !== 'object' || Array.isArray(systems))
    throw new Error('Existing systems.json must contain a map of SAP systems.');
  const connections = readConnections();
  const existing = new Set(connections.map(item => item.id.toUpperCase()));
  const history = readDeletionHistory(),
    deleted = new Set(history.ids.map(id => id.toUpperCase())),
    deletedDestinations = new Set(history.destinations);
  for (const [rawId, rawConfig] of Object.entries(systems)) {
    const id = String(rawId).trim();
    if (!require('./identity').validId(id) || !rawConfig || typeof rawConfig !== 'object') {
      summary.skipped.push(rawId);
      summary.warnings.push(`${rawId}: unsupported connection name or format.`);
      continue;
    }
    if (existing.has(id.toUpperCase())) {
      summary.skipped.push(id);
      continue;
    }
    if (deleted.has(id.toUpperCase()) || deletedDestinations.has(destinationIdentity(rawConfig))) {
      summary.skipped.push(id);
      summary.warnings.push(
        `${id}: previously deleted in Bridge; not imported again. Use New or an encrypted backup to restore it deliberately.`,
      );
      continue;
    }
    const baseConfig = clone(rawConfig);
    const missing = [];
    const secret = {
      password: resolveSecret(take(baseConfig, ['password']), missing, 'password', options.env),
      gitPassword: resolveSecret(take(baseConfig, ['gitPassword']), missing, 'gitPassword', options.env),
      oauthClientSecret: resolveSecret(
        take(baseConfig, ['oauth', 'clientSecret']),
        missing,
        'oauth.clientSecret',
        options.env,
      ),
      tlsPassphrase: resolveSecret(take(baseConfig, ['tls', 'passphrase']), missing, 'tls.passphrase', options.env),
    };
    Object.keys(secret).forEach(key => secret[key] === undefined && delete secret[key]);
    const authType = String(rawConfig.authType || 'basic').toLowerCase();
    const user = String(rawConfig.user || rawConfig.username || '');
    const requiredMissing = (authType === 'basic' && !secret.password) || missing.length > 0;
    if (Object.keys(secret).length) secretWriter(id, secret);
    if (baseConfig.tls?.ca) baseConfig.tls.ca = expandHome(baseConfig.tls.ca);
    const item = {
      id,
      url: String(rawConfig.url || '').replace(/\/$/, ''),
      client: String(rawConfig.client || ''),
      user,
      language: String(rawConfig.language || 'EN').toUpperCase(),
      ca: String(expandHome(rawConfig.tls?.ca || '')),
      insecureTls: Boolean(rawConfig.insecureTls),
      enabled: rawConfig.enabled !== false && !requiredMissing,
      default: Boolean(rawConfig.default),
      authType,
      hasPassword: Boolean(secret.password),
      baseConfig,
      importedFrom: options.source || paths.legacySystemsFile,
    };
    connections.push(item);
    existing.add(id.toUpperCase());
    summary.imported.push(id);
    if (requiredMissing)
      summary.warnings.push(
        `${id}: imported disabled because one or more environment-based secrets were unavailable. Re-enter its password in the Bridge.`,
      );
  }
  if (!summary.imported.length) {
    summary.status = 'complete';
    if (!options.entries) writeMarker(summary);
    return summary;
  }
  if (!connections.some(item => item.default && item.enabled)) {
    const first = connections.find(item => item.enabled);
    if (first) first.default = true;
  }
  let foundDefault = false;
  for (const item of connections) {
    if (!item.enabled) item.default = false;
    if (item.default && !foundDefault) foundDefault = true;
    else if (item.default) item.default = false;
  }
  writeConnections(connections);
  summary.status = 'complete';
  if (!options.entries) writeMarker(summary);
  return summary;
}

function importAll(options = {}) {
  const vault = require('./legacy-vault');
  const summaries = [];
  const marker = path.join(paths.dataDir, 'vault-migrations.json');
  let completed = {};
  try {
    completed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch (_) {}
  for (const file of vault.candidates()) {
    if (!fs.existsSync(file) || (!options.force && completed[file])) continue;
    try {
      summaries.push(
        importLegacy({
          entries: vault.decode(fs.readFileSync(file, 'utf8')),
          source: file,
          secretWriter: options.secretWriter,
        }),
      );
      completed[file] = new Date().toISOString();
      ensureDir(paths.dataDir);
      fs.writeFileSync(marker, JSON.stringify(completed), { mode: 0o600 });
    } catch (error) {
      summaries.push({ source: file, imported: [], skipped: [], warnings: [error.message], status: 'error' });
    }
  }
  try {
    summaries.push(importLegacy(options));
  } catch (error) {
    summaries.push({ imported: [], skipped: [], warnings: [error.message], status: 'error' });
  }
  return {
    status: summaries.some(x => x.status === 'error') ? 'warning' : 'complete',
    imported: summaries.flatMap(x => x.imported),
    skipped: summaries.flatMap(x => x.skipped),
    warnings: summaries.flatMap(x => x.warnings),
    sources: summaries,
  };
}
module.exports = { importLegacy, importAll, expandHome };
