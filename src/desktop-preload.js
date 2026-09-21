'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridgeDesktop', {
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
});
