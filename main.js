const { app, BrowserWindow, Notification, ipcMain, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ptp = require('pdf-to-printer');

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
  return { printerOrder: [], bwPrinterOrder: [], colorPrinterOrder: [], a3PrinterOrder: [] };
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

async function selectBestPrinter(webContents, print_type = 'BW', paper_size = 'A4') {
  const settings = loadSettings();
  const printers = await getAvailablePrinters(webContents);

  if (!printers || printers.length === 0) return null;

  let pool;
  if (paper_size === 'A3') {
    pool = settings.a3PrinterOrder || [];
  } else if (print_type === 'Color') {
    pool = settings.colorPrinterOrder || [];
  } else {
    pool = settings.bwPrinterOrder || [];
  }

  const orderedNames = pool.length > 0 ? pool : (settings.printerOrder || printers.map(p => p.name));
  const printerMap = {};
  printers.forEach(p => printerMap[p.name] = p);

  for (const name of orderedNames) {
    // Exact match first
    let printer = printerMap[name];
    // Fuzzy match if exact fails — handles "(Copy 1)" suffix mismatches
    if (!printer) {
      const nameLower = name.toLowerCase();
      printer = printers.find(p =>
        p.name.toLowerCase().includes(nameLower) ||
        nameLower.includes(p.name.toLowerCase())
      );
    }
    if (!printer) {
      console.log(`[PRINT] ⚠️ Printer not found: "${name}"`);
      continue;
    }
    const status = printer.status || 0;
    if (status !== 5 && status !== 4) {
      console.log(`[PRINT] Resolved printer: "${name}" → "${printer.name}"`);
      return printer.name;
    }
  }

  return printers[0]?.name || null;
}

// ── SMART PRINT FUNCTION ──
async function smartPrint(tmpFilePath, options = {}) {
  const {
    orientation = 'portrait',
    side = 'double',
    copies = 1,
    print_type = 'BW',
    paper_size = 'A4',
  } = options;

  const printerName = await selectBestPrinter(mainWindow.webContents, print_type, paper_size);
  console.log(`[PRINT] printer=${printerName} | paper=${paper_size} | type=${print_type} | orientation=${orientation} | side=${side}`);

  const isColor = print_type === 'Color';
  const isA3 = paper_size === 'A3';
  const isDoubleSided = side !== 'single' && side !== 'simplex';

  const printOptions = {
    printer: printerName || undefined,
    paperSize: isA3 ? 'A3' : 'A4',
    monochrome: !isColor,
    side: isA3 ? 'simplex' : (isDoubleSided ? 'duplex' : 'simplex'),
    orientation: isA3 ? 'landscape' : 'portrait',
    copies: parseInt(copies) || 1,
    scale: 'noscale',
  };

  console.log('[PRINT] Final options:', JSON.stringify(printOptions));

  await ptp.print(tmpFilePath, printOptions);
  console.log(`[PRINT] ✅ Printed successfully on ${printerName}`);
  return { success: true, printer: printerName };
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
      const print_type = urlObj.searchParams.get('print_type') || 'BW';
      const paper_size = urlObj.searchParams.get('paper_size') || 'A4';

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

      // ── AUTO-PRINT: fires 2s after PDF finishes loading ──
      pdfWin.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          smartPrint(pdfWin, { orientation, side, copies, print_type, paper_size })
            .then(result => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('print-success', result);
              }
              setTimeout(() => { if (!pdfWin.isDestroyed()) pdfWin.close(); }, 1000);
            })
            .catch(err => {
              console.log('[PRINT] Auto-print failed:', err.message);
              dialog.showMessageBox(pdfWin, {
                type: 'error',
                title: 'Auto-print failed',
                message: `Could not print automatically: ${err.message}\n\nPress Ctrl+P to try manually.`,
              });
            });
        }, 2000);
      });

      // ── MANUAL FALLBACK: Ctrl+P ──
      pdfWin.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.key.toLowerCase() === 'p') {
          event.preventDefault();
          smartPrint(pdfWin, { orientation, side, copies, print_type, paper_size })
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

  // ── FIX 3: NAVIGATION LOCK ──
  const ALLOWED_URL = 'https://web-production-cf36.up.railway.app';

  mainWindow.webContents.on('will-navigate', (e, navUrl) => {
    if (!navUrl.startsWith(ALLOWED_URL)) {
      e.preventDefault();
      console.log('[SECURITY] Blocked navigation to:', navUrl);
    }
  });

  // ── AUTO-LOCK after 30min inactivity ──
  let _lockTimer;
  function resetLockTimer() {
    clearTimeout(_lockTimer);
    _lockTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(ALLOWED_URL + '/logout');
        console.log('[SECURITY] Auto-locked after 30min inactivity');
      }
    }, 30 * 60 * 1000);
  }
  mainWindow.webContents.on('before-input-event', () => resetLockTimer());
  resetLockTimer();
}

// ── IPC HANDLERS ──
ipcMain.handle('get-printers', async () => {
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    const settings = loadSettings();
    return {
      printers,
      printerOrder: settings.printerOrder || [],
      bwPrinterOrder: settings.bwPrinterOrder || [],
      colorPrinterOrder: settings.colorPrinterOrder || [],
      a3PrinterOrder: settings.a3PrinterOrder || [],
    };
  } catch(e) {
    return { printers: [], printerOrder: [], bwPrinterOrder: [], colorPrinterOrder: [], a3PrinterOrder: [] };
  }
});

ipcMain.handle('set-printer-order', async (event, payload) => {
  const settings = loadSettings();
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.bwPrinterOrder)    settings.bwPrinterOrder    = payload.bwPrinterOrder;
    if (payload.colorPrinterOrder) settings.colorPrinterOrder = payload.colorPrinterOrder;
    if (payload.a3PrinterOrder)    settings.a3PrinterOrder    = payload.a3PrinterOrder;
  } else if (Array.isArray(payload)) {
    settings.printerOrder = payload;
  }
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('print-pdf', async (event, { url, orientation, side, copies, print_type, paper_size, printer }) => {
  // Download PDF to temp file first — avoids Electron bug #30947 where
  // webContents.print() produces blank/dark pages when printing a PDF loaded
  // via HTTPS URL. Loading via file:// protocol prints correctly.
  // FIX 2: random suffix prevents collision if two jobs arrive within the same ms
  const tmpFile = path.join(os.tmpdir(), `quilzo_print_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`);

  // Extract cookies from the main window session and pass them manually —
  // net.request does not expose a per-session .net property; instead we
  // read the cookies and set the Cookie header directly
  const cookies = await mainWindow.webContents.session.cookies.get({ url });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  await new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    if (cookieHeader) request.setHeader('Cookie', cookieHeader);
    const chunks = [];
    request.on('response', (response) => {
      const detectedOrientation = response.headers['x-detected-orientation'] || null;
      if (detectedOrientation) orientation = detectedOrientation;
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { fs.writeFileSync(tmpFile, Buffer.concat(chunks)); resolve(); }
        catch(e) { reject(e); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });

  try {
    const result = await smartPrint(tmpFile, { orientation, side, copies, print_type, paper_size });
    return result;
  } catch(e) {
    return { success: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(_) {}
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