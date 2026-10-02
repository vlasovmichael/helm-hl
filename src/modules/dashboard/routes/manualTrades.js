// ─────────────────────────────────────────────────
//  Round-trip cache — reconstruct from HL userFills
// ─────────────────────────────────────────────────
// Восстанавливает ВСЕ round-trip'ы (bot/adopted/manual) из HL userFills через
// единый движок reconstructRoundTrips. Общий источник для /api/activity,
// /api/pnl-summary, /api/insights, /api/trade-markers и debug-эндпоинта.
//
// Окно — с начала торговли, а не 60 дней: на коротком окне Statistics за «All»
// показывала −$47.59 против −$156.78 в Ledger, потому что ручные сделки
// апреля–июня в него не попадали. Стало возможно после пагинации fills
// (userFillsByTime отдаёт максимум 2000 за запрос). Тяжело, поэтому кэш 30с.

import { config } from "../../../core/config.js";
// Та же точка отсчёта, что у Ledger: аккаунт начал торговать 8 апреля 2026.
const TRADING_START_MS = Date.UTC(2026, 3, 1);
import { logger } from "../../../core/logger.js";
import { fetchUserFills, reconstructRoundTrips } from "../../userFills.js";
import { getFundingDeltas, tradeFunding, tradeNet } from "../../funding.js";
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
    const fills = await fetchUserFills(TRADING_START_MS);
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
    const trades = await withFunding(reconstructRoundTrips(fills, botTrades, botOidSet));
    cache = { ts: Date.now(), trades };
    return trades;
  } catch (err) {
    logger.debug(`[Dashboard] getAllRoundTrips failed: ${err.message}`);
    return cache.trades; // stale-OK
  }
}

/** Закрытым сделкам — фандинг по их монете за время удержания (поле funding). */
export function attachFunding(trades, deltas) {
  return trades.map((t) =>
    t.status === "closed"
      ? { ...t, funding: tradeFunding(deltas, t.coin, t.entryTime, t.closeTime) }
      : t,
  );
}

/**
 * Деньги закрытой DB-сделки из её round-trip'а (та же монета, close в пределах
 * tolMs). В БД realized_pnl у бота с фандингом, у adopt без него — суммы берём с биржи.
 */
export function closeMoney(trips, row, tolMs) {
  const coin = row.coin?.toUpperCase();
  const rt = trips.find(
    (t) =>
      t.status === "closed" &&
      t.coin?.toUpperCase() === coin &&
      Math.abs((t.closeTime || 0) - (row.closed_at || 0)) <= tolMs,
  );
  if (!rt) return { pnl: row.realized_pnl, fee: row.fee_paid, funding: null };
  return { pnl: tradeNet(rt), fee: rt.fee || 0, funding: rt.funding || 0 };
}

async function withFunding(trades) {
  const lastClose = trades.reduce((m, t) => Math.max(m, t.closeTime || 0), 0);
  return attachFunding(trades, await getFundingDeltas({ freshAfter: lastClose }));
}

/**
 * Ручные сделки (source='manual') — обёртка над getAllRoundTrips для прежних
 * потребителей (activity, pnl-summary manual-split, trade-markers).
 */
export async function getManualTrades() {
  return (await getAllRoundTrips()).filter((t) => t.source === "manual");
}
