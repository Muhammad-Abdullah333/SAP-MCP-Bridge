# Starts the packaged MCP server with the packaged runtime, as Claude Desktop or Codex would,
# and checks it initializes and lists its tools. No SAP request is sent. The protocol is
# driven from Node: Windows PowerShell 5.1 did not reliably read the server's stdout.
param([Parameter(Mandatory=$true)][string]$Install)
$ErrorActionPreference='Stop'
$check=Join-Path ([IO.Path]::GetTempPath()) ('bridge-mcp-check-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.js')
[IO.File]::WriteAllText($check,@'
const { spawn } = require('child_process');
const [entry] = process.argv.slice(2);
const systems = { TEST: { url: 'https://example.invalid', client: '100', user: 'test', password: 'fixture-only', authType: 'basic', default: true, policy: { readOnly: true } } };
const child = spawn(process.execPath, [entry], { env: { ...process.env, SAP_SYSTEMS: JSON.stringify(systems), MCP_TOOLSETS: 'core' }, windowsHide: true });
const fail = message => { console.error(message); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('Bundled MCP response timed out.'), 30000);
const send = message => child.stdin.write(JSON.stringify(message) + '\n');
let buffer = '';
child.on('exit', code => fail('Bundled MCP exited before responding: ' + code));
child.stdout.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    let reply;
    try { reply = JSON.parse(line); } catch (_) { continue; }
    if (reply.error) fail(reply.error.message);
    if (reply.id === 1) {
      if (!reply.result.serverInfo) fail('Missing MCP server information.');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }
    if (reply.id === 2) {
      const profile = reply.result.tools.filter(tool => tool.name === 'systemProfile');
      if (profile.length !== 1) fail('The packaged MCP does not expose systemProfile.');
      if (!profile[0].inputSchema.properties.destination) fail('Unexpected systemProfile destination schema.');
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.kill();
      console.log(`PASS: actual packaged MCP initializes and exposes ${reply.result.tools.length} core tools including systemProfile. No SAP request was sent.`);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1.0.0' } } });
'@)
try {
  & (Join-Path $Install 'runtime\node.exe') $check (Join-Path $Install 'vendor\node_modules\abap-adt-mcp\dist\index.js')
  if($LASTEXITCODE -ne 0){ throw 'Packaged MCP check failed.' }
} finally {
  Remove-Item -LiteralPath $check -Force -ErrorAction SilentlyContinue
}
