// ─────────────────────────────────────────────────
//  Trend EMA — EMA-хелперы для определения тренда
// ─────────────────────────────────────────────────
// Чистые функции: серия EMA и классификация тренда по паре быстрая/медленная
// плюс наклон медленной. Осталось от снятого радара Candy Girl — сам радар
// удалён 2026-08-30, а математика живая: её читают витрина Screen (HTF-тренд
// монеты) и разбор графика.

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
