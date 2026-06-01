// ─────────────────────────────────────────────────
//  Candy Girl — EMA 1h-trend + 5m pullback-reclaim detector
// ─────────────────────────────────────────────────
// Pure functions для радара Candy Girl (codename «Chill Boy 2»).
// План: memory/candy_girl_idea.md.
//
// ⚠️ Candy Girl — это SIGNAL-ONLY РАДАР, НЕ торговая стратегия. Детектор только
// подсвечивает сетап (1h-тренд по EMA + откат к 5m EMA20 + reclaim), чтобы оператор
// входил руками и логировал ручные сделки. Никаких OPEN/позиций.
//
// Метод (см. coaching_session_2026_06_01): тренд по 1h, точка входа по 5m.
//   1. 1h EMA20 + EMA200 по close → тренд UP / DOWN / NONE.
//   2. 5m EMA20: цена откатывала к/за EMA20 в последних N свечах, затем последняя
//      5m close вернулась на «трендовую» сторону EMA20 (reclaim) → вход.
//   3. SL под низ отката (UP) / над верхом (DOWN); TP = R:R 2:1 от входа.
//
// Никаких side-effects, никакого I/O. Свечи (1h + 5m) передаются снаружи.

/**
 * Exponential moving average series, выровненная по входному массиву.
 * Значения до накопления `period` свечей = null. На индексе period-1 seed = SMA
 * первых `period` значений, далее классическая EMA с alpha = 2/(period+1).
 *
 * @param {number[]} values — closes, oldest→newest
 * @param {number} period
 * @returns {Array<number|null>} та же длина, что values
 */
export function emaSeries(values, period) {
  if (!Array.isArray(values) || period < 1) return [];
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const alpha = 2 / (period + 1);
  // Seed: SMA первых `period` значений.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Последнее не-null значение серии (или null). */
function lastVal(series) {
  return series.length ? series[series.length - 1] : null;
}

/**
 * Классификация 1h-тренда по EMA.
 *
 * UP   если price > emaFast > emaSlow И emaSlow растёт (slope > 0).
 * DOWN если price < emaFast < emaSlow И emaSlow падает (slope < 0).
 * иначе NONE.
 *
 * @param {Array<{close:number}>} candles1h — oldest→newest
 * @param {number} currentPrice
 * @param {{fast:number, slow:number, slopeLookback:number}} params
 * @returns {{ trend:'up'|'down'|'none', emaFast:number|null, emaSlow:number|null, slope:number|null, reason:string }}
 */
export function classifyTrend(candles1h, currentPrice, params) {
  const { fast, slow, slopeLookback } = params;
  if (!Array.isArray(candles1h) || candles1h.length < slow + slopeLookback) {
    return { trend: 'none', emaFast: null, emaSlow: null, slope: null, reason: 'insufficient_1h_history' };
  }
  const closes = candles1h.map((c) => c.close);
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const emaFast = lastVal(fastSeries);
  const emaSlow = lastVal(slowSeries);
  if (emaFast == null || emaSlow == null) {
    return { trend: 'none', emaFast, emaSlow, slope: null, reason: 'insufficient_1h_history' };
  }
  // Наклон EMA200: текущее значение vs значение slopeLookback свечей назад.
  const slowPrev = slowSeries[slowSeries.length - 1 - slopeLookback];
  const slope = slowPrev == null ? null : emaSlow - slowPrev;

  if (currentPrice > emaFast && emaFast > emaSlow && slope != null && slope > 0) {
    return { trend: 'up', emaFast, emaSlow, slope, reason: 'trend_up' };
  }
  if (currentPrice < emaFast && emaFast < emaSlow && slope != null && slope < 0) {
    return { trend: 'down', emaFast, emaSlow, slope, reason: 'trend_down' };
  }
  return { trend: 'none', emaFast, emaSlow, slope, reason: 'no_trend' };
}

/**
 * Pullback + reclaim на 5m относительно 5m EMA20.
 *
 * UP-тренд (ищем LONG):
 *   - в последних `lookback` ЗАКРЫТЫХ свечах (исключая последнюю-reclaim) цена
 *     откатывала к/ниже EMA20 (была свеча с low ≤ ema или close ≤ ema);
 *   - последняя 5m close снова ВЫШЕ EMA20 (reclaim).
 *   → entry = последняя close, swingLow = минимальный low окна отката (для SL).
 *
 * DOWN-тренд (ищем SHORT) — зеркало (откат вверх к/над EMA, reclaim вниз).
 *
 * @param {Array<{high:number,low:number,close:number}>} candles5m — oldest→newest
 * @param {'up'|'down'} trend
 * @param {{ema:number, lookback:number}} params
 * @returns {{ ok:boolean, entry:number|null, swing:number|null, ema5m:number|null, reason:string }}
 */
export function detectPullbackReclaim(candles5m, trend, params) {
  const { ema, lookback } = params;
  if (!Array.isArray(candles5m) || candles5m.length < ema + lookback + 1) {
    return { ok: false, entry: null, swing: null, ema5m: null, reason: 'insufficient_5m_history' };
  }
  const closes = candles5m.map((c) => c.close);
  const emaArr = emaSeries(closes, ema);
  const lastIdx = candles5m.length - 1;
  const ema5m = emaArr[lastIdx];
  const lastClose = closes[lastIdx];
  if (ema5m == null) {
    return { ok: false, entry: null, swing: null, ema5m: null, reason: 'insufficient_5m_history' };
  }

  // Окно отката — `lookback` свечей перед последней (reclaim) свечой.
  const start = lastIdx - lookback;
  let pulled = false;
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  for (let i = start; i < lastIdx; i++) {
    const e = emaArr[i];
    if (e == null) continue;
    const c = candles5m[i];
    if (trend === 'up') {
      if (c.low <= e || c.close <= e) pulled = true;
    } else {
      if (c.high >= e || c.close >= e) pulled = true;
    }
    if (c.low < swingLow) swingLow = c.low;
    if (c.high > swingHigh) swingHigh = c.high;
  }

  if (!pulled) {
    return { ok: false, entry: lastClose, swing: null, ema5m, reason: 'no_pullback' };
  }
  if (trend === 'up') {
    if (lastClose > ema5m) {
      return { ok: true, entry: lastClose, swing: swingLow, ema5m, reason: 'reclaim_long' };
    }
    return { ok: false, entry: lastClose, swing: swingLow, ema5m, reason: 'no_reclaim' };
  }
  // down
  if (lastClose < ema5m) {
    return { ok: true, entry: lastClose, swing: swingHigh, ema5m, reason: 'reclaim_short' };
  }
  return { ok: false, entry: lastClose, swing: swingHigh, ema5m, reason: 'no_reclaim' };
}

/**
 * Композитный сигнал Candy Girl: 1h-тренд + 5m pullback-reclaim.
 *
 * @param {Array<{high,low,close}>} candles1h — oldest→newest
 * @param {Array<{high,low,close}>} candles5m — oldest→newest
 * @param {number} currentPrice
 * @param {Object} params — { fast1h, slow1h, slopeLookback, ema5m, pullbackLookback, rr }
 * @returns {{
 *   signal:'long'|'short'|null,
 *   trend:'up'|'down'|'none',
 *   entry:number|null, sl:number|null, tp:number|null,
 *   emaFast1h:number|null, emaSlow1h:number|null, ema5m:number|null,
 *   reason:string,
 * }}
 */
export function detectCandyGirlSignal(candles1h, candles5m, currentPrice, params) {
  const {
    fast1h = 20, slow1h = 200, slopeLookback = 10,
    ema5m = 20, pullbackLookback = 6, rr = 2,
  } = params || {};

  const t = classifyTrend(candles1h, currentPrice, { fast: fast1h, slow: slow1h, slopeLookback });
  const base = {
    signal: null, trend: t.trend, entry: null, sl: null, tp: null,
    emaFast1h: t.emaFast, emaSlow1h: t.emaSlow, ema5m: null, reason: t.reason,
  };
  if (t.trend === 'none') return base;

  const pb = detectPullbackReclaim(candles5m, t.trend, { ema: ema5m, lookback: pullbackLookback });
  base.ema5m = pb.ema5m;
  if (!pb.ok) {
    base.reason = pb.reason;
    return base;
  }

  const entry = pb.entry;
  const swing = pb.swing;
  // Защита: swing должен быть «правильной» стороны от entry, иначе R:R мусорный.
  if (t.trend === 'up') {
    if (!(swing < entry)) { base.reason = 'bad_swing'; return base; }
    const risk = entry - swing;
    return {
      signal: 'long', trend: 'up', entry, sl: swing, tp: entry + rr * risk,
      emaFast1h: t.emaFast, emaSlow1h: t.emaSlow, ema5m: pb.ema5m, reason: 'signal_long',
    };
  }
  // down → short
  if (!(swing > entry)) { base.reason = 'bad_swing'; return base; }
  const risk = swing - entry;
  return {
    signal: 'short', trend: 'down', entry, sl: swing, tp: entry - rr * risk,
    emaFast1h: t.emaFast, emaSlow1h: t.emaSlow, ema5m: pb.ema5m, reason: 'signal_short',
  };
}
