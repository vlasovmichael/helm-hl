// ─────────────────────────────────────────────────
//  Candle Cache — 1h OHLC с TTL-кэшем
// ─────────────────────────────────────────────────
// Обёртка над Hyperliquid candleSnapshot для Strategy #4 (trend_follow).
// TTL 5 мин: 1ч-свечи закрываются раз в час, проверять чаще = тратить квоту API.
//
// Возвращает массив объектов {open, high, low, close, time} oldest→newest.

import { logger } from '../core/logger.js';
import { hlInfo, HL_PRIORITY } from '../core/hlClient.js';
import { resolveApiCoin } from '../core/universe.js';

const TTL_MS   = 5 * 60_000;
const INTERVAL = '1h';

// coin → { fetchedAt, candles, inflight }
const cache = new Map();

/**
 * Парсит ответ candleSnapshot в наш формат.
 * Hyperliquid возвращает поля: t (open time), c (close), h (high), l (low), o (open).
 */
function parseCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => ({
      time:  Number(c.t),
      open:  parseFloat(c.o),
      high:  parseFloat(c.h),
      low:   parseFloat(c.l),
      close: parseFloat(c.c),
    }))
    .filter((c) =>
      Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.high > 0,
    );
}

/**
 * Получает 1h свечи для монеты. С кэшем + защитой от одновременных fetch'ей.
 *
 * @param {string} coin
 * @param {number} lookbackHours — сколько часов истории нужно (минимум atrLong+1)
 * @param {number} [now=Date.now()]
 * @param {number} [priority=HL_PRIORITY.NORMAL] — LOW для косметики дашборда
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getHourlyCandles(coin, lookbackHours, now = Date.now(), priority = HL_PRIORITY.NORMAL) {
  const cached = cache.get(coin);
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.candles;
  }
  // Если уже идёт fetch — ждём его, не делаем дубль.
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackHours * 3_600_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache/${coin}`, priority },
  ).then((data) => {
    const candles = parseCandles(data);
    cache.set(coin, { fetchedAt: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => {
    cache.set(coin, { ...(cache.get(coin) || {}), inflight: null });
    logger.warn(`[CandleCache] #${coin} fetch failed: ${err.message}`);
    return null;
  });

  cache.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Очистить кэш (тесты). */
export function clearCandleCache() {
  cache.clear();
}

/** Прямая инжекция (тесты): задаёт «свежие» свечи без fetch'а. */
export function seedCandleCache(coin, candles, now = Date.now()) {
  cache.set(coin, { fetchedAt: now, candles, inflight: null });
}

// ── 5-минутные свечи (для Candy Girl радара) ────────────────────────────────
// Отдельный кэш с более коротким TTL: 5m-свечи закрываются раз в 5 мин, держим
// 60s чтобы радар видел свежий reclaim, но не молотил API каждый тик.
const FIVE_MIN_TTL_MS   = 60_000;
const FIVE_MIN_INTERVAL = '5m';
const cache5m = new Map();   // coin → { fetchedAt, candles, inflight }

/**
 * Получает 5m свечи для монеты. Зеркало getHourlyCandles, свой кэш + interval.
 *
 * @param {string} coin
 * @param {number} lookbackMinutes — сколько минут истории нужно
 * @param {number} [now=Date.now()]
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getFiveMinCandles(coin, lookbackMinutes, now = Date.now()) {
  const cached = cache5m.get(coin);
  if (cached && now - cached.fetchedAt < FIVE_MIN_TTL_MS) {
    return cached.candles;
  }
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackMinutes * 60_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: FIVE_MIN_INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache5m/${coin}` },
  ).then((data) => {
    const candles = parseCandles(data);
    cache5m.set(coin, { fetchedAt: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => {
    cache5m.set(coin, { ...(cache5m.get(coin) || {}), inflight: null });
    logger.warn(`[CandleCache5m] #${coin} fetch failed: ${err.message}`);
    return null;
  });

  cache5m.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Прямая инжекция 5m-свечей (тесты). */
export function seedFiveMinCache(coin, candles, now = Date.now()) {
  cache5m.set(coin, { fetchedAt: now, candles, inflight: null });
}

/** Очистить 5m-кэш (тесты). */
export function clearFiveMinCache() {
  cache5m.clear();
}

// ── 4-часовые свечи (для Candy Girl 4h HTF-confluence) ──────────────────────
// 4h-свеча закрывается раз в 4 часа → TTL 15 мин (тренд старшего ТФ медленный,
// частый refetch смысла не имеет). Своя карта, свой interval.
const FOUR_HOUR_TTL_MS   = 15 * 60_000;
const FOUR_HOUR_INTERVAL = '4h';
const cache4h = new Map();   // coin → { fetchedAt, candles, inflight }

/**
 * Получает 4h свечи для монеты. Зеркало getHourlyCandles, свой кэш + interval.
 *
 * @param {string} coin
 * @param {number} lookbackHours — сколько часов истории нужно
 * @param {number} [now=Date.now()]
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getFourHourCandles(coin, lookbackHours, now = Date.now()) {
  const cached = cache4h.get(coin);
  if (cached && now - cached.fetchedAt < FOUR_HOUR_TTL_MS) {
    return cached.candles;
  }
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackHours * 3_600_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: FOUR_HOUR_INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache4h/${coin}` },
  ).then((data) => {
    const candles = parseCandles(data);
    cache4h.set(coin, { fetchedAt: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => {
    cache4h.set(coin, { ...(cache4h.get(coin) || {}), inflight: null });
    logger.warn(`[CandleCache4h] #${coin} fetch failed: ${err.message}`);
    return null;
  });

  cache4h.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Прямая инжекция 4h-свечей (тесты). */
export function seedFourHourCache(coin, candles, now = Date.now()) {
  cache4h.set(coin, { fetchedAt: now, candles, inflight: null });
}

/** Очистить 4h-кэш (тесты). */
export function clearFourHourCache() {
  cache4h.clear();
}
