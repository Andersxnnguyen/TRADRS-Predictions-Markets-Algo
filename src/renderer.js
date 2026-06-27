// ═══════════════════════════════════════════════════════════════════════════
//  Kalshi Trader — Renderer Process
// ═══════════════════════════════════════════════════════════════════════════

const { kalshi } = window;

// ── State ────────────────────────────────────────────────────────────────
let currentView = "dashboard";
let processRunning = false;
let currentMode = null;  // "scan" | "trade" | "backtest" | "scan-diagnose"
let config = {};
let backtestMarkets = 100;

// ═══════════════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (!view) return;
    switchView(view);
  });
});

function switchView(name) {
  currentView = name;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${name}`)?.classList.add("active");
}

// ═══════════════════════════════════════════════════════════════════════════
//  INIT — Load system info & config
// ═══════════════════════════════════════════════════════════════════════════
async function init() {
  // System info
  const info = await kalshi.getSystemInfo();
  const pyEl = document.getElementById("statPython");
  if (info.python) {
    pyEl.textContent = info.python.version;
    pyEl.classList.add("ok");
  } else {
    pyEl.textContent = "Not found";
    pyEl.classList.add("error");
  }

  document.getElementById("statPem").textContent = info.pemExists ? "Found ✓" : "Missing";
  document.getElementById("statPem").classList.add(info.pemExists ? "ok" : "warn");

  // Load config
  config = (await kalshi.readConfig()) || {};
  applyConfigToUI(config);

  // Check running state
  processRunning = await kalshi.isProcessRunning();
  updateProcessUI();
}

function applyConfigToUI(c) {
  // Dashboard env badge
  const badge = document.getElementById("envBadge");
  if (c.demo_mode) {
    badge.textContent = "DEMO";
    badge.classList.remove("live");
  } else {
    badge.textContent = "LIVE";
    badge.classList.add("live");
  }

  // API key display
  const keyEl = document.getElementById("statApiKey");
  if (c.api_key_id && c.api_key_id !== "YOUR_API_KEY_ID") {
    keyEl.textContent = c.api_key_id.substring(0, 12) + "...";
    keyEl.classList.add("ok");
  } else {
    keyEl.textContent = "Not configured";
    keyEl.classList.add("warn");
  }

  // Settings fields
  setValue("cfgApiKey", c.api_key_id);
  setValue("cfgPemPath", c.private_key_path);
  setValue("cfgScanInterval", c.scan_interval_seconds);
  setValue("cfgMaxMarkets", c.max_markets_per_scan);
  setValue("cfgMinVolume", c.min_volume);
  setValue("cfgMomentumVol", c.momentum_min_volume);
  setValue("cfgSpreadGap", c.spread_gap_threshold);
  setValue("cfgNearExpiry", c.near_expiry_hours);
  setValue("cfgMaxContracts", c.max_contracts_per_trade);
  setValue("cfgMaxSpend", c.max_daily_spend);

  // Toggles
  setToggle("toggleDemo", "toggleLive", c.demo_mode);
  setToggle("toggleAutoOff", "toggleAutoOn", !c.auto_trade);
  setToggle("toggleLimit", "toggleMarket", c.order_type === "limit");
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined) el.value = val;
}

function setToggle(onId, offId, isFirst) {
  const a = document.getElementById(onId);
  const b = document.getElementById(offId);
  if (a && b) {
    a.classList.toggle("active", isFirst);
    b.classList.toggle("active", !isFirst);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROCESS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function updateProcessUI() {
  const status = document.getElementById("statusIndicator");
  const dot = status.querySelector(".status-dot");
  const text = status.querySelector(".status-text");

  if (processRunning) {
    dot.className = "status-dot running";
    text.textContent = currentMode ? `Running: ${currentMode}` : "Running";
  } else {
    dot.className = "status-dot offline";
    text.textContent = "Idle";
  }

  // Update bot status on dashboard
  const botStatus = document.getElementById("statBot");
  if (processRunning) {
    botStatus.innerHTML = `<span class="status-dot running"></span> ${currentMode || "Running"}`;
  } else {
    botStatus.innerHTML = `<span class="status-dot offline"></span> Idle`;
  }

  // Toggle start/stop buttons
  toggleBtn("btnStartScan", "btnStopScan", processRunning && currentMode === "scan");
  toggleBtn("btnRunBacktest", "btnStopBacktest", processRunning && currentMode === "backtest");
}

function toggleBtn(startId, stopId, isRunning) {
  const start = document.getElementById(startId);
  const stop = document.getElementById(stopId);
  if (start) start.classList.toggle("hidden", isRunning);
  if (stop) stop.classList.toggle("hidden", !isRunning);
}

async function startProcess(mode, args) {
  if (processRunning) {
    appendOutput(getOutputEl(mode), "⚠ A process is already running. Stop it first.\n", "ansi-yellow");
    return;
  }

  currentMode = mode;
  const outputEl = getOutputEl(mode);
  clearOutput(outputEl);
  appendOutput(outputEl, `Starting ${mode}...\n\n`, "ansi-cyan");

  const result = await kalshi.runProcess({ mode, args });
  if (result.success) {
    processRunning = true;
    updateProcessUI();
  } else {
    appendOutput(outputEl, `Error: ${result.error}\n`, "ansi-red");
  }
}

async function stopProcess() {
  const result = await kalshi.stopProcess();
  if (result.success) {
    processRunning = false;
    currentMode = null;
    updateProcessUI();
  }
}

function getOutputEl(mode) {
  switch (mode) {
    case "scan":
    case "scan-diagnose":
    case "trade":
      return document.getElementById("scannerOutput");
    case "backtest":
      return document.getElementById("backtestOutput");
    default:
      return document.getElementById("scannerOutput");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TERMINAL OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

// ANSI color code → CSS class mapping
const ANSI_MAP = {
  "30": "", "31": "ansi-red", "32": "ansi-green",
  "33": "ansi-yellow", "34": "ansi-cyan", "35": "ansi-cyan",
  "36": "ansi-cyan", "37": "ansi-white",
  "90": "ansi-dim", "91": "ansi-red", "92": "ansi-green",
  "93": "ansi-yellow", "94": "ansi-cyan", "95": "ansi-cyan",
  "96": "ansi-cyan", "97": "ansi-white",
  "1": "ansi-bold",
};

function parseAnsi(text) {
  // Strip ANSI codes and apply CSS classes
  const parts = [];
  let rest = text;
  const regex = /\x1b\[([0-9;]+)m/g;
  let match;
  let lastIndex = 0;
  let currentClass = "";

  while ((match = regex.exec(rest)) !== null) {
    // Text before this code
    if (match.index > lastIndex) {
      parts.push({ text: rest.substring(lastIndex, match.index), cls: currentClass });
    }
    // Parse the code
    const codes = match[1].split(";");
    for (const code of codes) {
      if (code === "0") {
        currentClass = "";
      } else if (ANSI_MAP[code]) {
        currentClass = ANSI_MAP[code];
      }
    }
    lastIndex = regex.lastIndex;
  }
  // Remaining text
  if (lastIndex < rest.length) {
    parts.push({ text: rest.substring(lastIndex), cls: currentClass });
  }
  return parts;
}

function appendOutput(el, text, forceCls) {
  if (!el) return;
  // Remove placeholder if present
  const ph = el.querySelector(".terminal-placeholder");
  if (ph) ph.remove();

  const parts = forceCls ? [{ text, cls: forceCls }] : parseAnsi(text);

  for (const part of parts) {
    if (!part.text) continue;
    if (part.cls) {
      const span = document.createElement("span");
      span.className = part.cls;
      span.textContent = part.text;
      el.appendChild(span);
    } else {
      el.appendChild(document.createTextNode(part.text));
    }
  }

  // Auto-scroll
  el.scrollTop = el.scrollHeight;

  // Trim if too long (prevent memory bloat)
  if (el.childNodes.length > 5000) {
    while (el.childNodes.length > 4000) {
      el.removeChild(el.firstChild);
    }
  }
}

function clearOutput(el) {
  if (el) el.innerHTML = "";
}

// ═══════════════════════════════════════════════════════════════════════════
//  IPC EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════
kalshi.onStdout((data) => {
  if (currentMode) {
    appendOutput(getOutputEl(currentMode), data);
  }
});

kalshi.onStderr((data) => {
  if (currentMode) {
    appendOutput(getOutputEl(currentMode), data, "ansi-yellow");
  }
});

kalshi.onProcessExit((code) => {
  const outputEl = currentMode ? getOutputEl(currentMode) : null;
  if (outputEl) {
    const cls = code === 0 ? "ansi-green" : "ansi-red";
    appendOutput(outputEl, `\nProcess exited with code ${code}\n`, cls);
  }
  processRunning = false;
  currentMode = null;
  updateProcessUI();
});

// ═══════════════════════════════════════════════════════════════════════════
//  BUTTON HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ── Dashboard Quick Actions ──
document.getElementById("btnQuickScan").addEventListener("click", () => {
  switchView("scanner");
  startProcess("scan");
});

document.getElementById("btnQuickDiagnose").addEventListener("click", () => {
  switchView("scanner");
  startProcess("scan-diagnose");
});

document.getElementById("btnQuickTrade").addEventListener("click", () => {
  showTradeModal();
});

document.getElementById("btnQuickBacktest").addEventListener("click", () => {
  switchView("backtest");
  startProcess("backtest", { markets: 100, save: true });
});

// ── Scanner ──
document.getElementById("btnStartScan").addEventListener("click", () => {
  startProcess("scan");
});
document.getElementById("btnStopScan").addEventListener("click", stopProcess);

// ── Backtest ──
document.querySelectorAll("[data-markets]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-markets]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    backtestMarkets = parseInt(btn.dataset.markets);
  });
});

document.getElementById("btnRunBacktest").addEventListener("click", () => {
  const save = document.getElementById("btSave").checked;
  const verbose = document.getElementById("btVerbose").checked;
  const debug = backtestMarkets <= 5;
  startProcess("backtest", { markets: backtestMarkets, save, verbose, debug });
});
document.getElementById("btnStopBacktest").addEventListener("click", stopProcess);

// ── Logs ──
document.getElementById("btnRefreshLog").addEventListener("click", async () => {
  const content = await kalshi.readLog();
  const el = document.getElementById("logOutput");
  clearOutput(el);
  if (content) {
    appendOutput(el, content);
  } else {
    el.innerHTML = '<div class="terminal-placeholder">No log entries found.</div>';
  }
});

// ── Settings Toggles ──
function setupTogglePair(aId, bId) {
  const a = document.getElementById(aId);
  const b = document.getElementById(bId);
  if (!a || !b) return;
  a.addEventListener("click", () => { a.classList.add("active"); b.classList.remove("active"); });
  b.addEventListener("click", () => { b.classList.add("active"); a.classList.remove("active"); });
}

setupTogglePair("toggleDemo", "toggleLive");
setupTogglePair("toggleAutoOff", "toggleAutoOn");
setupTogglePair("toggleLimit", "toggleMarket");

// ── Save Config ──
document.getElementById("btnSaveConfig").addEventListener("click", async () => {
  const newConfig = {
    api_key_id: document.getElementById("cfgApiKey").value,
    private_key_path: document.getElementById("cfgPemPath").value,
    demo_mode: document.getElementById("toggleDemo").classList.contains("active"),
    scan_interval_seconds: parseInt(document.getElementById("cfgScanInterval").value),
    max_markets_per_scan: parseInt(document.getElementById("cfgMaxMarkets").value),
    min_volume: parseInt(document.getElementById("cfgMinVolume").value),
    momentum_min_volume: parseInt(document.getElementById("cfgMomentumVol").value),
    spread_gap_threshold: parseFloat(document.getElementById("cfgSpreadGap").value),
    near_expiry_hours: parseInt(document.getElementById("cfgNearExpiry").value),
    auto_trade: document.getElementById("toggleAutoOn").classList.contains("active"),
    max_contracts_per_trade: parseInt(document.getElementById("cfgMaxContracts").value),
    max_daily_spend: parseFloat(document.getElementById("cfgMaxSpend").value),
    order_type: document.getElementById("toggleLimit").classList.contains("active") ? "limit" : "market",
  };

  const result = await kalshi.saveConfig(newConfig);
  const btn = document.getElementById("btnSaveConfig");

  if (result.success) {
    config = newConfig;
    applyConfigToUI(config);
    btn.textContent = "Saved ✓";
    btn.style.background = "var(--green)";
    setTimeout(() => {
      btn.textContent = "Save Changes";
      btn.style.background = "";
    }, 2000);
  } else {
    btn.textContent = "Error!";
    btn.style.background = "var(--red)";
    setTimeout(() => {
      btn.textContent = "Save Changes";
      btn.style.background = "";
    }, 2000);
  }
});

// ── Install Deps ──
document.getElementById("btnInstallDeps").addEventListener("click", async () => {
  const statusEl = document.getElementById("installStatus");
  statusEl.textContent = "Installing...";
  const result = await kalshi.installDeps();
  statusEl.textContent = result.success ? "Done ✓" : `Error: ${result.error}`;
});

// ═══════════════════════════════════════════════════════════════════════════
//  TRADE CONFIRMATION MODAL
// ═══════════════════════════════════════════════════════════════════════════
function showTradeModal() {
  const modal = document.getElementById("tradeModal");
  const envLabel = document.getElementById("modalEnvLabel");
  const isDemo = config.demo_mode !== false;
  envLabel.textContent = `Current mode: ${isDemo ? "DEMO (paper trading)" : "LIVE (real money)"}`;
  envLabel.className = `modal-env ${isDemo ? "demo" : "live"}`;
  modal.classList.remove("hidden");
}

document.getElementById("modalCancel").addEventListener("click", () => {
  document.getElementById("tradeModal").classList.add("hidden");
});

document.getElementById("modalConfirm").addEventListener("click", () => {
  document.getElementById("tradeModal").classList.add("hidden");
  switchView("scanner");
  startProcess("trade");
});

// Close modal on overlay click
document.getElementById("tradeModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById("tradeModal").classList.add("hidden");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey) {
    switch (e.key) {
      case "1": e.preventDefault(); switchView("dashboard"); break;
      case "2": e.preventDefault(); switchView("scanner"); break;
      case "3": e.preventDefault(); switchView("backtest"); break;
      case "4": e.preventDefault(); switchView("logs"); break;
      case "5": e.preventDefault(); switchView("settings"); break;
      case "k": // Cmd+K = stop
        e.preventDefault();
        if (processRunning) stopProcess();
        break;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════
init();
