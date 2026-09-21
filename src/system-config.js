'use strict';

function buildDestination(item, secret) {
  const authType = item.authType || 'basic';
  if (authType === 'basic' && (!secret || !secret.password))
    throw new Error(`Credentials are missing for ${item.id}. Re-save that connection.`);
  const destination = item.baseConfig ? JSON.parse(JSON.stringify(item.baseConfig)) : {};
  destination.url = item.url;
  destination.client = item.client;
  destination.language = item.language || 'EN';
  destination.authType = authType;
  if (item.user) destination.user = item.user;
  if (secret?.password) destination.password = secret.password;
  if (secret?.gitPassword) destination.gitPassword = secret.gitPassword;
  if (secret?.oauthClientSecret)
    destination.oauth = { ...(destination.oauth || {}), clientSecret: secret.oauthClientSecret };
  if (secret?.tlsPassphrase) destination.tls = { ...(destination.tls || {}), passphrase: secret.tlsPassphrase };
  if (item.oauth)
    destination.oauth = {
      ...(destination.oauth || {}),
      ...item.oauth,
      ...(secret?.oauthClientSecret ? { clientSecret: secret.oauthClientSecret } : {}),
    };
  if (item.sso2) destination.sso2 = item.sso2;
  if (item.policy) destination.policy = item.policy;
  if (Object.hasOwn(item, 'servername')) {
    destination.tls = { ...(destination.tls || {}) };
    if (item.servername) destination.tls.servername = item.servername;
    else delete destination.tls.servername;
  }
  if (item.default) destination.default = true;
  else delete destination.default;
  destination.insecureTls = Boolean(item.insecureTls);
  if (item.ca) destination.tls = { ...(destination.tls || {}), ca: item.ca };
  else if (Object.hasOwn(item, 'ca') && destination.tls) delete destination.tls.ca;
  return destination;
}

function buildDiscoveryUrl(item) {
  const url = new URL('/sap/bc/adt/discovery', `${item.url}/`);
  url.searchParams.set('sap-client', item.client);
  url.searchParams.set('sap-language', item.language || 'EN');
  return url;
}

function loadEnabledSystems(connections, secretReader, onWarning = () => {}) {
  const systems = Object.create(null);
  for (const item of connections.filter(connection => connection.enabled !== false)) {
    try {
      systems[item.id] = buildDestination(item, secretReader(item.id));
    } catch (error) {
      onWarning(item.id, error);
    }
  }
  return systems;
}

module.exports = { buildDestination, buildDiscoveryUrl, loadEnabledSystems };
