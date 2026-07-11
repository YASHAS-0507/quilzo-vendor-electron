const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Existing
  notifyNewOrder: (orderInfo) => ipcRenderer.send('new-order', orderInfo),

  // Printer management
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  setPrinterOrder: (orderedList) => ipcRenderer.invoke('set-printer-order', orderedList),

  // Smart print
  printPDF: (url, options) => ipcRenderer.invoke('print-pdf', { url, ...options }),

  // Listen for print success
  onPrintSuccess: (callback) => ipcRenderer.on('print-success', (event, result) => callback(result)),
});