// ─────────────────────────────────────────────────
//  Dashboard Server — Express, localhost-only
// ─────────────────────────────────────────────────
// Слушает 127.0.0.1:3010. НЕ доступен из внешней сети.
// Никакой авторизации (доступ только с локальной машины).

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "../../core/config.js";
import { logger } from "../../core/logger.js";
import { getActivePosition, getHistorySince, getArchivedHistorySince } from "../../core/database.js";
import { getAccountSummary, getPositions } from "../exchange.js";
import { getAvailableBalance, getAccountEquity } from "../wallet.js";
import { state } from "../../app/state.js";
import { getTaxSummary } from "../taxCollector/index.js";
import { getRuntimeBlacklist } from "../executor/index.js";

const HOST = "0.0.0.0";
const PORT = 3010;

// Basic Auth: если в .env заданы DASHBOARD_USER и DASHBOARD_PASS — требуем
// логин/пароль. Иначе (default) — без auth, полагаемся на сетевой слой
// (Cloudflare Access / VPN / loopback). Удобный fallback для случаев,
// когда внешний auth-слой не настроен.
const AUTH_USER = process.env.DASHBOARD_USER || '';
const AUTH_PASS = process.env.DASHBOARD_PASS || '';
const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;

function basicAuthMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  // Constant-time compare для защиты от timing attacks
  if (header.length === expected.length) {
    let diff = 0;
    for (let i = 0; i < header.length; i++) {
      diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="HL Scanner Dashboard"');
  res.status(401).send('Authentication required');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");

let server = null;

// ─────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────

/**
 * GET /api/status
 * Текущее equity, available, активная позиция, режим, uptime.
 */
async function handleStatus(_req, res) {
  try {
    const position = getActivePosition();

    let equity = 0;
    let available = 0;
    try {
      if (config.isProduction) {
        const summary = await getAccountSummary();
        equity = summary.equity;
        available = summary.available;
      } else {
        available = await getAvailableBalance();
        equity    = await getAccountEquity();
      }
    } catch {
      // показываем 0 — UI пометит как stale
    }

    res.json({
      mode: config.mode,
      equity,
      available,
      sessionStartEquity: state.sessionStartEquity,
      sessionProfit:
        state.sessionStartEquity > 0 ? equity - state.sessionStartEquity : 0,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
      runtimeBans: [...getRuntimeBlacklist()],
      activePosition: position
        ? {
            coin: position.coin,
            sizeUsd: position.size_usd,
            entryPrice: position.entry_price,
            entryApy: position.entry_apy,
            entryTime: position.entry_time,
            heldHours: (Date.now() - position.entry_time) / 3_600_000,
          }
        : null,
      ts: Date.now(),
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/status error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/history?hours=N
 * Последние закрытые сделки за N часов + кумулятивная кривая equity.
 */
async function handleHistory(req, res) {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    const since = Date.now() - hours * 3_600_000;

    // 1. Собираем сделки из БД + Архива
    const dbRows = getHistorySince(since);
    const archRows = getArchivedHistorySince(since);

    // Объединяем и сортируем по времени (старые -> новые)
    const allTrades = [...dbRows, ...archRows]
      .sort((a, b) => a.closed_at - b.closed_at);

    // 2. Получаем ТЕКУЩЕЕ equity для точки отсчета "назад"
    let currentEquity = 0;
    try {
      if (config.isProduction) {
        const summary = await getAccountSummary();
        currentEquity = summary.equity;
      } else {
        currentEquity = await getAccountEquity();
      }
    } catch {
      currentEquity = state.sessionStartEquity || 0;
    }

    // 3. Строим кривую, работая "назад" от текущего момента
    // Нам нужно знать финальную сумму всех PnL, чтобы найти начальную точку Equity
    const totalPnlInWindow = allTrades.reduce((sum, t) => sum + t.realized_pnl, 0);
    let runningEquity = currentEquity - totalPnlInWindow;
    const baseline = runningEquity;

    const tradePoints = allTrades.map((t) => {
      runningEquity += t.realized_pnl;
      return {
        ts: t.closed_at,
        coin: t.coin,
        pnl: t.realized_pnl,
        equity: runningEquity,
        reason: t.reason,
      };
    });

    // Anchor points: даже если за окно нет сделок, рисуем плоскую линию,
    // чтобы UI не пустовал (бот может сидеть в позиции дольше окна).
    // Левый якорь — старт окна, правый — текущий момент.
    const now = Date.now();
    const points = [
      { ts: since, coin: null, pnl: 0, equity: baseline, reason: 'window_start' },
      ...tradePoints,
      { ts: now, coin: null, pnl: 0, equity: currentEquity, reason: 'now' },
    ];

    res.json({
      baseline,
      currentEquity,
      windowHours: hours,
      tradeCount: tradePoints.length,
      count: points.length,
      points,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/history error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/activity?hours=N&limit=L
 * Лента событий: открытия позиций + закрытия. Сортировка от новых к старым.
 */
function handleActivity(req, res) {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const since = Date.now() - hours * 3_600_000;

    const events = [];

    // 1. Закрытия — из БД + архива
    for (const t of getHistorySince(since)) {
      events.push({
        kind:        'close',
        ts:          t.closed_at,
        coin:        t.coin,
        pnl:         t.realized_pnl,
        reason:      t.reason,
        strategy_id: t.strategy_id || 'carry',
      });
    }
    for (const t of getArchivedHistorySince(since)) {
      events.push({
        kind:        'close',
        ts:          t.closed_at,
        coin:        t.coin,
        pnl:         t.realized_pnl,
        reason:      t.reason,
        strategy_id: t.strategy_id || 'carry',
      });
    }

    // 2. Открытие текущей активной позиции (если в окне)
    const open = getActivePosition();
    if (open && open.entry_time >= since) {
      events.push({
        kind:        'open',
        ts:          open.entry_time,
        coin:        open.coin,
        sizeUsd:     open.size_usd,
        entryPrice:  open.entry_price,
        entryApy:    open.entry_apy,
        strategy_id: open.strategy_id || 'carry',
      });
    }

    // Сортировка по убыванию + срез
    events.sort((a, b) => b.ts - a.ts);
    res.json({
      windowHours: hours,
      count:       events.length,
      events:      events.slice(0, limit),
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/activity error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/tax-summary?year=YYYY
 * PIT-38 агрегат за год: расходы, доходы, прибыль в PLN.
 */
async function handleTaxSummary(req, res) {
  try {
    const yearParam = req.query.year ? parseInt(req.query.year, 10) : null;
    const year = (yearParam && !isNaN(yearParam)) ? yearParam : new Date().getFullYear();
    const summary = await getTaxSummary(year);
    res.json(summary);
  } catch (err) {
    logger.warn(`[Dashboard] /api/tax-summary error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────
//  Lifecycle
// ─────────────────────────────────────────────────

export function startDashboard() {
  if (server) {
    logger.warn("[Dashboard] Server already running");
    return;
  }

  const app = express();

  // Auth (если включён) — раньше всех остальных middleware
  if (AUTH_ENABLED) {
    app.use(basicAuthMiddleware);
    logger.info(`[Dashboard] 🔒 Basic Auth enabled (user: ${AUTH_USER})`);
  } else {
    logger.info('[Dashboard] ⚠️  Basic Auth disabled (DASHBOARD_USER/PASS not set) — relying on network-level protection');
  }

  // Сразу запрещаем кэширование API
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/status", handleStatus);
  app.get("/api/history", handleHistory);
  app.get("/api/activity", handleActivity);
  app.get("/api/tax-summary", handleTaxSummary);

  app.use(express.static(PUBLIC_DIR));

  server = app.listen(PORT, HOST, () => {
    logger.info(`[Dashboard] ✅ Listening on http://${HOST}:${PORT}`);
  });

  server.on("error", (err) => {
    logger.error(`[Dashboard] Server error: ${err.message}`);
  });
}

export function stopDashboard() {
  if (!server) return;
  return new Promise((resolve) => {
    server.close(() => {
      logger.info("[Dashboard] ✅ Server stopped");
      server = null;
      resolve();
    });
  });
}
