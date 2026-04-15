// ═══════════════════════════════════════════════════════════════════════════
//  Kalshi Trader — Electron Main Process
//  NOTE: Must be launched with ELECTRON_RUN_AS_NODE unset (use launch.bat)
// ═══════════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, dialog, shell, Menu, ipcMain } = require("electron");
const path  = require("path");
const { spawn } = require("child_process");
const fs    = require("fs");
const http  = require("http");

const PORT      = 5050;
const FLASK_URL = `http://127.0.0.1:${PORT}`;

// ── Path resolution — works both in dev and packaged (electron-builder) ──────
// When packaged, extra files land in process.resourcesPath/app/
// When in dev, __dirname is the project root.
const IS_PACKED = app.isPackaged;
const APP_ROOT  = IS_PACKED
  ? path.join(process.resourcesPath, "app")   // packaged: resources/app/
  : path.join("C:\\Users\\danbe\\OneDrive\\Desktop\\kalshi_trader_final\\kalshi_trader"); // dev fallback

// Prefer compiled exe (PyInstaller), fall back to Python script in dev
const FLASK_EXE  = path.join(APP_ROOT, "Kalshi_dashboard.exe");   // Windows packaged
const FLASK_BIN  = path.join(APP_ROOT, "Kalshi_dashboard");        // macOS/Linux packaged
const FLASK_PY   = path.join(APP_ROOT, "Kalshi_dashboard.py");
const FLASK_VENV = path.join(APP_ROOT, ".venv", "Scripts", "pythonw.exe");
const FLASK_CWD  = APP_ROOT;

const USE_EXE    = fs.existsSync(FLASK_EXE);
const USE_BIN    = !USE_EXE && fs.existsSync(FLASK_BIN);
const SPAWN_CMD  = USE_EXE ? FLASK_EXE  : USE_BIN ? FLASK_BIN  : FLASK_VENV;
const SPAWN_ARGS = (USE_EXE || USE_BIN) ? []       : [FLASK_PY];

let mainWindow   = null;
let flaskProcess = null;

// ── Splash screen ─────────────────────────────────────────────────────────
// Must write to a temp dir — __dirname is inside a read-only .asar when packaged
const SPLASH_HTML = path.join(require("os").tmpdir(), "_tradrs_splash.html");
fs.writeFileSync(SPLASH_HTML, `<!DOCTYPE html><html><head>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:'Segoe UI',system-ui,sans-serif; color:#fff;
    background:linear-gradient(to bottom right,#000,#111827,#000); }

  .card {
    -webkit-app-region:drag;
    position:relative; overflow:hidden;
    width:340px; padding:36px 36px 28px;
    border-radius:24px;
    background:linear-gradient(135deg,rgba(255,255,255,0.08) 0%,rgba(255,255,255,0.02) 50%,rgba(255,255,255,0.05) 100%);
    backdrop-filter:blur(40px) saturate(1.5);
    -webkit-backdrop-filter:blur(40px) saturate(1.5);
    border:1px solid rgba(255,255,255,0.12);
    box-shadow:0 8px 32px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.1);
    display:flex; flex-direction:column; align-items:center; gap:14px;
  }
  .card::before {
    content:''; position:absolute; top:0; left:0; right:0; height:1px;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.25),transparent);
  }
  .card::after {
    content:''; position:absolute; top:-40px; right:-40px;
    width:140px; height:140px; background:rgba(255,255,255,0.04);
    filter:blur(50px); border-radius:50%; pointer-events:none;
  }

  .logo { position:relative; z-index:1; font-size:10px; font-weight:800;
    letter-spacing:4px; text-transform:uppercase; color:rgba(255,255,255,0.9); }
  h1   { position:relative; z-index:1; font-size:20px; font-weight:700; letter-spacing:-.3px; }
  p    { position:relative; z-index:1; font-size:12px; color:rgba(148,163,184,0.55); }

  /* ── Spinning globe ── */
  .globe { position:relative; z-index:1; width:44px; height:44px; }
  .globe svg { position:absolute; top:0; left:0; }
  .merid  { transform-origin:22px 22px; animation:globe-spin 2s linear infinite; }
  .merid2 { transform-origin:22px 22px; animation:globe-spin 2s linear infinite; animation-delay:-1s; }
  @keyframes globe-spin {
    0%   { transform:scaleX(1);     opacity:.45; }
    25%  { transform:scaleX(0.05);  opacity:.1;  }
    50%  { transform:scaleX(-1);    opacity:.15; }
    75%  { transform:scaleX(-0.05); opacity:.1;  }
    100% { transform:scaleX(1);     opacity:.45; }
  }
</style></head><body>
  <div class="card">
    <div class="logo">TRADRS</div>
    <h1>Starting up…</h1>
    <p>Launching your trading dashboard</p>

    <div class="globe">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <defs><clipPath id="gc"><circle cx="22" cy="22" r="20"/></clipPath></defs>
        <circle cx="22" cy="22" r="20" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/>
        <g clip-path="url(#gc)">
          <ellipse cx="22" cy="22" rx="20" ry="5"   fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
          <ellipse cx="22" cy="13" rx="20" ry="3.5"  fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
          <ellipse cx="22" cy="31" rx="20" ry="3.5"  fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
        </g>
      </svg>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <defs><clipPath id="gc2"><circle cx="22" cy="22" r="20"/></clipPath></defs>
        <g clip-path="url(#gc2)">
          <ellipse class="merid"  cx="22" cy="22" rx="20" ry="20" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.2"/>
          <ellipse class="merid2" cx="22" cy="22" rx="20" ry="20" fill="none" stroke="rgba(255,255,255,0.3)"  stroke-width="1"/>
        </g>
      </svg>
    </div>
  </div>
</body></html>`);

// ── Window control IPC ────────────────────────────────────────────────────
ipcMain.on("win-minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on("win-maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("win-close", () => { if (mainWindow) mainWindow.close(); });

// ── Poll until Flask answers ──────────────────────────────────────────────
function waitForFlask(maxMs, cb) {
  const start = Date.now();
  (function attempt() {
    const req = http.get(FLASK_URL, () => { req.destroy(); cb(null); });
    req.on("error", () => {
      if (Date.now() - start > maxMs) return cb(new Error("timed out"));
      setTimeout(attempt, 500);
    });
    req.setTimeout(1000, () => req.destroy());
  })();
}

// ── Create splash window ──────────────────────────────────────────────────
function createSplash() {
  const w = new BrowserWindow({
    width: 380, height: 270,
    frame: false, resizable: false, center: true,
    backgroundColor: "#0a0a0a",
    icon: APP_ICON,
    webPreferences: { nodeIntegration: false },
  });
  w.loadFile(SPLASH_HTML);
  return w;
}

// ── Create main window ────────────────────────────────────────────────────
const APP_ICON = path.join(__dirname, "assets", "icon.ico");

function createMain() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1024, minHeight: 700,
    backgroundColor: "#060a1e",
    frame: false,
    titleBarStyle: "hidden",
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
    title: "TRADRS Predictions Markets Algo",
  });
  mainWindow.loadURL(FLASK_URL);
  mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (flaskProcess) { try { flaskProcess.kill(); } catch(e){} flaskProcess = null; }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (Menu) Menu.setApplicationMenu(null);
  const splash = createSplash();

  // Check if Flask is already running — always show splash for at least 1.8s
  const splashStart = Date.now();
  function closeSplashAndOpen() {
    const elapsed = Date.now() - splashStart;
    const delay = Math.max(0, 1800 - elapsed);
    setTimeout(() => { createMain(); splash.close(); }, delay);
  }

  waitForFlask(2000, (err) => {
    if (!err) {
      closeSplashAndOpen();
      return;
    }

    // Need to spawn Flask
    if (!fs.existsSync(SPAWN_CMD) || (!(USE_EXE || USE_BIN) && !fs.existsSync(FLASK_PY))) {
      dialog.showErrorBox("TRADRS — Missing Files",
        "Could not find the dashboard executable.\n\nExpected:\n" + SPAWN_CMD);
      app.quit(); return;
    }

    flaskProcess = spawn(SPAWN_CMD, SPAWN_ARGS, {
      cwd: FLASK_CWD,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
    });
    flaskProcess.on("error", (e) => console.error("flask spawn:", e.message));

    waitForFlask(30000, (err2) => {
      if (err2) {
        dialog.showErrorBox("TRADRS — Startup Error", "Dashboard failed to start within 30s.");
        app.quit(); return;
      }
      closeSplashAndOpen();
    });
  });
});

app.on("window-all-closed", () => {
  if (flaskProcess) { try { flaskProcess.kill(); } catch(e){} flaskProcess = null; }
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMain();
});
