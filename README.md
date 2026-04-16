# HL Funding Scanner

Autonomous funding-rate arbitrage bot for [Hyperliquid](https://hyperliquid.xyz). Shorts coins with elevated positive funding to collect hourly payments, with a secondary strategy that captures extreme funding spikes before they fade.

Built to run unattended on a VPS with a small deposit ($50-100). Every decision gate is fee-aware: the bot will refuse a trade if projected funding can't cover round-trip costs.

## How It Works

The bot runs a 15-second tick loop:

```
Scout  →  Coordinator  →  Executor
 scan       decide         trade
```

**Scout** fetches live market data from Hyperliquid (funding rates, predicted funding, prices), applies EMA smoothing (fast 3min / slow 15min), and filters through a liquidity whitelist (top-N by 24h volume).

**Coordinator** routes decisions between two strategies:

| Strategy | Signal | Hold Time | Entry Condition |
|----------|--------|-----------|-----------------|
| **Carry** (grandfather) | Stable high funding | Hours to days | APY > threshold, fee-gate < 24h breakeven |
| **Fade** | Extreme spike about to drop | 30-120 min | APY > 200%, predicted drop > 40%, fee-gate < 2h |

Single position slot. Carry has priority. If a position is open, only the strategy that opened it can manage or close it.

**Executor** handles paper and production trades, with circuit breaker, drawdown guard, volatility filter, and OI cap detection.

## Defensive Gates

The bot is conservative by design. Every entry must pass:

- **Fee-gate**: `hours_to_breakeven(apy) <= max_horizon` (won't enter if funding can't cover 0.1% round-trip)
- **Liquidity whitelist**: only top-N coins by 24h notional volume (default: top 50, $10M floor)
- **Predicted funding filter**: carry skips coins where predicted rate drops >30%; fade specifically targets them
- **Dynamic min-hold**: position must be held long enough for funding to cover its own fees
- **Funding-gate**: blocks soft exits within 10 min of hourly funding payout
- **Delist hysteresis**: 3 consecutive ticks (45s) before closing on "disappeared" coin + 30min cooldown
- **Circuit breaker**: pauses after 3 consecutive losses
- **Max drawdown**: freezes new entries if equity drops >X% from session start

## Quick Start

```bash
# Clone and install
git clone https://github.com/youruser/hl-funding-scanner.git
cd hl-funding-scanner
npm install

# Configure
cp .env.example .env
# Edit .env: set PUBLIC_WALLET_ADDRESS, adjust thresholds

# Run in paper mode (no real trades)
npm start

# Run tests
npm test
```

### Docker (recommended for production)

```bash
docker-compose up -d --build

# Logs
docker-compose logs -f --tail 100

# Dashboard
# http://localhost:3010
```

## Configuration

All settings via environment variables (see `.env.example`):

### Core Trading
| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `PAPER` | `PAPER` or `PRODUCTION` |
| `ENTRY_APY_THRESHOLD` | `40` | Minimum APY to enter (carry) |
| `MIN_APY_THRESHOLD` | `20` | Exit when slow EMA drops below this |
| `EXIT_BUFFER` | `5` | Effective exit = MIN_APY - buffer |
| `LEVERAGE` | `1` | Position leverage (1 = no leverage) |
| `FAKE_BALANCE` | _(empty)_ | Virtual balance for paper testing |

### Fade Strategy
| Variable | Default | Description |
|----------|---------|-------------|
| `FADE_ENABLED` | `true` | Enable/disable fade strategy |
| `FADE_MAX_HOLD_MINUTES` | `120` | Hard time-stop |
| `FADE_MIN_CURRENT_APY` | `200` | Minimum current APY for fade entry |
| `FADE_MIN_DROP_PCT` | `40` | Minimum predicted funding drop (%) |

### Risk Management
| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_DRAWDOWN_PCT` | `10` | Freeze new entries at -X% drawdown |
| `CB_MAX_LOSSES` | `3` | Circuit breaker: max consecutive losses |
| `CB_PAUSE_HOURS` | `2` | Pause duration after circuit breaker trips |
| `LIQUID_TOP_N` | `50` | Liquidity whitelist size |
| `LIQUID_MIN_VOLUME` | `10000000` | $10M 24h volume floor |

### Notifications
| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | _(empty)_ | Telegram bot token |
| `TELEGRAM_CHAT_ID` | _(empty)_ | Telegram chat ID |
| `SILENT_START_HOUR` | `22` | Silent mode start (no sound) |
| `SILENT_END_HOUR` | `9` | Silent mode end |

## Architecture

```
src/
  app/
    tick.js          # Main 15s loop
    alerts.js        # Anomaly, FOMO, PnL, daily/weekly/monthly recaps
    lifecycle.js     # Startup, shutdown, state persistence
    state.js         # Shared mutable state + constants
    integrity.js     # Detects positions closed externally
    status.js        # Status collector for Telegram /status
  core/
    config.js        # ENV parsing + validation
    database.js      # SQLite (better-sqlite3), positions + history
    logger.js        # Winston, env-aware (silent in tests)
    universe.js      # Shared tradeable set cache
  modules/
    scout.js         # Market data, EMA, liquidity whitelist
    strategist.js    # Carry strategy (grandfather)
    strategistFade.js # Fade strategy (predicted funding spike)
    coordinator.js   # Routes between strategies, single slot
    executor/        # Paper + production trade execution
    reporter.js      # Telegram notifications + callback polling
    dashboard/       # Express + vanilla JS status dashboard
    wallet.js        # Balance fetching
    exchange.js      # Hyperliquid SDK wrapper
    volatility.js    # Price volatility filter
```

### Database

SQLite with two tables:

- **positions**: open/closed positions with `strategy_id` (`carry` | `fade`)
- **history**: closed trades (auto-archived to `data/history_archive.json`)

Schema migration runs automatically on startup.

### Telegram Bot

The bot sends notifications for:
- Position open/close/rotate
- Anomaly alerts (APY drops >30% in one tick)
- FOMO alerts (better coin available but rotation not worth the fees)
- PnL alerts (unrealized PnL > 3% of equity)
- Daily recap (21:00), weekly (Mondays), monthly (1st)
- Circuit breaker / drawdown events

Interactive: press the "Status" button or send `/status` for a live snapshot.

## Realistic Expectations

This bot is fee-aware and won't lose money on fees. But returns scale linearly with deposit:

| Deposit | Estimated Daily (active market) | Notes |
|---------|--------------------------------|-------|
| $50 | $0.02 - $0.05 | Mostly idle in calm markets |
| $100 | $0.05 - $0.12 | Catches 1-2 trades/week |
| $500 | $0.25 - $0.60 | Starts to be meaningful |
| $1,000 | $0.50 - $1.20 | Target range for $1/day |

In quiet funding regimes (APY < 36% across all liquid coins), the bot will sit idle. This is correct behavior, not a bug.

## Tests

50 unit tests covering both strategies and the coordinator:

```bash
npm test
```

Tests use `node:test` + `node:assert/strict` (zero test dependencies). Logger is silenced via `NODE_ENV=test`.

## License

MIT
