const { contextBridge, ipcRenderer } = require('electron');

const boot = ipcRenderer.sendSync('bootstrap');

contextBridge.exposeInMainWorld('soracity', {
  mode: boot.mode,
  config: boot.site,
  heartbeat: (data) => ipcRenderer.send('heartbeat', data),
  report: (type, data = {}) => ipcRenderer.send('report', { type, ...data }),
});
