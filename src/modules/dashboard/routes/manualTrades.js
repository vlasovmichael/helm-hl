// ─────────────────────────────────────────────────
//  Manual trades cache — reconstruct from HL userFills
// ─────────────────────────────────────────────────
// Восстанавливает ручные сделки из HL userFills (дедуп против бот-сделок по
// монете/времени/oid). Тяжёлый запрос (userFills 60d + group) — кэш 30с.
// Общий источник для /api/activity, /api/pnl-summary, /api/insights,
// /api/trade-markers и debug-эндпоинта.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { fetchUserFills, reconstructManualTrades } from "../../userFills.js";
import {
  getHistorySince,
  getArchivedHistorySince,
  getActivePosition,
  getBotOidsSince,
} from "../../../core/database.js";

const MANUAL_CACHE_TTL_MS = 30_000;
let manualCache = { ts: 0, trades: [] };

export async function getManualTrades() {
  if (!config.isProduction) return [];
  if (Date.now() - manualCache.ts < MANUAL_CACHE_TTL_MS) {
    return manualCache.trades;
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
    const trades = reconstructManualTrades(fills, botTrades, botOidSet);
    manualCache = { ts: Date.now(), trades };
    return trades;
  } catch (err) {
    logger.debug(`[Dashboard] getManualTrades failed: ${err.message}`);
    return manualCache.trades; // stale-OK
  }
}
