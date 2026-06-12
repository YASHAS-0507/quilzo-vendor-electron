const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  notifyNewOrder: (orderInfo) => ipcRenderer.send('new-order', orderInfo),
});