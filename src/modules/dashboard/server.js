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
import { getAvailableBalance } from "../wallet.js";
import { state } from "../../app/state.js";
import { getTaxSummary } from "../taxCollector/index.js";
import { getRuntimeBlacklist } from "../executor/index.js";

const HOST = "0.0.0.0";
const PORT = 3010;

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
        equity = available;
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
        currentEquity = await getAvailableBalance();
      }
    } catch {
      currentEquity = state.sessionStartEquity || 0;
    }

    // 3. Строим кривую, работая "назад" от текущего момента
    // Нам нужно знать финальную сумму всех PnL, чтобы найти начальную точку Equity
    const totalPnlInWindow = allTrades.reduce((sum, t) => sum + t.realized_pnl, 0);
    let runningEquity = currentEquity - totalPnlInWindow;
    const baseline = runningEquity;

    const points = allTrades.map((t) => {
      runningEquity += t.realized_pnl;
      return {
        ts: t.closed_at,
        coin: t.coin,
        pnl: t.realized_pnl,
        equity: runningEquity,
        reason: t.reason,
      };
    });

    res.json({
      baseline,
      currentEquity,
      windowHours: hours,
      count: points.length,
      points,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/history error: ${err.message}`);
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

  // Сразу запрещаем кэширование API
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/status", handleStatus);
  app.get("/api/history", handleHistory);
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
