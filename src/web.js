#!/usr/bin/env node
'use strict';
// Web edition launcher. The Start menu shortcut runs this with the bundled node.exe, in a
// small console window that stays visible (minimized) for as long as the manager runs:
// closing it stops the manager, and nothing runs hidden. The manager opens the default
// browser through a one-time launch link, and stops by itself 10 minutes after the last
// tab closes. If a manager is already running, it is opened in a new tab instead and this
// window closes again straight away.
process.title = 'SAP MCP Connection Manager - running (close this window to stop)';
process.env.SAP_MCP_BRIDGE_WEB = '1';
process.stdout.write(
  'SAP MCP Connection Manager is opening in your browser.\n' +
    'Keep this window open while you use it. Close it to stop the manager; it also stops\n' +
    'by itself 10 minutes after the last browser tab closes. Claude Desktop and Codex do not\n' +
    'need this window: they start their own connection to SAP.\n\n',
);
require('./manager');
