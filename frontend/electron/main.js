/**
 * electron/main.js — VeritasAI Desktop App
 *
 * Proper app experience:
 *  - Starts in a normal maximized window (not fullscreen kiosk by default)
 *  - Kiosk/lockdown only activates during the actual assessment
 *  - System tray icon with menu
 *  - Waits for Vite dev server before loading
 *  - Allows all media permissions (mic, camera, screen)
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');

let mainWindow = null;
let tray = null;
let meetingEnded = false;

// ── Wait for Vite dev server ────────────────────────────────────────────────
function waitForVite(url, retries = 80, delay = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(url, () => resolve())
        .on('error', () => {
          if (n <= 0) return reject(new Error('Vite did not start in time'));
          setTimeout(() => attempt(n - 1), delay);
        });
      req.setTimeout(500, () => { req.destroy(); });
    };
    attempt(retries);
  });
}

// ── Create the main window ──────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 900,
    minHeight: 650,
    center: true,
    show: false,                    // show after load to avoid flash
    autoHideMenuBar: true,
    title: 'SafeInterview',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#070710',     // match app bg to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required for camera / mic in Electron
      webSecurity: true,
    },
  });

  // Show once DOM is painted — avoids white flash on launch
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  // Block navigation outside the app
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('http://localhost:8000')) {
      e.preventDefault();
    }
  });

  // Deny all popup windows
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── System Tray ─────────────────────────────────────────────────────────────
function createTray() {
  // Use a blank 16x16 image if no icon file exists
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('SafeInterview — Professional Interview Platform');

  const menu = Menu.buildFromTemplate([
    { label: 'Open VeritasAI', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => { if (mainWindow) mainWindow.show(); });
}

// ── App Ready ───────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Grant all media permissions without a dialog
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const always = ['media', 'microphone', 'camera', 'display-capture', 'mediaKeySystem'];
    callback(always.includes(permission));
  });

  // Allow camera + mic getUserMedia from renderer
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  createWindow();
  createTray();

  // Wait for Vite then load
  console.log('[VeritasAI] Waiting for Vite dev server…');
  try {
    await waitForVite('http://localhost:5173');
    console.log('[VeritasAI] Vite ready — loading app');
  } catch (e) {
    console.error('[VeritasAI] Vite not ready:', e.message);
  }

  mainWindow.loadURL('http://localhost:5173');
});

// ── IPC Handlers ────────────────────────────────────────────────────────────

// Screen source — no user dialog (Electron provides it silently)
ipcMain.handle('get-screen-source', async () => {
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const chosen = sources.find(
    s => s.display_id === String(primary.id) || s.display_id === String(primary.id + 1)
  ) || sources[0];
  return { id: chosen?.id, name: chosen?.name };
});

// Active OS window (for app-switch detection)
ipcMain.handle('get-active-window', () => new Promise((resolve) => {
  const script = `
    Add-Type -TypeDefinition @'
    using System;using System.Runtime.InteropServices;using System.Text;
    public class Win32{
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
    }
'@ -PassThru | Out-Null
    $h=[Win32]::GetForegroundWindow()
    $b=New-Object Text.StringBuilder 256
    [Win32]::GetWindowText($h,$b,256)|Out-Null
    $b.ToString().Trim()
  `.replace(/\n/g, '; ');

  exec(`powershell -NoProfile -NonInteractive -Command "${script}"`, (err, stdout) => {
    resolve(err ? 'Unknown' : (stdout.trim() || 'Unknown'));
  });
}));

// Meeting ended — unlock window
ipcMain.on('meeting-ended', () => {
  meetingEnded = true;
  if (mainWindow) {
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
  }
});

ipcMain.on('quit-app', () => app.quit());

// Lockdown for assessment
ipcMain.on('enter-assessment', () => {
  if (mainWindow) {
    mainWindow.setKiosk(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }
});

// Release lockdown
ipcMain.on('exit-assessment', () => {
  if (mainWindow) {
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
  }
});

// Close only allowed after meeting ends
app.on('before-quit', () => { meetingEnded = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
