// ─────────────────────────────────────────────────
//  Trend-Follow ATR + Squeeze + Breakout detector
// ─────────────────────────────────────────────────
// Pure functions для Strategy #4 (codename Chill Boy, strategy_id='trend_follow').
// План: memory/trend_follow_plan.md.
//
// Сигнал на вход:
//   1. ATR(short) / ATR(long) < squeezeRatio → "squeeze" (рынок успокоился)
//   2. Цена пробила range_high(short) + ATR × multiplier → LONG breakout
//      (зеркально для SHORT через range_low - ATR × multiplier)
//
// Никаких side-effects, никакого I/O. Свечи передаются снаружи (fetch отдельный
// модуль, который кэширует candleSnapshot — это вне F.1a).

/**
 * Wilder's True Range для одной свечи.
 * @param {{high: number, low: number, close: number}} curr
 * @param {{close: number}|null} prev — null для первой свечи (TR = high - low)
 * @returns {number}
 */
export function trueRange(curr, prev) {
  const hl = curr.high - curr.low;
  if (!prev) return hl;
  const hc = Math.abs(curr.high - prev.close);
  const lc = Math.abs(curr.low - prev.close);
  return Math.max(hl, hc, lc);
}

/**
 * Simple moving ATR (среднее TR за N свечей).
 * Wilder использует EMA — но для squeeze-ratio критичен относительный показатель,
 * SMA даёт более стабильное сравнение между разными windows.
 *
 * @param {Array<{high:number, low:number, close:number}>} candles — упорядочены по времени, oldest→newest
 * @param {number} period
 * @returns {number|null} null если свечей < period+1
 */
export function atr(candles, period) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  // Берём последние `period+1` свечей: TR требует pair (curr, prev), значит на
  // `period` TR-значений нужно `period+1` свечей.
  const window = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    sum += trueRange(window[i], window[i - 1]);
  }
  return sum / period;
}

/**
 * Squeeze detector. Возвращает true если короткая ATR существенно меньше длинной.
 *
 * @param {Array} candles
 * @param {number} shortPeriod
 * @param {number} longPeriod
 * @param {number} ratio — squeeze если atrShort / atrLong < ratio
 * @returns {{ inSqueeze: boolean, atrShort: number|null, atrLong: number|null, ratio: number|null }}
 */
export function detectSqueeze(candles, shortPeriod, longPeriod, ratio) {
  const atrShort = atr(candles, shortPeriod);
  const atrLong  = atr(candles, longPeriod);
  if (atrShort === null || atrLong === null || atrLong === 0) {
    return { inSqueeze: false, atrShort, atrLong, ratio: null };
  }
  const r = atrShort / atrLong;
  return { inSqueeze: r < ratio, atrShort, atrLong, ratio: r };
}

/**
 * Range high/low за последние N свечей (исключая текущую — последнюю в массиве).
 * Текущая свеча — кандидат на breakout, её high/low в range не входит.
 *
 * @param {Array<{high:number, low:number}>} candles
 * @param {number} period
 * @returns {{ high: number, low: number }|null}
 */
export function rangeHighLow(candles, period) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const window = candles.slice(-(period + 1), -1);  // последние `period` свечей перед текущей
  let hi = -Infinity, lo = Infinity;
  for (const c of window) {
    if (c.high > hi) hi = c.high;
    if (c.low  < lo) lo = c.low;
  }
  return { high: hi, low: lo };
}

/**
 * Breakout direction на основе текущей цены, range и ATR.
 *
 * @param {number} currentPrice
 * @param {{high:number, low:number}} range
 * @param {number} atrValue
 * @param {number} multiplier — пробой = range_high + ATR × multiplier
 * @returns {'long'|'short'|null}
 */
export function breakoutDirection(currentPrice, range, atrValue, multiplier) {
  if (!range || !Number.isFinite(atrValue) || atrValue <= 0) return null;
  const longTrigger  = range.high + atrValue * multiplier;
  const shortTrigger = range.low  - atrValue * multiplier;
  if (currentPrice >= longTrigger)  return 'long';
  if (currentPrice <= shortTrigger) return 'short';
  return null;
}

/**
 * Композитный сигнал: возвращает направление если есть И squeeze И breakout.
 *
 * @param {Array} candles — 1h OHLC, oldest→newest, currentPrice — последняя close или live tick
 * @param {number} currentPrice
 * @param {Object} params — { atrShort, atrLong, squeezeRatio, breakoutMult }
 * @returns {{
 *   signal: 'long'|'short'|null,
 *   inSqueeze: boolean,
 *   atrShort: number|null,
 *   atrLong: number|null,
 *   range: {high:number, low:number}|null,
 *   reason: string,
 * }}
 */
export function detectTrendFollowSignal(candles, currentPrice, params) {
  const { atrShort, atrLong, squeezeRatio, breakoutMult } = params;

  const sq = detectSqueeze(candles, atrShort, atrLong, squeezeRatio);
  if (!sq.atrShort || !sq.atrLong) {
    return { signal: null, inSqueeze: false, atrShort: null, atrLong: null, range: null, reason: 'insufficient_history' };
  }
  if (!sq.inSqueeze) {
    return {
      signal: null, inSqueeze: false,
      atrShort: sq.atrShort, atrLong: sq.atrLong, range: null,
      reason: `no_squeeze (ratio ${sq.ratio.toFixed(2)} ≥ ${squeezeRatio})`,
    };
  }

  const range = rangeHighLow(candles, atrShort);
  if (!range) {
    return { signal: null, inSqueeze: true, atrShort: sq.atrShort, atrLong: sq.atrLong, range: null, reason: 'no_range' };
  }

  const dir = breakoutDirection(currentPrice, range, sq.atrShort, breakoutMult);
  return {
    signal: dir,
    inSqueeze: true,
    atrShort: sq.atrShort,
    atrLong:  sq.atrLong,
    range,
    reason: dir ? `breakout_${dir}` : 'in_range',
  };
}
