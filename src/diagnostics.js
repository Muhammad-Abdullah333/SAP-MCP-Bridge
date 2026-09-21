'use strict';
const fs = require('fs'),
  path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { buildDestination } = require('./system-config');
function redact(text, secrets = []) {
  let value = String(text || '');
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length > 2) value = value.split(secret).join('[redacted]');
  return value
    .replace(/(password|authorization|cookie|clientSecret|access_token)\s*[:=]\s*[^\r\n]+/gi, '$1=[redacted]')
    .slice(0, 1500);
}
function probe({ command, args, env = {}, destination, timeout = 90000, secretValues = [] }) {
  return new Promise(resolve => {
    const stages = [];
    let child,
      buffer = '',
      stderr = '',
      finished = false,
      timer;
    const finish = (ok, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child) {
        child.stdin?.end();
        child.kill();
      }
      resolve({ ok, message: redact(message, secretValues), stages });
    };
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...env },
      });
    } catch (error) {
      finish(false, error.message);
      return;
    }
    timer = setTimeout(
      () => finish(false, 'MCP diagnostics timed out. Complete any SSO sign-in, then retry.'),
      timeout,
    );
    const send = message => {
      if (!finished) child.stdin.write(JSON.stringify(message) + '\n');
    };
    child.stdin.on('error', error => finish(false, error.message));
    child.on('error', error => finish(false, 'Could not start MCP launcher: ' + error.message));
    child.on('exit', code => {
      if (!finished) finish(false, 'MCP exited before diagnostics completed: ' + (stderr || code));
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-6000);
    });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        finish(false, 'MCP response exceeded the diagnostic limit.');
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (message.error) {
          finish(false, message.error.message || 'MCP protocol error');
          return;
        }
        if (message.id === 1) {
          stages.push({ name: 'MCP initialization', ok: true });
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (message.id === 2) {
          const tools = message.result?.tools;
          if (!Array.isArray(tools)) {
            finish(false, 'MCP did not return a tool list.');
            return;
          }
          stages.push({ name: 'Tools available', ok: true, detail: String(tools.length) });
          if (!destination) {
            finish(true, 'Configured MCP launcher initialized and returned its tools.');
            return;
          }
          if (!tools.some(x => x.name === 'systemProfile')) {
            finish(false, 'systemProfile is not exposed by this MCP configuration.');
            return;
          }
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'systemProfile', arguments: { destination, refresh: true } },
          });
        }
        if (message.id === 3) {
          if (message.result?.isError) {
            finish(false, (message.result.content || []).map(x => x.text || '').join('\n'));
            return;
          }
          stages.push({ name: 'SAP systemProfile through MCP', ok: true });
          finish(true, 'MCP launched, initialized, listed its tools, and successfully called SAP systemProfile.');
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'sap-mcp-connection-manager-diagnostics', version: require('../package.json').version },
      },
    });
  });
}
function testDraft(item, secret) {
  if (!fs.existsSync(paths.mcpEntry)) throw new Error('Bundled MCP server is missing. Reinstall the Bridge.');
  const destination = buildDestination(item, secret);
  destination.default = true;
  return probe({
    command: process.execPath,
    args: [paths.mcpEntry],
    env: { SAP_SYSTEMS: JSON.stringify({ [item.id]: destination }), SAP_SYSTEMS_FILE: '', MCP_TOOLSETS: 'core' },
    destination: item.id,
    timeout: item.authType === 'sso' ? 180000 : 90000,
    secretValues: Object.values(secret || {}),
  });
}
async function diagnose(id) {
  const connections = require('./storage').readConnections();
  const item = connections.find(x => x.id === id);
  if (!item || item.enabled === false) throw new Error('Save and enable a connection before running full diagnostics.');
  const secret = require('./secrets').getSecret(id) || {};
  const bridge = await probe({
    command: process.execPath,
    args: [path.join(__dirname, 'host.js')],
    destination: id,
    secretValues: Object.values(secret),
    timeout: item.authType === 'sso' ? 180000 : 90000,
  });
  const clients = [];
  for (const client of require('./configure').detectClients()) {
    if (!client.files.length) {
      clients.push({ client: client.client, status: 'skipped', message: 'Client not found.' });
      continue;
    }
    for (const file of client.files) {
      try {
        const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const registrations =
          client.client === 'Claude Desktop'
            ? JSON.parse(text).mcpServers
            : require('./lib/toml').parse(text).mcp_servers;
        const sap = Object.entries(registrations || {}).filter(
          ([name, entry]) =>
            entry?.command && /abap|sap/i.test(name + ' ' + entry.command + ' ' + (entry.args || []).join(' ')),
        );
        if (!sap.length) {
          clients.push({
            client: client.client,
            status: 'skipped',
            message: 'No local SAP MCP launcher is configured.',
            file,
          });
          continue;
        }
        for (const [name, entry] of sap) {
          if (entry.enabled === false || entry.disabled === true) {
            clients.push({
              client: client.client + ' / ' + name,
              status: 'skipped',
              message: 'SAP MCP connector is disabled in this client.',
              file,
            });
            continue;
          }
          const result = await probe({
            command: entry.command,
            args: entry.args || [],
            env: entry.env || {},
            secretValues: Object.values(secret),
            timeout: 30000,
          });
          clients.push({
            client: client.client + ' / ' + name,
            file,
            status: result.ok ? 'passed' : 'failed',
            ...result,
          });
        }
      } catch (error) {
        clients.push({
          client: client.client,
          status: 'failed',
          message: redact(error.message, Object.values(secret)),
          file,
        });
      }
    }
  }
  return {
    bridge,
    clients,
    message:
      'Launcher checks run using the client configuration. They do not prove that an already-running client has reloaded it; restart the client after changes.',
  };
}
module.exports = { probe, testDraft, diagnose, redact };
