"""
Kalshi Market Scanner & Trading Bot
====================================
Elegant Hospitality LLC - Jay Patel

Strategies:
  1. Spread Scanner   - finds markets where YES + NO price < $0.97 (edge gap)
  2. Mispriced Near-Expiry - finds markets close to resolution with extreme prices
  3. High Volume Momentum  - rides high-volume markets near 0 or 100

Run modes:
  python kalshi_bot.py --scan          # scan only, no trades
  python kalshi_bot.py --trade         # scan + auto-execute orders
  python kalshi_bot.py --watchlist     # monitor specific tickers only

Requirements:
  pip install requests cryptography tabulate colorama
"""

import requests
import time
import json
import argparse
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional
from tabulate import tabulate
from colorama import init, Fore, Style

# ─── RSA Auth (only needed for trading) ─────────────────────────────────────
try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    import base64, hashlib
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False

init(autoreset=True)

# ═══════════════════════════════════════════════════════════════════════════
#  CONFIGURATION  ← Edit these
# ═══════════════════════════════════════════════════════════════════════════
CONFIG = {
    # --- Auth (needed for trading, not for scanning) ---
    "api_key_id": "0c81359a-946c-4fa5-a729-e3c44f248cf7",          # from Kalshi account settings
    "private_key_path": "kalshi_private.pem", # path to your RSA private key

    # --- Environment ---
    "demo_mode": False,  # True = paper trading, False = live money

    # --- Scanner Settings ---
    "scan_interval_seconds": 30,       # scan every 30s for inplay responsiveness
    "max_markets_per_scan": 200,       # cap to avoid rate limits
    "min_volume": 50,                  # ignore markets with < N contracts traded
    "categories": [],                  # [] = all categories, or e.g. ["economics", "financials"]

    # --- Strategy Thresholds ---
    "spread_gap_threshold": 0.97,      # flag if YES_bid + NO_bid < this (e.g. 0.97 = 3¢ gap)
    "near_expiry_hours": 6,            # hours until close to flag near-expiry markets
    "momentum_min_volume": 200,        # min volume for momentum strategy

    # --- Trade Execution (only used with --trade flag) ---
    "auto_trade": True,               # safety off by default
    "max_contracts_per_trade": 10,     # max contracts to buy per signal
    "max_daily_spend": 500.00,         # max USD to spend per day
    "order_type": "limit",             # "limit" or "market"
}

DEMO_BASE  = "https://demo-api.kalshi.co/trade-api/v2"
LIVE_BASE  = "https://api.elections.kalshi.com/trade-api/v2"
BASE_URL   = DEMO_BASE if CONFIG["demo_mode"] else LIVE_BASE

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[
        logging.FileHandler("kalshi_bot.log"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger("KalshiBot")


# ═══════════════════════════════════════════════════════════════════════════
#  DATA CLASSES
# ═══════════════════════════════════════════════════════════════════════════
@dataclass
class MarketSignal:
    ticker: str
    title: str
    strategy: str
    yes_bid: float
    no_bid: float
    volume: float
    close_time: Optional[str]
    suggested_side: str   # "yes" or "no"
    suggested_price: float
    edge_score: float     # higher = better opportunity
    notes: str = ""

    def to_row(self):
        hours_left = ""
        if self.close_time:
            try:
                ct = datetime.fromisoformat(self.close_time.replace("Z", "+00:00"))
                diff = (ct - datetime.now(timezone.utc)).total_seconds() / 3600
                hours_left = f"{diff:.1f}h"
            except:
                hours_left = "?"
        return [
            self.ticker[:30],
            self.strategy,
            f"${self.yes_bid:.2f}",
            f"${self.no_bid:.2f}",
            f"{self.volume:,.0f}",
            hours_left,
            self.suggested_side.upper(),
            f"${self.suggested_price:.2f}",
            f"{self.edge_score:.3f}",
            self.notes[:40],
        ]


# ═══════════════════════════════════════════════════════════════════════════
#  API CLIENT
# ═══════════════════════════════════════════════════════════════════════════
class KalshiClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self._token = None
        self._token_expiry = 0
        self.daily_spend = 0.0

    def _get(self, path, params=None):
        url = f"{BASE_URL}{path}"
        try:
            r = self.session.get(url, params=params, timeout=10)
            r.raise_for_status()
            return r.json()
        except requests.HTTPError as e:
            log.error(f"HTTP {r.status_code} on GET {path}: {r.text[:200]}")
            return None
        except Exception as e:
            log.error(f"GET {path} failed: {e}")
            return None

    def _post(self, path, body):
        url = f"{BASE_URL}{path}"
        try:
            r = self.session.post(url, json=body, timeout=10)
            r.raise_for_status()
            return r.json()
        except requests.HTTPError as e:
            log.error(f"HTTP {r.status_code} on POST {path}: {r.text[:200]}")
            return None

    # ── Auth ──────────────────────────────────────────────────────────────
    def login(self):
        """
        Kalshi uses RSA-PSS signed requests for auth.
        For simplicity this uses the API key header method.
        """
        key_id = CONFIG["api_key_id"]
        if key_id == "YOUR_API_KEY_ID":
            log.warning("API key not configured — running in read-only mode.")
            return False
        if not CRYPTO_AVAILABLE:
            log.error("cryptography package not installed. Run: pip install cryptography")
            return False
        try:
            with open(CONFIG["private_key_path"], "rb") as f:
                private_key = serialization.load_pem_private_key(f.read(), password=None)
            self._private_key = private_key
            self._api_key_id  = key_id
            self.session.headers.update({"KALSHI-ACCESS-KEY": key_id})
            log.info(f"Auth configured for key: {key_id[:12]}...")
            return True
        except FileNotFoundError:
            log.error(f"Private key not found: {CONFIG['private_key_path']}")
            return False

    def _sign_request(self, method, path, body_str=""):
        """
        Add RSA-PSS signature headers to request.
        Kalshi signing spec: message = timestamp + METHOD + path
        No body included. Salt length = MAX_LENGTH.
        """
        if not hasattr(self, "_private_key"):
            return
        ts  = str(int(time.time() * 1000))
        msg = (ts + method.upper() + "/trade-api/v2" + path).encode()
        sig = self._private_key.sign(msg, padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH
        ), hashes.SHA256())
        self.session.headers.update({
            "KALSHI-ACCESS-TIMESTAMP": ts,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        })

    # ── Market Data ───────────────────────────────────────────────────────
    def get_markets(self, limit=200, status="open", category=None, cursor=None):
        params = {"limit": limit, "status": status}
        if category:
            params["category"] = category
        if cursor:
            params["cursor"] = cursor
        return self._get("/markets", params)

    def get_all_quality_markets(self, limit=200):
        """
        Fetch real tradeable markets by targeting specific series directly.
        Kalshi's general market feed is dominated by MVE parlays and
        zero-volume player props. Targeting series by ticker is the only
        reliable way to find real game-outcome and prediction markets.
        """
        # Verified active series from live API diagnose — sorted by priority
        TARGET_SERIES = [
            # ── Sports game winners (real volume, real prices) ───────────
            "KXNBAGAME",      # NBA game winner
            "KXNBATOTAL",     # NBA game total points
            "KXNBAPTS",       # NBA player points
            "KXNBA3QTOTAL",   # NBA 3rd quarter total
            "KXMLBGAME",      # MLB game winner
            "KXMLBTOTAL",     # MLB game total runs
            "KXNHLGAME",      # NHL game winner
            "KXNHLTOTAL",     # NHL game total goals
            "KXNHLGOALS",     # NHL player goals
            "KXNFLGAME",      # NFL game winner (in season)
            "KXNFLTOTAL",     # NFL game total
            "KXNFLSPREAD",    # NFL spread
            "KXNFLGAMETD",    # NFL touchdowns
            "KXNCAABBGAME",   # NCAA basketball game winner
            "KXNCAAWBTOTAL",  # NCAA women's basketball total
            "KXCS2MAP",       # CS2 esports map winner
            "KXUFC",          # UFC fight winner
            "KXBOXING",       # Boxing match winner
            # ── Economics / Financial ────────────────────────────────────
            "KXCPI",          # CPI inflation    e.g. yes=0.13 no=0.82
            "KXNASDAQ100",    # Nasdaq range     vol=672
            "PCECORE",        # Core PCE inflation
            "KXPCE",          # PCE inflation
            "KXFED",          # Fed rate decision
            "KXUNRATE",       # Unemployment rate
            "KXGOLD",         # Gold price
            "KXOIL",          # Oil price
            "KXGBPUSD",       # GBP/USD exchange rate
            "KXTREASURYMAX5", # Treasury yield
            # ── Crypto (daily/weekly — not expiring-soon hourly) ─────────
            "KXBTCY",         # Bitcoin price end of year
            "KXBTCDOM",       # Bitcoin dominance
            "KXETH",          # Ethereum (daily)
            # ── Politics ─────────────────────────────────────────────────
            "KXTRUMP",        # Trump approval/actions
            "APRPOTUS",       # Presidential approval rating
            "KXGOP",          # Republican party markets
            "KXDEM",          # Democratic party markets
            "KXSENATE",       # Senate markets
        ]

        markets = []
        seen    = set()

        def add(raw):
            for m in raw:
                t = m.get("ticker","")
                if t in seen: continue
                if m.get("mve_collection_ticker"): continue
                seen.add(t)
                markets.append(m)

        # Fetch from each series
        for series in TARGET_SERIES:
            if len(markets) >= limit: break
            data = self._get("/markets", {
                "limit": 100, "status": "open",
                "series_ticker": series
            })
            if data and data.get("markets"):
                add(data["markets"])
            time.sleep(0.25)

        log.info(f"Fetched {len(markets)} open markets from {len(TARGET_SERIES)} series")
        return markets[:limit]

    def get_orderbook(self, ticker):
        return self._get(f"/markets/{ticker}/orderbook")

    def get_balance(self):
        self._sign_request("GET", "/portfolio/balance")
        return self._get("/portfolio/balance")

    def get_positions(self):
        self._sign_request("GET", "/portfolio/positions")
        return self._get("/portfolio/positions")

    def get_settlements(self):
        """Fetch TODAY's settled positions only and return total winnings."""
        self._sign_request("GET", "/portfolio/settlements")
        data = self._get("/portfolio/settlements")
        if not data:
            return 0.0

        # Only count settlements from today (UTC date)
        today = datetime.now(timezone.utc).date()
        total_won = 0.0
        settlements = data.get("settlements", [])

        for s in settlements:
            # Check settlement date
            settled_at = s.get("settled_time") or s.get("created_time") or ""
            if settled_at:
                try:
                    settled_date = datetime.fromisoformat(
                        settled_at.replace("Z", "+00:00")
                    ).date()
                    if settled_date != today:
                        continue  # skip — not today
                except:
                    continue

            # revenue = payout on winning positions
            revenue = float(s.get("revenue_dollars") or
                           (s.get("revenue", 0) or 0) / 100)
            if revenue > 0:
                total_won += revenue

        return total_won

    def get_net_daily_spend(self):
        """
        Net spend = gross spend - winnings settled today.
        Winnings directly offset the daily spend counter so the
        bot keeps trading as long as net spend < max_daily_spend.
        """
        winnings = self.get_settlements()
        # Track highest winnings seen to avoid double-counting
        if not hasattr(self, "_last_winnings"):
            self._last_winnings = 0.0
        net = max(0.0, self.daily_spend - winnings)
        if winnings > self._last_winnings:
            new_wins = winnings - self._last_winnings
            self._last_winnings = winnings
            log.info(f"New winnings: ${new_wins:.2f} | Total won today: ${winnings:.2f} | Net spend: ${net:.2f} / ${CONFIG['max_daily_spend']:.2f}")
        return net, winnings

    # ── Order Execution ───────────────────────────────────────────────────
    def place_order(self, ticker, side, price_cents, count, order_type="limit"):
        """
        ticker     : market ticker e.g. "KXHIGHNY-23DEC31-T50"
        side       : "yes" or "no"
        price_cents: integer 1–99
        count      : number of contracts
        """
        # Kalshi requires exactly ONE of yes_price or no_price
        # Price must be in cents (integer 1-99)
        if side == "yes":
            price_field = {"yes_price": price_cents}
        else:
            price_field = {"no_price": price_cents}

        body = {
            "ticker": ticker,
            "action": "buy",
            "side":   side,
            "type":   order_type,
            "count":  count,
            **price_field,
        }
        body_str = json.dumps(body)
        self._sign_request("POST", "/portfolio/orders")
        result = self._post("/portfolio/orders", body)
        if result:
            cost = (price_cents / 100) * count
            self.daily_spend += cost
            log.info(f"ORDER PLACED: {ticker} {side.upper()} x{count} @ {price_cents}¢  cost=${cost:.2f}")
        return result


# ═══════════════════════════════════════════════════════════════════════════
#  STRATEGIES
# ═══════════════════════════════════════════════════════════════════════════
class Scanner:
    def __init__(self, client: KalshiClient):
        self.client = client
        self.signals: list[MarketSignal] = []

    def fetch_all_markets(self):
        """Fetch quality open markets — skips MVE sports parlays."""
        markets = self.client.get_all_quality_markets(
            limit=CONFIG["max_markets_per_scan"]
        )
        log.info(f"Fetched {len(markets)} open markets (non-MVE, priced)")
        return markets

    def _parse_price(self, m, key):
        """
        Safely parse price fields.
        Kalshi API returns prices as yes_bid_dollars, no_bid_dollars etc.
        Try _dollars suffix first, then plain key as fallback.
        """
        val = m.get(key + "_dollars") or m.get(key)
        if val is None:
            return None
        try:
            return float(val)
        except:
            return None

    # ── Strategy 1: Spread Gap ─────────────────────────────────────────────
    def strategy_spread_gap(self, markets):
        """
        Backtest result: only profitable within 3–12 hours of expiry.
        Early signals (>12h) had a 20-28% win rate — actively losing.
        Gate: only fire when 3h <= time_to_close <= 12h.
        """
        signals = []
        for m in markets:
            vol = float(m.get("volume_fp", 0) or m.get("volume", 0) or 0)
            if vol < CONFIG["min_volume"]:
                continue

            # ── TIME GATE: 3–12 hours to expiry only ──
            close_time = m.get("close_time")
            if not close_time:
                continue
            try:
                ct = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
                hours_left = (ct - datetime.now(timezone.utc)).total_seconds() / 3600
            except:
                continue
            if hours_left < 1.0 or hours_left > 12.0:
                continue

            yes_bid = self._parse_price(m, "yes_bid")
            no_bid  = self._parse_price(m, "no_bid")
            if yes_bid is None or no_bid is None:
                continue
            total = yes_bid + no_bid
            if total < CONFIG["spread_gap_threshold"]:
                gap = 1.0 - total
                if yes_bid <= no_bid:
                    side, price = "yes", yes_bid
                else:
                    side, price = "no", no_bid
                signals.append(MarketSignal(
                    ticker=m["ticker"],
                    title=m.get("title", "")[:60],
                    strategy="SpreadGap",
                    yes_bid=yes_bid,
                    no_bid=no_bid,
                    volume=vol,
                    close_time=close_time,
                    suggested_side=side,
                    suggested_price=price,
                    edge_score=gap * (1 / max(hours_left, 1)),
                    notes=f"gap={gap:.3f} {hours_left:.1f}h left"
                ))
        log.info(f"SpreadGap: {len(signals)} signals")
        return signals

    # ── Strategy 2: Near-Expiry ── DISABLED ──────────────────────────────
    def strategy_near_expiry(self, markets):
        """
        Backtest result: 7/7 wins but avg P&L only $0.06/trade.
        Entries at $0.88-$0.99 leave almost no upside.
        Disabled — not worth the capital allocation.
        """
        log.info("NearExpiry: disabled (backtest showed insufficient upside)")
        return []

    # ── Strategy 3: High Volume Momentum ──────────────────────────────────
    def strategy_momentum(self, markets):
        """
        Backtest result: 88.9% win rate when 48h+ to expiry.
        Only 66.7% at 12-48h. Gate: require >= 48 hours remaining.
        Logic: market has already decided direction early — ride it.
        """
        signals = []
        for m in markets:
            vol = float(m.get("volume_fp", 0) or m.get("volume", 0) or 0)
            if vol < CONFIG["momentum_min_volume"]:
                continue

            # ── TIME GATE: 48h+ to expiry only ──
            close_time = m.get("close_time")
            if not close_time:
                continue
            try:
                ct = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
                hours_left = (ct - datetime.now(timezone.utc)).total_seconds() / 3600
            except:
                continue
            if hours_left < 6.0:
                continue

            yes_bid = self._parse_price(m, "yes_bid")
            if yes_bid is None:
                continue
            no_bid = self._parse_price(m, "no_bid") or (1.0 - yes_bid)

            # Strong YES momentum: YES > 0.85, high volume
            if yes_bid > 0.85:
                signals.append(MarketSignal(
                    ticker=m["ticker"],
                    title=m.get("title", "")[:60],
                    strategy="Momentum-YES",
                    yes_bid=yes_bid,
                    no_bid=no_bid,
                    volume=vol,
                    close_time=close_time,
                    suggested_side="yes",
                    suggested_price=yes_bid,
                    edge_score=(yes_bid - 0.85) * (vol / 10000),
                    notes=f"vol={vol:,.0f} {hours_left:.0f}h left"
                ))
            # Strong NO momentum: YES < 0.15
            elif yes_bid < 0.15:
                signals.append(MarketSignal(
                    ticker=m["ticker"],
                    title=m.get("title", "")[:60],
                    strategy="Momentum-NO",
                    yes_bid=yes_bid,
                    no_bid=no_bid,
                    volume=vol,
                    close_time=close_time,
                    suggested_side="no",
                    suggested_price=no_bid,
                    edge_score=(0.15 - yes_bid) * (vol / 10000),
                    notes=f"vol={vol:,.0f}"
                ))
        log.info(f"Momentum: {len(signals)} signals")
        return signals

    # ── Strategy 4: Inplay — closing in 30–60 mins ────────────────────────
    def strategy_live_game(self, markets):
        """
        Inplay strategy — targets markets closing within 60 minutes.
        These are live games in the final quarter/period where
        one team has already taken control. Fires continuously
        as new markets enter the 30–60 min window every scan.

        Thresholds intentionally loose — at 60 mins out, even a
        $0.70 favorite represents a strong in-game position.
        """
        signals = []
        for m in markets:
            vol = float(m.get("volume_fp", 0) or m.get("volume", 0) or 0)
            if vol < 20:
                continue

            close_time = m.get("close_time")
            if not close_time:
                continue
            try:
                ct = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
                mins_left = (ct - datetime.now(timezone.utc)).total_seconds() / 60
            except:
                continue

            # Target: closing in 2–90 minutes
            if mins_left < 2 or mins_left > 90:
                continue

            yes_bid = self._parse_price(m, "yes_bid")
            no_bid  = self._parse_price(m, "no_bid")
            if yes_bid is None or no_bid is None:
                continue

            # Meaningful favorite — lowered bar to catch more live games
            if yes_bid > 0.65:
                signals.append(MarketSignal(
                    ticker=m["ticker"],
                    title=m.get("title", "")[:60],
                    strategy="Inplay-YES",
                    yes_bid=yes_bid,
                    no_bid=no_bid,
                    volume=vol,
                    close_time=close_time,
                    suggested_side="yes",
                    suggested_price=yes_bid,
                    edge_score=(yes_bid - 0.65) * (vol / 500),
                    notes=f"{mins_left:.0f}min left vol={vol:,.0f}"
                ))
            elif yes_bid < 0.35:
                signals.append(MarketSignal(
                    ticker=m["ticker"],
                    title=m.get("title", "")[:60],
                    strategy="Inplay-NO",
                    yes_bid=yes_bid,
                    no_bid=no_bid,
                    volume=vol,
                    close_time=close_time,
                    suggested_side="no",
                    suggested_price=no_bid,
                    edge_score=(0.35 - yes_bid) * (vol / 500),
                    notes=f"{mins_left:.0f}min left vol={vol:,.0f}"
                ))
        log.info(f"Inplay: {len(signals)} signals")
        return signals

    # ── Run All Strategies ─────────────────────────────────────────────────
    def run_scan(self):
        markets = self.fetch_all_markets()
        if not markets:
            log.warning("No markets returned — check API or rate limits.")
            return []

        all_signals = []
        all_signals += self.strategy_spread_gap(markets)
        all_signals += self.strategy_near_expiry(markets)
        all_signals += self.strategy_momentum(markets)
        all_signals += self.strategy_live_game(markets)

        # Sort by edge score descending
        all_signals.sort(key=lambda s: s.edge_score, reverse=True)
        self.signals = all_signals
        return all_signals


# ═══════════════════════════════════════════════════════════════════════════
#  DISPLAY
# ═══════════════════════════════════════════════════════════════════════════
def print_signals(signals: list[MarketSignal], top_n=20):
    if not signals:
        print(Fore.YELLOW + "No signals found this scan.")
        return

    headers = ["Ticker", "Strategy", "YES Bid", "NO Bid", "Volume",
               "Expires", "Side", "Price", "Edge", "Notes"]
    rows = [s.to_row() for s in signals[:top_n]]

    print(Fore.CYAN + f"\n{'═'*120}")
    print(Fore.CYAN + f"  KALSHI SCANNER  —  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  —  {len(signals)} signals found")
    print(Fore.CYAN + f"{'═'*120}")
    print(tabulate(rows, headers=headers, tablefmt="rounded_outline"))
    print()


def print_balance(client: KalshiClient):
    data = client.get_balance()
    if data:
        bal = float(data.get("balance_dollars", 0) or
                   (data.get("balance", 0) or 0) / 100)
        net_spend, winnings = client.get_net_daily_spend()
        won_str = f"  Won today: ${winnings:.2f}" if winnings > 0 else ""
        print(Fore.GREEN + f"  Account Balance: ${bal:.2f}  |  "
              f"Gross Spend: ${client.daily_spend:.2f}  |  "
              f"Net Spend: ${net_spend:.2f} / ${CONFIG['max_daily_spend']:.2f}"
              + (Fore.CYAN + won_str if winnings > 0 else ""))


# ═══════════════════════════════════════════════════════════════════════════
#  AUTO EXECUTION
# ═══════════════════════════════════════════════════════════════════════════
def execute_signals(client: KalshiClient, signals: list[MarketSignal]):
    """Execute top signals if auto_trade is enabled and budget allows."""
    if not CONFIG["auto_trade"]:
        return

    # Net spend = gross spend minus any winnings settled today
    net_spend, winnings = client.get_net_daily_spend()

    executed = 0
    for sig in signals[:10]:  # max 10 trades per scan
        if net_spend >= CONFIG["max_daily_spend"]:
            log.warning(f"Daily net spend limit reached "
                        f"(${net_spend:.2f} net / ${winnings:.2f} won today) "
                        f"— no more trades today.")
            break
        if sig.edge_score < 0.02:  # minimum edge to trade
            continue

        price_cents = int(sig.suggested_price * 100)
        if price_cents < 1 or price_cents > 99:
            continue

        contracts = CONFIG["max_contracts_per_trade"]
        cost = (price_cents / 100) * contracts
        if net_spend + cost > CONFIG["max_daily_spend"]:
            contracts = int((CONFIG["max_daily_spend"] - net_spend) / (price_cents / 100))
            if contracts < 1:
                break

        result = client.place_order(
            ticker=sig.ticker,
            side=sig.suggested_side,
            price_cents=price_cents,
            count=contracts,
            order_type=CONFIG["order_type"]
        )
        if result:
            executed += 1
            print(Fore.GREEN + f"  ✓ Executed: {sig.ticker} {sig.suggested_side.upper()} x{contracts} @ {price_cents}¢")

    if executed == 0:
        print(Fore.YELLOW + "  No trades executed this cycle.")


# ═══════════════════════════════════════════════════════════════════════════
#  MAIN LOOP
# ═══════════════════════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(description="Kalshi Trading Bot")
    parser.add_argument("--scan",      action="store_true", help="Scan only, no trades")
    parser.add_argument("--trade",     action="store_true", help="Scan + execute trades")
    parser.add_argument("--once",      action="store_true", help="Run one scan and exit")
    parser.add_argument("--diagnose", action="store_true", help="Show raw market sample and exit")
    parser.add_argument("--watchlist", nargs="+", metavar="TICKER", help="Monitor specific tickers")
    args = parser.parse_args()

    if args.trade:
        CONFIG["auto_trade"] = True
        print(Fore.RED + "⚠  TRADE MODE ACTIVE — real orders will be placed")
    else:
        print(Fore.YELLOW + "  SCAN MODE — read only, no orders")

    env = "DEMO" if CONFIG["demo_mode"] else "LIVE"
    print(Fore.CYAN + f"  Environment: {env}  |  Base URL: {BASE_URL}\n")

    client = KalshiClient()
    authenticated = client.login()

    if authenticated and args.trade:
        print_balance(client)

    scanner = Scanner(client)

    # ── Diagnose mode: show raw market data sample ──────────────────────
    if hasattr(args, 'diagnose') and args.diagnose:
        print(Fore.CYAN + "\n  Fetching all active Kalshi series...")
        # Get all series with volume
        # Show what each series returns
        print(Fore.CYAN + "  Testing each series for open markets...\n")
        # Use same list as get_all_quality_markets
        TEST_SERIES = [
            "KXBTC","KXETH","KXNASDAQ100","KXINXW","KXCPI","PCECORE",
            "KXTRUMP","APRPOTUS","KXNBAGAMES","KXNBA3QTOTAL","KXNBA",
            "KXNBAGAME","KXNFLGAMETD","KXNFL","KXNFLGAME",
            "KXMLBSERIES","KXMLBGAME","KXMLB","KXMLBTB","KXMLBHRR",
            "KXNHL","KXNHLGAME","KXNCAABBGAME","KXNCAABB",
            "KXNASCARTOP3","KXCS2MAP","KXTEMPNYCH","KXALBUMSALES",
        ]
        found_any = False
        for series in TEST_SERIES:
            data = client._get("/markets", {"limit":10,"status":"open","series_ticker":series})
            mlist = data.get("markets",[]) if data else []
            if mlist:
                found_any = True
                m0 = mlist[0]
                yb  = float(m0.get("yes_bid_dollars") or m0.get("yes_bid") or 0)
                nb  = float(m0.get("no_bid_dollars")  or m0.get("no_bid") or 0)
                vol = float(m0.get("volume_fp") or m0.get("volume") or 0)
                print(Fore.GREEN + f"  {series:25} {len(mlist):3} markets  "
                      f"yes={yb:.2f} no={nb:.2f} vol={vol:,.0f}  "
                      f"e.g. {m0.get('ticker','')[:35]}")
            time.sleep(0.25)
        if not found_any:
            print(Fore.RED + "  No open markets found in any known series.")
            print(Fore.YELLOW + "  It may be too early in the day — try again after noon.")
        return

    while True:
        try:
            print(Fore.WHITE + f"\n[{datetime.now().strftime('%H:%M:%S')}] Running scan...")
            signals = scanner.run_scan()
            print_signals(signals)

            if authenticated and args.trade:
                execute_signals(client, signals)
                print_balance(client)

            if args.once:
                break

            print(Fore.WHITE + f"  Next scan in {CONFIG['scan_interval_seconds']}s...  (Ctrl+C to stop)\n")
            time.sleep(CONFIG["scan_interval_seconds"])

        except KeyboardInterrupt:
            print(Fore.YELLOW + "\n  Bot stopped by user.")
            break
        except Exception as e:
            log.error(f"Scan loop error: {e}", exc_info=True)
            time.sleep(10)


if __name__ == "__main__":
    main()
