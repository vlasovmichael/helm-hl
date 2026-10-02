// Единый источник фандинга аккаунта (HL userFunding) и net-итога сделки.
// Ledger, P&L Summary, лента и маркеры берут фандинг только отсюда.

import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../core/hlClient.js";

// Та же точка отсчёта, что у Ledger и round-trip'ов.
export const FUNDING_START_MS = Date.UTC(2026, 3, 1);
const CACHE_TTL_MS = 5 * 60_000;

let cache = { ts: 0, deltas: [] }; // deltas: [{ ts, coin, usdc }]

export function parseFundingDeltas(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map((it) => ({
      ts: it.time,
      coin: it.delta?.coin ?? null,
      usdc: parseFloat(it.delta?.usdc ?? "0"),
    }))
    .filter((x) => Number.isFinite(x.usdc) && Number.isFinite(x.ts));
}

/**
 * Все начисления фандинга с начала торговли, кэш 5 мин.
 * freshAfter: кэш старше этого момента перечитывается — у только что закрытой
 * сделки последнее начисление иначе не видно.
 */
export async function getFundingDeltas({ freshAfter = 0 } = {}) {
  if (!config.isProduction) return [];
  const age = Date.now() - cache.ts;
  if (cache.ts > 0 && age < CACHE_TTL_MS && cache.ts >= freshAfter) {
    return cache.deltas;
  }
  try {
    const data = await hlInfo(
      { type: "userFunding", user: config.wallet.address, startTime: FUNDING_START_MS },
      { label: "funding/userFunding", timeoutMs: 10_000, priority: HL_PRIORITY.LOW },
    );
    if (!Array.isArray(data)) return cache.deltas;
    cache = { ts: Date.now(), deltas: parseFundingDeltas(data) };
    return cache.deltas;
  } catch (err) {
    logger.debug(`[Funding] userFunding fetch failed: ${err.message}`);
    return cache.deltas;
  }
}

/** Сумма фандинга в [start, end]; coin — только по этой монете. */
export function sumFunding(deltas, { start = 0, end = Infinity, coin = null } = {}) {
  let sum = 0;
  for (const d of deltas) {
    if (d.ts < start || d.ts > end) continue;
    if (coin && d.coin !== coin) continue;
    sum += d.usdc;
  }
  return sum;
}

/** Фандинг, начисленный по монете сделки, пока она была открыта. */
export function tradeFunding(deltas, coin, entryTime, closeTime) {
  if (!coin || !entryTime || !closeTime) return 0;
  return sumFunding(deltas, { start: entryTime, end: closeTime, coin });
}

/** Net сделки: цена − комиссии + фандинг. pnl у round-trip'а — ДО комиссий. */
export function tradeNet(t) {
  return (t.pnl || 0) - (t.fee || 0) + (t.funding || 0);
}
