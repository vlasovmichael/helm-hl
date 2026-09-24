// ─────────────────────────────────────────────────
//  Carry — захеджированный фандинг на Hyperliquid
// ─────────────────────────────────────────────────
// Спот в лонг, перп в шорт на ту же сумму: цена гасится, остаётся фандинг,
// который платит шорт. Это единственное в проекте с CI выше нуля, и это не
// прогноз — поэтому карточка считает окупаемость, а не «сигнал».
//
// Спот-токены на HL названы не как перпы, поэтому пары заморожены по индексу
// спот-рынка, а цена сверяется при каждом расчёте: разъехалась — пара не показывается.

import { hlInfo, HL_PRIORITY } from '../core/hlClient.js';
import { config } from '../core/config.js';

const HOUR = 3_600_000;
const TTL_MS = 5 * 60_000;
const HISTORY_TTL_MS = 30 * 60_000;
const AVG_HOURS = 168;
const MIN_AVG_HOURS = 48;
const MAX_PRICE_GAP = 0.01;

/** Спот-рынок HL → перп с тем же базовым активом. */
export const SPOT_PAIRS = Object.freeze({
  "@144": "BTC",
  "@155": "ETH",
  "@109": "HYPE",
  "@160": "SOL",
  "@198": "PUMP",
  "@288": "ZEC",
});

// Базовые ставки HL, если комиссии аккаунта не прочитались.
const DEFAULT_FEES = Object.freeze({ perpTaker: 4.5, perpMaker: 1.5, spotTaker: 7, spotMaker: 4 });

const num = (v) => (v == null || v === "" ? NaN : Number(v));

/**
 * Строки карточки. Чистая функция.
 * @param {{perp: Map<string,{funding:number,mark:number}>, spot: Map<string,{mid:number,dayVolUsd:number}>,
 *          history: Map<string,number[]>, fees: typeof DEFAULT_FEES}} input
 */
export function buildCarryRows({ perp, spot, history, fees }) {
  const rows = [];
  for (const [pair, coin] of Object.entries(SPOT_PAIRS)) {
    const p = perp.get(coin);
    const s = spot.get(pair);
    if (!p || !s || !(p.mark > 0) || !(s.mid > 0)) continue;
    const gap = s.mid / p.mark - 1;
    if (Math.abs(gap) > MAX_PRICE_GAP) continue;

    const hist = (history.get(coin) || []).filter(Number.isFinite);
    const avgHourly = hist.length >= MIN_AVG_HOURS ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
    const dailyBp = avgHourly == null ? null : avgHourly * 24 * 1e4;
    const takerBp = 2 * (fees.spotTaker + fees.perpTaker);
    const makerBp = 2 * (fees.spotMaker + fees.perpMaker);
    const pays = dailyBp != null && dailyBp > 0;

    rows.push({
      coin, pair,
      aprNow: p.funding * 24 * 365 * 100,
      aprAvg: avgHourly == null ? null : avgHourly * 24 * 365 * 100,
      positiveShare: hist.length ? hist.filter((x) => x > 0).length / hist.length : null,
      hours: hist.length,
      dailyBp,
      basisBp: gap * 1e4,
      spotVolUsd: s.dayVolUsd,
      takerRoundTripBp: takerBp,
      makerRoundTripBp: makerBp,
      breakEvenDaysTaker: pays ? takerBp / dailyBp : null,
      breakEvenDaysMaker: pays ? makerBp / dailyBp : null,
      usdPerDayPer1k: dailyBp == null ? null : dailyBp * 1e-4 * 1000,
    });
  }
  return rows.sort((a, b) => (b.dailyBp ?? -Infinity) - (a.dailyBp ?? -Infinity));
}

async function loadFees() {
  try {
    const f = await hlInfo(
      { type: "userFees", user: config.wallet.address },
      { label: "carry:fees", priority: HL_PRIORITY.LOW },
    );
    const bp = (v, d) => (Number.isFinite(num(v)) ? num(v) * 1e4 : d);
    return {
      perpTaker: bp(f?.userCrossRate, DEFAULT_FEES.perpTaker),
      perpMaker: bp(f?.userAddRate, DEFAULT_FEES.perpMaker),
      spotTaker: bp(f?.userSpotCrossRate, DEFAULT_FEES.spotTaker),
      spotMaker: bp(f?.userSpotAddRate, DEFAULT_FEES.spotMaker),
      source: "account",
    };
  } catch {
    return { ...DEFAULT_FEES, source: "default" };
  }
}

let historyCache = { map: null, at: 0 };

/** Часовой фандинг за неделю по каждой монете — прямо с HL, без своих снимков. */
async function loadHistory(now) {
  if (historyCache.map && now - historyCache.at < HISTORY_TTL_MS) return historyCache.map;
  const map = new Map();
  for (const coin of new Set(Object.values(SPOT_PAIRS))) {
    try {
      const rows = await hlInfo(
        { type: "fundingHistory", coin, startTime: now - AVG_HOURS * HOUR },
        { label: "carry:history", priority: HL_PRIORITY.LOW },
      );
      map.set(coin, (rows || []).map((r) => num(r.fundingRate)).filter(Number.isFinite));
    } catch {
      // монета без истории просто покажет «—»
    }
  }
  historyCache = { map, at: now };
  return map;
}

let cache = { payload: null, at: 0 };

/** Карточка целиком, с кэшем на 5 минут. */
export async function getCarry(now = Date.now()) {
  if (cache.payload && now - cache.at < TTL_MS) return cache.payload;
  const opts = { label: "carry", priority: HL_PRIORITY.LOW };
  const [perpRes, spotRes, fees, history] = await Promise.all([
    hlInfo({ type: "metaAndAssetCtxs" }, opts),
    hlInfo({ type: "spotMetaAndAssetCtxs" }, opts),
    loadFees(),
    loadHistory(now),
  ]);

  const perp = new Map();
  (perpRes?.[0]?.universe || []).forEach((u, i) => {
    const c = perpRes[1]?.[i];
    perp.set(u.name, { funding: num(c?.funding), mark: num(c?.markPx) });
  });
  const spot = new Map();
  (spotRes?.[0]?.universe || []).forEach((u, i) => {
    const c = spotRes[1]?.[i];
    spot.set(u.name, { mid: num(c?.midPx ?? c?.markPx), dayVolUsd: num(c?.dayNtlVlm) });
  });

  const rows = buildCarryRows({ perp, spot, history, fees });
  cache = { payload: { rows, fees, avgHours: AVG_HOURS, at: now }, at: now };
  return cache.payload;
}
