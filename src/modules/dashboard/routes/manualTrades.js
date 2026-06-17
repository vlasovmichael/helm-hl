// ─────────────────────────────────────────────────
//  Round-trip cache — reconstruct from HL userFills
// ─────────────────────────────────────────────────
// Восстанавливает ВСЕ round-trip'ы (bot/adopted/manual) из HL userFills через
// единый движок reconstructRoundTrips. Тяжёлый запрос (userFills 60d + group) —
// кэш 30с. Общий источник для /api/activity, /api/pnl-summary, /api/insights,
// /api/trade-markers и debug-эндпоинта.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { fetchUserFills, reconstructRoundTrips } from "../../userFills.js";
import {
  getHistorySince,
  getArchivedHistorySince,
  getActivePosition,
  getBotOidsSince,
} from "../../../core/database.js";

const CACHE_TTL_MS = 30_000;
let cache = { ts: 0, trades: [] };

/**
 * Все round-trip'ы из fills, помеченные source (bot/adopted/manual). Единый
 * fills-источник правды для дашборда — совпадает с Monthly Ledger (ledger.js
 * дёргает тот же reconstructRoundTrips).
 */
export async function getAllRoundTrips() {
  if (!config.isProduction) return [];
  if (Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.trades;
  }
  try {
    const fills = await fetchUserFills(0); // 60d default
    // Bot trades для дедупа: все history (active + archived) + текущий open.
    const botTrades = [
      ...getHistorySince(0).map((t) => ({
        coin: t.coin,
        entry_time: t.entry_time,
        closed_at: t.closed_at,
      })),
      ...getArchivedHistorySince(0).map((t) => ({
        coin: t.coin,
        entry_time: t.entry_time,
        closed_at: t.closed_at,
      })),
    ];
    const open = getActivePosition();
    if (open)
      botTrades.push({
        coin: open.coin,
        entry_time: open.entry_time,
        closed_at: null,
        status: "OPEN",
      });
    const botOidSet = getBotOidsSince(0);
    const trades = reconstructRoundTrips(fills, botTrades, botOidSet);
    cache = { ts: Date.now(), trades };
    return trades;
  } catch (err) {
    logger.debug(`[Dashboard] getAllRoundTrips failed: ${err.message}`);
    return cache.trades; // stale-OK
  }
}

/**
 * Ручные сделки (source='manual') — обёртка над getAllRoundTrips для прежних
 * потребителей (activity, pnl-summary manual-split, trade-markers).
 */
export async function getManualTrades() {
  return (await getAllRoundTrips()).filter((t) => t.source === "manual");
}
