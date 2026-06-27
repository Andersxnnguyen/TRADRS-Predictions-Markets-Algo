# Kalshi Trader — Desktop App
### Electron-powered market scanner, backtester, and trading bot

---

## Quick Start

### Prerequisites
- **Node.js 18+** — [https://nodejs.org](https://nodejs.org)
- **Python 3.8+** — [https://python.org](https://python.org) (check "Add to PATH" during install)

### Setup (one time)
```bash
cd kalshi-trader-app
node setup.js
```
This will check your environment, install Python dependencies, and install Electron.

### Launch
```bash
npm start
```

---

## App Layout

| View | Description |
|---|---|
| **Dashboard** | System status, quick-launch actions, strategy reference |
| **Scanner** | Live market scanner with terminal output |
| **Backtest** | Run candlestick backtests with configurable market count |
| **Logs** | View `kalshi_bot.log` activity |
| **Settings** | Edit all CONFIG values through the GUI — saves directly to `kalshi_bot.py` |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + 1–5` | Switch views (Dashboard, Scanner, Backtest, Logs, Settings) |
| `Ctrl/Cmd + K` | Stop running process |

---

## API Credentials

1. Create a Kalshi account at [https://kalshi.com](https://kalshi.com)
2. Go to Settings → API Keys → Create API Key
3. Save the `.pem` file as `kalshi_private.pem` in this folder
4. Paste your Key ID in **Settings → Authentication → API Key ID**
5. Click **Save Changes**

---

## Strategies

| Strategy | Logic | Risk |
|---|---|---|
| **SpreadGap** | YES + NO bid < $0.97, gated to 3–12h window | Low–Med |
| **Momentum** | High-volume markets trending strongly, 48h+ to expiry | Med |
| **Inplay** | Live games closing within 90 min, strong favorites | Med–High |
| **NearExpiry** | *Disabled* — backtest showed $0.06 avg P&L | — |

---

## Safety

The app enforces multiple safety layers:

- **Demo mode** is the default — paper trading only
- **Trade mode** requires explicit confirmation via modal dialog
- **Daily spend cap** prevents runaway losses
- **Per-trade contract limit** caps position size
- Config changes are saved to `kalshi_bot.py` — you can always edit the file directly

**Recommended order:**
1. Run backtest → review win rates
2. Run scanner read-only for a few days
3. Enable demo mode trading
4. Only then switch to live with $100–200

---

## Building for Distribution

To package as a standalone `.exe` / `.dmg` / `.AppImage`:

```bash
npm install -g electron-builder
npx electron-builder --config electron-builder.yml
```

Create an `electron-builder.yml`:
```yaml
appId: com.kalshi.trader
productName: Kalshi Trader
directories:
  output: dist
files:
  - "**/*"
  - "!dist/**"
mac:
  category: public.app-category.finance
win:
  target: nsis
linux:
  target: AppImage
extraResources:
  - from: "."
    to: "python"
    filter:
      - "*.py"
      - "*.pem"
      - "requirements.txt"
```

---

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main process — window management, IPC, Python spawning |
| `preload.js` | Secure IPC bridge between renderer and main process |
| `src/index.html` | App UI structure |
| `src/styles.css` | Trading terminal dark theme |
| `src/renderer.js` | UI logic, state management, event handling |
| `setup.js` | First-time setup script |
| `kalshi_bot.py` | Python market scanner + auto-trader |
| `kalshi_backtest_v2.py` | Python candlestick backtester |
| `requirements.txt` | Python dependencies |
