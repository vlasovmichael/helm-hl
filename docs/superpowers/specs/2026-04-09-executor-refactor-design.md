# Executor Refactor: Pipeline Architecture with Hooks

**Date:** 2026-04-09
**Status:** Approved
**Scope:** Split `src/modules/executor.js` (1260 lines) into modular pipeline with hook system

---

## 1. Problem Statement

The current `executor.js` is a monolith handling exchange orders, DB persistence, PnL math, Telegram notifications, and runtime state (ban maps, cooldowns) in a single 1260-line file. This blocks three planned features:

1. **AI-Advisor:** No isolated decision-making layer. Cannot insert async AI confidence check before an order without overloading execution logic.
2. **NBP Accounting:** Integrating the NBP bank API at trade close would create a dangerous dependency — if the bank API lags, the entire execution cycle hangs. Needs a separate async service.
3. **Web Dashboard:** All internal state (Maps, balances, cooldowns) is locked inside 1260 lines. Cannot cleanly expose data to an Express API without hacks.

**Goal:** Separate Information (NBP/AI), Execution (Hyperliquid), and Reporting (Dashboard/TG) so they don't block each other.

---

## 2. Approach: Pipeline with Hooks (Option B)

Split the monolith into focused modules. Add an EventEmitter-based hook system with two primitives:

- **Gate hooks** (blocking, before action): Can veto an operation. AI-Advisor subscribes here.
- **Notify hooks** (fire-and-forget, after action): Cannot block execution. NBP Accounting subscribes here.

With zero subscribers, hooks are no-ops — zero overhead for current Production.

---

## 3. File Structure

```
src/modules/executor/
  index.js           -- Public API: execute(), getRuntimeBlacklist(), on(), getStateSnapshot()
  state.js           -- 4 Maps + TTL constants + getters for Dashboard
  math.js            -- roundDown, checkSlippage, calcSize, calcPnl (pure functions)
  fill-parser.js     -- parseFillResponse, resolveAsset
  reconciler.js      -- reconcile, fetchPositionState, sleep
  paper.js           -- getPaperBalance, paperOpen, paperClose
  production.js      -- productionOpen, productionClose, productionRotate
  hooks.js           -- EventEmitter: gate() + notify() + on()
  notifications.js   -- All TG message formatting and sending
```

The old `src/modules/executor.js` file is replaced by `src/modules/executor/` directory. Since the project uses `"type": "module"` (ESM), Node.js does NOT auto-resolve `index.js` in directories. Two external imports must be updated:

- `src/index.js`: `'./modules/executor.js'` → `'./modules/executor/index.js'`
- `src/modules/scout.js`: `'./executor.js'` → `'./executor/index.js'` (imports `getRuntimeBlacklist`)

---

## 4. Module Specifications

### 4.1 state.js — Centralized State

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `RUNTIME_BAN_TTL_MS` | `const` | 30 min |
| `SLIPPAGE_BAN_TTL_MS` | `const` | 10 min |
| `REENTRY_COOLDOWN_MS` | `const` | 15 min |
| `REJECTED_ALERT_TTL_MS` | `const` | 30 min |
| `banRuntime(coin)` | `function` | Add coin to runtime blacklist |
| `banSlippage(coin)` | `function` | Add coin to slippage ban |
| `setCooldown(coin)` | `function` | Add coin to re-entry cooldown |
| `setRejectedAlert(coin)` | `function` | Record last rejected alert timestamp |
| `getLastRejectedAlert(coin)` | `function` | Get timestamp of last rejected alert |
| `getRuntimeBlacklist()` | `function` | Returns `Set<string>` of all blocked coins (auto-cleans expired) |
| `getStateSnapshot()` | `function` | Returns JSON-ready object for Dashboard |

**Dependencies:** None (zero project imports).

**`getStateSnapshot()` return shape:**

```js
{
  runtimeBans:  [{ coin, bannedAt, remainMs }],
  slippageBans: [{ coin, bannedAt, remainMs }],
  cooldowns:    [{ coin, bannedAt, remainMs }],
  blockedCoins: ["COIN1", "COIN2"],
}
```

Maps are private. Mutations only through named functions. This is the Dashboard contract.

---

### 4.2 math.js — Pure Functions

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `FEE_RATE`, `SLIPPAGE`, `ONE_LEG` | `const` | Trading fee constants |
| `BALANCE_UTILIZATION` | `const` | 0.95 |
| `MIN_ORDER_USD` | `const` | 11 |
| `MARKET_SLIPPAGE` | `const` | 0.03 |
| `SLIPPAGE_WARN_PCT`, `SLIPPAGE_BAN_PCT` | `const` | 0.5, 1.5 |
| `RECONCILIATION_TOLERANCE_PCT` | `const` | 2.0 |
| `RECONCILE_INITIAL_DELAY_MS`, `RECONCILE_RETRY_DELAY_MS`, `RECONCILE_MAX_RETRIES` | `const` | 3000, 3000, 5 |
| `roundDown(value, decimals)` | `function` | Floor to N decimal places |
| `calcSize(balance, price, szDecimals)` | `function` | Returns `{ sizeUsd, sz, tooSmall }` |
| `checkSlippage(expectedPrice, fillPrice, side)` | `function` | Returns `{ pct, absPct, warn, ban, label }` |
| `calcPnl(position, fillPrice, holdHours)` | `function` | Returns `{ pricePnl, fundingPnl, totalFee, realizedPnl }` |

**Dependencies:** None (zero project imports).

**Key change vs monolith:** `checkSlippage` is now pure — no `coin` param, no `slippageBanMap.set()`, no `logger.*`. Side effects moved to caller in `production.js`.

`calcSize` is new — consolidates the 3-step size calculation (sizeUsd, rawSz, roundDown) that was duplicated in `paperOpen` and `productionOpen`.

`calcPnl` is new — extracts the PnL formula duplicated in `productionClose` and `paperClose`.

All functions are unit-testable without mocks.

---

### 4.3 hooks.js — Extension Points

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `on(event, handler)` | `function` | Subscribe to event, returns unsubscribe function |
| `gate(event, context)` | `async function` | Blocking pre-action check. Returns `{ allowed, vetoReason? }` |
| `notify(event, context)` | `function` | Fire-and-forget post-action notification |

**Dependencies:** `logger` only.

**Two hook types:**

| | Gate | Notify |
|---|---|---|
| When | BEFORE action | AFTER action |
| Blocks? | Yes — `{ allow: false }` cancels | No — fire-and-forget |
| Error in hook | Logged, trading continues | Logged, nothing breaks |
| Future use | AI-Advisor | NBP Accounting, Dashboard |

**Gate events:**

- `beforeOpen` — context: `{ coin, price, apy, sizeUsd }`

**Notify events:**

- `afterOpen` — context: `{ coin, price, apy, sizeUsd, positionId, fill?, mode }`
- `afterClose` — context: `{ coin, pnl, holdHours, reason, fill?, mode }`
- `afterRotate` — context: `{ closeCoin, openCoin, closePnl, positionId }`
- `onError` — context: `{ operation, coin, error }`
- `stateChange` — context: `{ type, coin, data }`

**Safety:** Gate runs handlers sequentially (AI must answer before order). Notify does not await async handlers (NBP can lag 5s without blocking executor). Errors in any hook are caught and logged — never crash trading.

---

### 4.4 fill-parser.js

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `parseFillResponse(result, context)` | `function` | Parse SDK response, returns `{ ok, oid?, avgPx?, totalSz?, error? }` |
| `resolveAsset(coin)` | `function` | Returns `{ szDecimals }`, throws if not found |

**Dependencies:** `core/universe`, `state.js` (for `banRuntime`), `logger`.

`parseFillResponse` is a 1:1 move, no logic changes.

`resolveAsset` calls `banRuntime(coin)` from `state.js` instead of direct `runtimeBlacklist.set()`.

---

### 4.5 reconciler.js

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `sleep(ms)` | `function` | Promise-based delay |
| `fetchPositionState(coin)` | `async function` | Returns `{ hasPos, szi, posData }` |
| `reconcile(coin, operation, checks)` | `async function` | Background position verification (fire-and-forget) |

**Dependencies:** `exchange.js`, `math.js` (constants), `logger`.

1:1 move from monolith. Self-contained — only talks to exchange, never writes to DB or state.

---

### 4.6 notifications.js

**Exports:**

| Export | Description |
|--------|-------------|
| `notifyPaperOpen({ coin, sizeUsd, balance, price, apy, fee })` | Paper open message |
| `notifyProductionOpen({ coin, fillUsd, totalSz, avgPx, markPrice, apy, slip, effectiveLeverage, oid, dbId })` | Prod open message |
| `notifyPaperClose({ coin, holdHours, price, closePrice, pnl, fee })` | Paper close message |
| `notifyProductionClose({ coin, holdHours, entryPrice, avgPx, slip, pricePnl, fundingPnl, totalFee, realizedPnl, reason, oid })` | Prod close message |
| `notifyRotate({ closeCoin, openCoin, holdHours, closePnl, openSizeUsd, openApy, paybackHours, isProd })` | Rotate message (paper + prod unified) |
| `notifyOpenFailed({ coin, reason, critical? })` | Open failure alert |
| `notifyOpenRejected({ coin, error, sz, price, banMinutes })` | Exchange rejection alert |
| `notifyOpenSkipped({ coin, reason })` | Skipped order warning |
| `notifyCloseFailed({ coin, error, positionStillOpen })` | Close failure alert |
| `notifyExternalClose({ coin, sizeUsd, entryPrice, holdHours, estimatedPnl, equity })` | External close detection |
| `notifySlippageBan({ coin, slipLabel, banMinutes })` | Slippage ban alert |
| `notifyRotateFailed({ closeCoin, openCoin, closePnl, phase })` | Rotate failure (close phase or open phase) |

**Dependencies:** `reporter.js` (`sendMessage`) only.

Each notification is a named function with destructured params. Replaces ~25 inline `sendMessage(...)` template blocks. All TG message text lives in one file.

Paper/production rotate notifications unified into `notifyRotate` with `isProd` flag.

---

### 4.7 paper.js

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `paperOpen(coin, price, apy, silent?)` | `async function` | Open virtual position |
| `paperClose(signal, position, silent?)` | `async function` | Close virtual position |

**Dependencies:** `config`, `logger`, `database`, `wallet`, `math.js`, `notifications.js`, `hooks.js`.

Key changes:
- Size calculation via `calcSize()` instead of inline math
- PnL calculation via `calcPnl()` instead of inline math
- TG messages via `notifyPaperOpen/Close()` instead of inline templates
- `notify('afterOpen/afterClose', ...)` at the end for future hooks

---

### 4.8 production.js

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `productionOpen(coin, price, apy, silent?)` | `async function` | Open real short position |
| `productionClose(signal, position, silent?)` | `async function` | Close real position |
| `productionRotate(signal, position)` | `async function` | Atomic close + open |

**Dependencies:** All internal modules + `exchange`, `database`, `retry`.

Key changes:
- `gate('beforeOpen', ...)` inserted after leverage setup, before order placement
- `checkSlippage()` returns pure result; `banSlippage(coin)` called separately
- All TG templates replaced with `notifications.js` calls
- `notify('afterOpen/afterClose/afterRotate', ...)` at the end
- Readable ~250 lines (down from ~470)

---

### 4.9 index.js — Public Facade

**Exports:**

| Export | Type | Description |
|--------|------|-------------|
| `execute(signal, activePosition)` | `async function` | Main entry point (unchanged contract) |
| `getRuntimeBlacklist()` | `function` | Re-export from `state.js` |
| `on(event, handler)` | `function` | Re-export from `hooks.js` |
| `getStateSnapshot()` | `function` | Re-export from `state.js` |

Contains `handleOpen`, `handleClose`, `handleRotate` (paper/production routing) and inline `paperRotate`.

**External contract unchanged:** `src/index.js` does `import { execute } from './modules/executor/index.js'` — same function signature, same return values.

---

## 5. Dependency Graph

```
                    src/index.js
                        |
                        v
              executor/index.js
              +----------+----------+
              v          v          v
          paper.js  production.js  (paperRotate inline)
              |          |
              +----+-----+
              v    v     v
           math.js state.js hooks.js
                   |
              v    v          v
      fill-parser.js  reconciler.js  notifications.js
              |          |              |
              v          v              v
         core/universe  exchange.js   reporter.js
                        core/database
                        core/retry
```

**Rules:**
- `state.js`, `math.js` — zero project dependencies (leaf nodes)
- `hooks.js` — only `logger`
- `notifications.js` — only `reporter.js`
- No circular dependencies
- Arrows go strictly top-down

---

## 6. Migration Strategy: 3 PRs

### PR 1: "Extract pure modules" (low risk)

Create `src/modules/executor/` directory. Move code without logic changes:

1. `state.js` — extract Maps, TTL constants, `getRuntimeBlacklist()`
2. `math.js` — extract `roundDown`, `checkSlippage`, trading constants; add `calcSize`, `calcPnl`
3. `fill-parser.js` — extract `parseFillResponse`, `resolveAsset`
4. `reconciler.js` — extract `reconcile`, `fetchPositionState`, `sleep`
5. `notifications.js` — extract all `sendMessage(...)` blocks into named functions
6. `hooks.js` — new file, but with zero subscribers gate/notify are no-ops
7. `paper.js` — extract paper handlers, wire to new modules
8. `production.js` — extract production handlers, wire to new modules
9. `index.js` — public facade with routing

**Validation:** Run bot in PAPER mode. Verify one OPEN -> HOLD -> CLOSE cycle. Logs and TG messages must be identical to pre-refactor.

### PR 2: "Wire hooks" (medium risk)

Add `gate()` and `notify()` calls in `production.js` and `paper.js`:

1. `gate('beforeOpen', ...)` before order
2. `notify('afterOpen', ...)` after DB save
3. `notify('afterClose', ...)` after close
4. `notify('afterRotate', ...)` after rotate

With zero subscribers nothing changes — gate returns `{ allowed: true }`, notify loops over empty array.

**Validation:** PRODUCTION mode, one full cycle. Log gate() timing to confirm zero latency impact.

### PR 3: "Expose Dashboard API" (low risk)

Export `getStateSnapshot()` and `on()` from `executor/index.js`. Read-only — Production logic untouched.

### Future PRs (out of scope):

- **AI-Advisor:** `on('beforeOpen', aiAdvisorCheck)` — separate module
- **NBP Accounting:** `on('afterClose', nbpAccountingHandler)` — separate module
- **Web Dashboard:** Express server calls `getStateSnapshot()`

---

## 7. Rollback Plan

Each PR is atomic. If something breaks:

```bash
git revert <PR-merge-commit>
```

Old `executor.js` lives in git history. Worst case: `git checkout HEAD~1 -- src/modules/executor.js` and the bot works as before.

---

## 8. Success Criteria

1. All existing behavior preserved — identical logs, TG messages, DB writes
2. `executor/` directory with 9 files, none exceeding ~250 lines
3. Zero circular dependencies
4. `math.js` and `state.js` have zero project imports (testable in isolation)
5. `gate('beforeOpen')` and `notify('afterClose')` callable with zero overhead when no subscribers
6. `getStateSnapshot()` returns valid JSON for Dashboard consumption
7. PAPER and PRODUCTION modes both pass full OPEN -> HOLD -> CLOSE -> ROTATE cycles
