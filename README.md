# Helm

A trading workbench for [Hyperliquid](https://hyperliquid.xyz): I enter by hand, the bot babysits
the exit and keeps the books.

There are **no automatic entry strategies** any more. Every one that used to live here — carry,
fade, Hunter (short/long/+OI), Candy Girl, Fade-high-ER, Hot Movers, Swing — was measured on real
fills and removed once the numbers said there was no edge. What remains is the part that survived
measurement: a nanny that protects a manual position, a ledger that tells the truth from on-chain
fills, and read-only views that show data rather than signals.

Runs unattended on a small VPS against a small deposit. Read
[FREEZE.md](FREEZE.md) before proposing a new strategy — it explains why that is usually the wrong idea.

## What it does

**Adopt (the nanny).** Picks up a position I opened by hand and immediately places a reduce-only
stop on the exchange, plus a limit order at the target. It never opens anything itself. If the stop
cannot be placed, the position is *not* adopted and an urgent push says so — the bot refuses to
pretend a position is protected when it isn't.

**Ledger.** Monthly P&L rebuilt from `userFillsByTime`, split into bot / adopted / manual, with fees
and funding broken out. Click a month to expand a Mon–Sun calendar of daily results with weekly
subtotals. Past months are frozen in a snapshot; the current month is recomputed live.

**Risk rails.** Daily stop-loss (net of fees, from fills), circuit breaker after consecutive losses,
notional cap, leverage cap, blacklist. These gate the trade ticket, not just the bot.

**Views.** Screen (coins ranked by friction, not by movement), OI history, Coin of the day, the
chart-reading journal, and a coach that breaks a chart down 4h → 1h → 5m. All of them are explicitly
labelled as analysis, never as a proven-edge signal.

**Taxes.** PIT-38 summary in PLN, fed by the same fills as the ledger.

## Architecture

```
tick (15s)
  ├─ daily risk        net-of-fees day P&L → alert + entry gate
  ├─ integrity         did something close on the exchange behind our back?
  ├─ orphan check      new manual position → adopt it (stop first, then DB)
  ├─ adopt supervise   trail / breakeven ratchet on every adopted position
  └─ scan              market data for the dashboard views

ws exit loop (2s)      runs adopted positions on live WS prices, so exits do not
                       wait for the 15s tick
```

The executor is an **exit-only** path: `execute()` handles CLOSE, and OPEN is refused with a warning.
Orders are placed through `executor/triggers.js`.

Source of truth is always Hyperliquid fills, never the local `positions` table — the DB is a mirror
and mirrors drift (see the incident notes in the code).

## Quick start

```bash
npm install
cp .env.example .env      # set PUBLIC_WALLET_ADDRESS at minimum

npm test                  # 379 tests
npm run build:dash        # build the dashboard front-end
npm start                 # run the bot + dashboard on :3010
```

Front-end development with hot reload:

```bash
npm run dev:dash          # vite on :5173, proxies /api to :3010
```

### Docker (production)

```bash
docker compose up -d --build
docker compose logs -f --tail 100
```

The dashboard lives behind a Cloudflare tunnel; a second login layer switches on when
`DASHBOARD_USER` and `DASHBOARD_PASS` are set.

## Pages

| URL | What it is |
|-----|------------|
| `/` | Equity, active position, Screen, activity |
| `/ledger` | Monthly P&L + daily calendar + tax summary |
| `/statistics` | Lifetime cuts: per coin, per side, MFE/MAE, daily heatmap |
| `/oi` | Nanny panel, Coin of the day, OI history |
| `/journal` | Chart-reading drill: mark up a coin a day ahead, review it the next day |
| `/lab` | Running forward tests and closed verdicts |
| `/orderbook`, `/orderbook-sim` | Live book, and a trainer for execution cost |

Old `/page.html` addresses answer with a 301 to the clean URL.

## Configuration

Everything is environment variables; `.env.example` carries the full list with comments.
The ones that matter most:

| Variable | Default | What it controls |
|----------|---------|------------------|
| `PUBLIC_WALLET_ADDRESS` | — | Required. The account the bot reads and trades. |
| `HL_AGENT_PRIVATE_KEY` | — | Agent wallet (recommended — it cannot withdraw). |
| `ADOPT_ENABLED` | `true` | The nanny. Off means manual positions stay unprotected. |
| `ADOPT_STOP_PCT` | `5` | Stop distance when ATR is unavailable. |
| `ADOPT_TP_RR` | `1` | Target as a multiple of risk. |
| `DAILY_LOSS_LIMIT_ENABLED` | `true` | Daily stop: blocks new entries until midnight. |
| `WALLET_LEVERAGE_CAP` | — | Hard cap above whatever the exchange allows. |
| `NTFY_*` | — | Push notifications; quiet hours are respected. |

## Testing

```bash
npm test        # node:test, no framework
npm run lint    # eslint
```

`tests/imports.test.js` walks every relative import in `src/` and `tests/` and fails if one does not
resolve. It exists because a dangling import survived 378 green tests and would have taken the bot
down on start.

## What this project is not

It is not a source of income, and it is not looking for a strategy. Fees were 100% of the historical
loss; the response was fewer and larger trades by hand, with the bot doing the part I am bad at —
holding a stop and not touching the position. Numbers that could support a claim of edge get a
forward test with a pre-registered decision date, and most of them close negative. That is the point.
