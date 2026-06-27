/**
 * Kalshi Trader — First-time setup
 * Run: node setup.js
 * 
 * Checks Python, installs pip deps, npm deps, then launches the app.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function log(color, msg) {
  console.log(`${color}${msg}${RESET}`);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
  } catch (e) {
    return null;
  }
}

log(CYAN, "\n══════════════════════════════════════════════");
log(CYAN, "  Kalshi Trader — Desktop App Setup");
log(CYAN, "══════════════════════════════════════════════\n");

// Step 1: Check Node & npm
log(CYAN, "[1/4] Checking Node.js...");
const nodeVer = run("node --version");
if (nodeVer) {
  log(GREEN, `  ✓ Node ${nodeVer}`);
} else {
  log(RED, "  ✗ Node.js not found. Install from https://nodejs.org");
  process.exit(1);
}

// Step 2: Check Python
log(CYAN, "\n[2/4] Checking Python...");
let pythonCmd = null;
for (const cmd of ["python", "python3", "py"]) {
  const ver = run(`${cmd} --version 2>&1`);
  if (ver && ver.includes("Python 3")) {
    pythonCmd = cmd;
    log(GREEN, `  ✓ ${ver} (using: ${cmd})`);
    break;
  }
}
if (!pythonCmd) {
  log(YELLOW, "  ⚠ Python 3 not found. Install from https://python.org");
  log(YELLOW, "    The app will still launch but Python features won't work.");
}

// Step 3: Install Python deps
if (pythonCmd && fs.existsSync("requirements.txt")) {
  log(CYAN, "\n[3/4] Installing Python dependencies...");
  const pipResult = run(`${pythonCmd} -m pip install -r requirements.txt --quiet 2>&1`);
  if (pipResult !== null) {
    log(GREEN, "  ✓ Python packages installed");
  } else {
    log(YELLOW, "  ⚠ pip install had issues — you may need to install manually");
  }
} else {
  log(YELLOW, "\n[3/4] Skipping Python deps (no Python or requirements.txt)");
}

// Step 4: Install npm deps
log(CYAN, "\n[4/4] Installing Electron...");
if (!fs.existsSync("node_modules")) {
  try {
    execSync("npm install", { stdio: "inherit" });
    log(GREEN, "  ✓ npm packages installed");
  } catch {
    log(RED, "  ✗ npm install failed");
    process.exit(1);
  }
} else {
  log(GREEN, "  ✓ node_modules already exists");
}

log(GREEN, "\n══════════════════════════════════════════════");
log(GREEN, "  Setup complete! Launch with: npm start");
log(GREEN, "══════════════════════════════════════════════\n");
