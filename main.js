const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

// CHANGE THIS to your actual vendor dashboard URL/route
const DASHBOARD_URL = 'https://web-production-cf36.up.railway.app/dashboard';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // THE KEY FIX: Chrome/Electron throttles timers + audio in
      // unfocused windows by default. This turns that off, so any
      // setInterval polling + Audio playback in dashboard.html keeps
      // running normally even when the window isn't focused.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(DASHBOARD_URL);

  // ── SECURITY HARDENING ──
  // 1. Block all downloads (always on)
  mainWindow.webContents.session.on('will-download', (event) => {
    event.preventDefault();
  });

  // 2 & 3. Right-click menu + DevTools — toggleable via Ctrl+Shift+D
  let devModeEnabled = false;

  mainWindow.webContents.on('context-menu', (e) => {
    if (!devModeEnabled) e.preventDefault();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Toggle dev mode with Ctrl+Shift+D
    if (input.control && input.shift && input.key.toLowerCase() === 'd') {
      devModeEnabled = !devModeEnabled;
      console.log('Dev mode:', devModeEnabled ? 'ON' : 'OFF');
      return;
    }
    // Block F12 / Ctrl+Shift+I unless dev mode is on
    if (!devModeEnabled) {
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault();
      }
    }
  });

  // Periodically reload the page so any pushed dashboard.html updates
  // (new JS/CSS/features) get picked up automatically without restarting.
  // Every 2 hours.
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  }, 2 * 60 * 60 * 1000);

  // Optional: open devtools for debugging during testing
  // mainWindow.webContents.openDevTools();
}

// Reload immediately when network connection comes back
// (e.g. after wifi drops and reconnects)
app.on('ready', () => {
  const { net } = require('electron');
  let wasOnline = true;
  setInterval(() => {
    const isOnline = net.isOnline();
    if (isOnline && !wasOnline) {
      // came back online after being offline
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }
    wasOnline = isOnline;
  }, 5000);
});

app.whenReady().then(createWindow);

// Renderer (dashboard.html) calls window.electronAPI.notifyNewOrder(text)
// when it detects a new order. We show a native OS notification
// (which has its own system sound) and flash the taskbar/dock icon.
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