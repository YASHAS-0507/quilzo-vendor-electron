const { app, BrowserWindow, Notification, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

const DASHBOARD_URL = 'https://web-production-cf36.up.railway.app/dashboard';

// ── PRINTER SETTINGS (persisted to JSON file) ──
const SETTINGS_PATH = path.join(app.getPath('userData'), 'quilzo-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch(e) {}
  return { printerOrder: [] };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch(e) {}
}

// ── SMART PRINTER SELECTION ──
async function getAvailablePrinters(webContents) {
  try {
    const printers = await webContents.getPrintersAsync();
    return printers;
  } catch(e) {
    return mainWindow ? await mainWindow.webContents.getPrintersAsync() : [];
  }
}

async function selectBestPrinter(webContents) {
  const settings = loadSettings();
  const printers = await getAvailablePrinters(webContents);
  const printerOrder = settings.printerOrder || [];

  if (!printers || printers.length === 0) return null;

  const orderedNames = printerOrder.length > 0 ? printerOrder : printers.map(p => p.name);
  const printerMap = {};
  printers.forEach(p => printerMap[p.name] = p);

  for (const name of orderedNames) {
    const printer = printerMap[name];
    if (!printer) continue;
    const status = printer.status || 0;
    if (status !== 5 && status !== 4) {
      return printer.name;
    }
  }

  return printers[0]?.name || null;
}

// ── SMART PRINT FUNCTION ──
async function smartPrint(pdfWindow, options = {}) {
  const {
    orientation = 'portrait',
    side = 'double',
    copies = 1,
  } = options;

  const printerName = await selectBestPrinter(pdfWindow.webContents);
  console.log(`[PRINT] Selected printer: ${printerName} | orientation: ${orientation} | side: ${side}`);

  const printOptions = {
    silent: true,
    printBackground: true,
    deviceName: printerName || '',
    copies: parseInt(copies) || 1,
    landscape: orientation === 'landscape',
    pageSize: 'A4',
    duplexMode: side === 'double' ? 'longEdge' : 'simplex',
    margins: { marginType: 'printableArea' },
    scaleFactor: 100,
  };

  return new Promise((resolve, reject) => {
    pdfWindow.webContents.print(printOptions, (success, errorType) => {
      if (success) {
        console.log(`[PRINT] ✅ Printed successfully on ${printerName}`);
        resolve({ success: true, printer: printerName });
      } else {
        console.log(`[PRINT] ❌ Failed: ${errorType} on ${printerName}`);
        reject(new Error(errorType));
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(DASHBOARD_URL);

  // ── INTERCEPT PDF POPUPS ──
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('/get-pdf/')) {
      const urlObj = new URL(url);
      const orientation = urlObj.searchParams.get('orientation') || 'portrait';
      const side = urlObj.searchParams.get('side') || 'double';
      const copies = urlObj.searchParams.get('copies') || '1';

      const pdfWin = new BrowserWindow({
        width: 900,
        height: 700,
        title: 'Quilzo Print Preview',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      pdfWin.loadURL(url);

      pdfWin.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.key.toLowerCase() === 'p') {
          event.preventDefault();
          smartPrint(pdfWin, { orientation, side, copies })
            .then(result => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('print-success', result);
              }
            })
            .catch(err => {
              dialog.showErrorBox('Print Failed', `Print failed: ${err.message}\nCheck printer connection and try again.`);
            });
        }
      });

      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // ── HEARTBEAT ──
  const https = require('https');
  function postToBackend(apiPath) {
    try {
      const url = new URL(DASHBOARD_URL);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: apiPath,
        method: 'POST',
        headers: { 'Content-Length': 0 }
      };
      const req = https.request(options, () => {});
      req.on('error', () => {});
      req.end();
    } catch(e) {}
  }

  let heartbeatInterval = setInterval(() => {
    postToBackend('/api/shop-heartbeat');
  }, 60000);

  app.on('before-quit', () => {
    clearInterval(heartbeatInterval);
    postToBackend('/api/shop-close');
  });

  // ── SECURITY HARDENING ──
  mainWindow.webContents.session.on('will-download', (event) => {
    event.preventDefault();
  });

  let devModeEnabled = false;

  mainWindow.webContents.on('context-menu', (e) => {
    if (!devModeEnabled) e.preventDefault();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'd') {
      event.preventDefault();
      devModeEnabled = !devModeEnabled;
      console.log('Dev mode:', devModeEnabled ? 'ON' : 'OFF');
      if (devModeEnabled) {
        mainWindow.webContents.openDevTools();
      } else {
        mainWindow.webContents.closeDevTools();
      }
      return;
    }
    if (!devModeEnabled) {
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault();
      }
    }
  });

  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  }, 2 * 60 * 60 * 1000);
}

// ── IPC HANDLERS ──
ipcMain.handle('get-printers', async () => {
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    const settings = loadSettings();
    return { printers, printerOrder: settings.printerOrder || [] };
  } catch(e) {
    return { printers: [], printerOrder: [] };
  }
});

ipcMain.handle('set-printer-order', async (event, orderedList) => {
  const settings = loadSettings();
  settings.printerOrder = orderedList;
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('print-pdf', async (event, { url, orientation, side, copies }) => {
  const pdfWin = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  await pdfWin.loadURL(url);

  try {
    const result = await smartPrint(pdfWin, { orientation, side, copies });
    pdfWin.close();
    return result;
  } catch(e) {
    pdfWin.close();
    return { success: false, error: e.message };
  }
});

app.on('ready', () => {
  const { net } = require('electron');
  let wasOnline = true;
  setInterval(() => {
    const isOnline = net.isOnline();
    if (isOnline && !wasOnline) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }
    wasOnline = isOnline;
  }, 5000);
});

app.whenReady().then(createWindow);

ipcMain.on('new-order', (event, orderInfo) => {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'New Order — Quilzo',
      body: orderInfo || 'A new order has arrived!',
      silent: false,
    });
    notification.show();
  }
  if (mainWindow) {
    mainWindow.flashFrame(true);
    mainWindow.once('focus', () => mainWindow.flashFrame(false));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});