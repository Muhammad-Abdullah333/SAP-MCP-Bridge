'use strict';
const fs = require('fs');
const path = require('path');
const { validId } = require('./identity');
const storage = require('./storage');
const secrets = require('./secrets');
const policies = require('./policy');
const clone = value => JSON.parse(JSON.stringify(value));
function publicItem(item) {
  const base = item.baseConfig || {};
  const { baseConfig, ...safe } = item;
  return {
    ...safe,
    authType: item.authType || 'basic',
    servername: item.servername ?? base.tls?.servername ?? '',
    policy: policies.normalise(item.policy || base.policy || {}),
    oauth: item.oauth || {
      tokenUrl: base.oauth?.tokenUrl || '',
      clientId: base.oauth?.clientId || '',
      scope: base.oauth?.scope || '',
    },
    sso2: item.sso2 || base.sso2 || { command: '', args: [], timeoutMs: 30000 },
  };
}
function validate(input, old) {
  const item = {
    ...(old || {}),
    id: String(input.id || '').trim(),
    url: String(input.url || '')
      .trim()
      .replace(/\/$/, ''),
    client: String(input.client || '').trim(),
    user: String(input.user || '').trim(),
    // The form no longer asks for a logon language, so a save keeps the one already stored
    // rather than resetting it; a new connection logs on in English.
    language: String(input.language || old?.language || 'EN')
      .trim()
      .toUpperCase(),
    ca: String(input.ca || '').trim(),
    servername: String(input.servername ?? old?.servername ?? old?.baseConfig?.tls?.servername ?? '').trim(),
    insecureTls: Boolean(input.insecureTls),
    enabled: input.enabled !== false,
    default: Boolean(input.default),
    authType: input.authType || old?.authType || 'basic',
  };
  if (!validId(item.id))
    throw new Error('Connection name must contain letters, numbers, dots, underscores or hyphens.');
  if (!['basic', 'sso', 'sso2', 'oauth'].includes(item.authType)) throw new Error('Unsupported authentication type.');
  let url;
  try {
    url = new URL(item.url);
  } catch (_) {
    throw new Error('Enter a valid SAP URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('SAP URL must use HTTP or HTTPS.');
  if (!/^\d{3}$/.test(item.client)) throw new Error('SAP client must contain three digits.');
  if (item.authType === 'basic' && !item.user) throw new Error('Basic authentication needs a username.');
  if (item.ca && !fs.existsSync(item.ca)) throw new Error('The CA certificate file does not exist.');
  // A new connection starts read-only; an existing one keeps whatever it had unless the
  // caller sends a policy. Every field is normalised and its patterns checked here, so a
  // policy that reaches the MCP server is one the server can actually act on.
  const previous = { ...(old?.baseConfig?.policy || {}), ...(old?.policy || {}) };
  const requested = input.policy ?? (old ? previous : { readOnly: true, allowFreeSql: false });
  item.policy = policies.normalise(requested, previous);
  item.oauth = { ...(old?.baseConfig?.oauth || {}), ...(old?.oauth || {}), ...(input.oauth || {}) };
  delete item.oauth.clientSecret;
  item.sso2 = { ...(old?.baseConfig?.sso2 || {}), ...(old?.sso2 || {}), ...(input.sso2 || {}) };
  if (item.authType === 'oauth' && (!item.oauth.tokenUrl || !item.oauth.clientId))
    throw new Error('OAuth needs a token URL and client ID.');
  if (item.authType === 'oauth') {
    const token = new URL(item.oauth.tokenUrl);
    if (token.protocol !== 'https:') throw new Error('OAuth token URL must use HTTPS.');
  }
  if (item.authType === 'sso2') {
    if (!path.isAbsolute(item.sso2.command || ''))
      throw new Error('SSO2 needs an absolute ticket-provider executable path.');
    if (!Array.isArray(item.sso2.args) || item.sso2.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
      throw new Error('SSO2 arguments must be a JSON array of strings.');
    item.sso2.timeoutMs = Number(item.sso2.timeoutMs || 30000);
    if (!Number.isInteger(item.sso2.timeoutMs) || item.sso2.timeoutMs < 1000 || item.sso2.timeoutMs > 300000)
      throw new Error('SSO2 timeout must be between 1000 and 300000 milliseconds.');
    if (url.protocol !== 'https:' || item.insecureTls)
      throw new Error('SSO2 requires HTTPS with certificate verification enabled.');
  }
  return item;
}
function createService(store = storage, vault = secrets) {
  function prepare(input) {
    const all = store.readConnections();
    const originalId = input.originalId || input.id;
    const old = all.find(x => x.id === originalId);
    if (input.originalId && !old) throw new Error('The original connection no longer exists. Refresh the manager.');
    if (input.isNew && old)
      throw new Error('A connection with this name already exists. Select it to edit, or use a different name.');
    const item = validate(input, old);
    if (all.some(x => x.id.toUpperCase() === item.id.toUpperCase() && x !== old))
      throw new Error('A connection with this name already exists.');
    const secret = old ? vault.getSecret(old.id) || {} : {};
    if (input.password) secret.password = String(input.password);
    if (input.oauthClientSecret) secret.oauthClientSecret = String(input.oauthClientSecret);
    if (item.enabled && item.authType === 'basic' && !secret.password)
      throw new Error('A password is required for an enabled basic-auth connection.');
    if (item.enabled && item.authType === 'oauth' && !secret.oauthClientSecret)
      throw new Error('OAuth client secret is required.');
    item.hasPassword = Boolean(secret.password);
    return { all, old, item, secret };
  }
  function save(input) {
    const { all, old, item, secret } = prepare(input);
    const before = vault.getSecret(item.id);
    try {
      if (Object.keys(secret).length) {
        vault.setSecret(item.id, secret);
        if (JSON.stringify(vault.getSecret(item.id)) !== JSON.stringify(secret))
          throw new Error('Secure storage verification failed.');
      }
      if (item.default && item.enabled)
        all.forEach(x => {
          x.default = false;
        });
      if (!item.enabled) item.default = false;
      const index = all.indexOf(old);
      if (index >= 0) all[index] = item;
      else all.push(item);
      if (!all.some(x => x.default && x.enabled !== false)) {
        const first = all.find(x => x.enabled !== false);
        if (first) first.default = true;
      }
      store.writeConnections(all);
    } catch (error) {
      if (before) vault.setSecret(item.id, before);
      else vault.deleteSecret(item.id);
      throw error;
    }
    // Keep the old secret on rename: this supports restoring a previous metadata backup.
    return publicItem(item);
  }
  function duplicate(id) {
    const all = store.readConnections(),
      source = all.find(x => x.id === id);
    if (!source) throw new Error('Select a connection first.');
    let name = id + '_COPY',
      n = 2;
    while (all.some(x => x.id.toUpperCase() === name.toUpperCase())) name = id + '_COPY' + n++;
    const item = { ...clone(source), id: name, default: false };
    const secret = vault.getSecret(id);
    try {
      if (secret) vault.setSecret(name, secret);
      all.push(item);
      store.writeConnections(all);
    } catch (error) {
      vault.deleteSecret(name);
      throw error;
    }
    return publicItem(item);
  }
  function remove(id) {
    const all = store.readConnections();
    if (!all.some(x => x.id === id)) throw new Error('Connection not found.');
    const next = all.filter(x => x.id !== id);
    if (!next.some(x => x.default && x.enabled !== false)) {
      const first = next.find(x => x.enabled !== false);
      if (first) first.default = true;
    }
    const deleted = store.readDeletionHistory ? store.readDeletionHistory() : { ids: [], destinations: [] };
    // Record the deletion before metadata removal, so legacy import cannot resurrect it.
    if (store.writeDeletionHistory)
      store.writeDeletionHistory({
        ids: [...deleted.ids, id],
        destinations: [...deleted.destinations, storage.destinationIdentity(all.find(item => item.id === id))],
      });
    try {
      store.writeConnections(next);
    } catch (error) {
      if (store.writeDeletionHistory) store.writeDeletionHistory(deleted);
      throw error;
    }
    try {
      vault.deleteSecret(id);
    } catch (error) {
      store.writeConnections(all);
      if (store.writeDeletionHistory) store.writeDeletionHistory(deleted);
      throw error;
    }
  }
  return { prepare, save, duplicate, remove };
}
module.exports = { publicItem, validate, createService };
