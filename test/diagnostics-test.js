'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
let order = [],
  mode = 'success',
  captured;
childProcess.spawn = (command, args, options) => {
  captured = { command, args, options };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = () => {};
  child.stdin.write = line => {
    const message = JSON.parse(line);
    order.push(message.method);
    setImmediate(() => {
      if (mode === 'timeout') return;
      if (message.method === 'initialize')
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' },
              },
            }) + '\n',
          ),
        );
      if (message.method === 'tools/list')
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { tools: mode === 'no-tool' ? [] : [{ name: 'systemProfile' }] },
            }) + '\n',
          ),
        );
      if (message.method === 'tools/call')
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              result: {
                isError: mode === 'sap-error',
                content: [
                  { type: 'text', text: mode === 'sap-error' ? 'password=secret-value' : '{"collections":12}' },
                ],
              },
            }) + '\n',
          ),
        );
    });
  };
  return child;
};
const { probe, redact } = require('../src/diagnostics');
(async () => {
  let result = await probe({ command: 'node', args: ['fixture'], destination: 'DEV', secretValues: ['secret-value'] });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(result.stages.length, 3);
  mode = 'sap-error';
  result = await probe({ command: 'node', args: [], destination: 'DEV', secretValues: ['secret-value'] });
  assert.equal(result.ok, false);
  assert.ok(!result.message.includes('secret-value'));
  mode = 'no-tool';
  result = await probe({ command: 'node', args: [], destination: 'DEV' });
  assert.equal(result.ok, false);
  assert.match(result.message, /not exposed/);
  mode = 'timeout';
  result = await probe({ command: 'node', args: [], timeout: 10 });
  assert.equal(result.ok, false);
  assert.match(result.message, /timed out/);
  childProcess.spawn = realSpawn;
  console.log(
    'PASS: MCP protocol ordering, tool discovery, SAP tool call, tool errors, redaction and timeout cleanup.',
  );
})().catch(error => {
  childProcess.spawn = realSpawn;
  console.error(error);
  process.exitCode = 1;
});
