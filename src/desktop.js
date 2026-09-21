'use strict';
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs'),
  path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
let window,
  manager,
  quitting = false;
app.setName('SAP MCP Connection Manager');
if (process.platform === 'win32') app.setAppUserModelId('com.sap-mcp.desktop-bridge');
fs.mkdirSync(paths.dataDir, { recursive: true });
app.setPath('userData', path.join(paths.dataDir, 'desktop-profile'));
const startupLog = path.join(paths.dataDir, 'desktop-startup.log');
function log(message) {
  try {
    if (fs.existsSync(startupLog) && fs.statSync(startupLog).size > 512 * 1024) {
      const previous = startupLog + '.previous';
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(startupLog, previous);
    }
    fs.appendFileSync(startupLog, new Date().toISOString() + ' ' + String(message) + '\n');
  } catch (_) {}
}
log('Starting desktop ' + app.getVersion());
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (window) {
    window.show();
    window.focus();
  }
});
const node =
  process.platform === 'win32'
    ? path.join(paths.installDir(), 'runtime', 'node.exe')
    : path.resolve(paths.installDir(), '..', 'runtime', 'bin', 'node');
function trusted(event) {
  return window && event.sender === window.webContents;
}
app
  .whenReady()
  .then(() => {
    if (!primary) return;
    log('Electron ready');
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: 'Save encrypted connection backup', defaultPath: item.getFilename() });
    });
    window = new BrowserWindow({
      width: 1160,
      height: 860,
      minWidth: 780,
      minHeight: 620,
      title: 'SAP MCP Connection Manager',
      icon: path.join(__dirname, '..', 'assets', 'bridge.png'),
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'desktop-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let managerOrigin;
    window.webContents.on('did-fail-load', (_event, code, description) =>
      log('Page load failed: ' + code + ' ' + description),
    );
    window.webContents.on('render-process-gone', (_event, details) => log('Renderer stopped: ' + details.reason));
    window.webContents.on('will-navigate', (event, url) => {
      if (!managerOrigin || new URL(url).origin !== managerOrigin) event.preventDefault();
    });
    const open = url => {
      if (managerOrigin) return;
      managerOrigin = new URL(url).origin;
      log('Manager listening');
      window.loadURL(url);
      window.once('ready-to-show', () => {
        log('Window ready');
        window.show();
      });
    };
    const lock = path.join(paths.dataDir, 'manager.lock');
    try {
      const record = JSON.parse(fs.readFileSync(lock, 'utf8'));
      process.kill(record.pid, 0);
      if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(record.url)) open(record.url);
    } catch (_) {}
    if (!managerOrigin) {
      manager = spawn(node, [path.join(__dirname, 'manager.js')], {
        env: { ...process.env, SAP_MCP_BRIDGE_NO_BROWSER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let output = '',
        errorText = '';
      manager.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) open(match[0]);
      });
      manager.stderr.on('data', chunk => {
        errorText = (errorText + chunk).slice(-2000);
      });
      manager.on('error', error => {
        log('Manager launch failed: ' + error.message);
        dialog.showErrorBox('Manager could not start', error.message);
        app.quit();
      });
      manager.on('exit', code => {
        if (!quitting && code) {
          dialog.showErrorBox('Manager stopped', errorText || 'The local manager stopped unexpectedly.');
        }
        app.quit();
      });
    }
    window.on('closed', () => {
      window = null;
      app.quit();
    });
  })
  .catch(error => {
    log('Desktop startup failed: ' + error.message);
    dialog.showErrorBox('Manager could not start', error.message);
    app.quit();
  });
app.on('before-quit', () => {
  quitting = true;
  if (manager) manager.kill();
});
ipcMain.handle('open-data-folder', async event => {
  if (!trusted(event)) throw new Error('Untrusted window.');
  return require('./open-data-folder').openDataFolder(folder => shell.openPath(folder));
});
