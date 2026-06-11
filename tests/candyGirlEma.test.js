// Тесты ядра Candy Girl радара: EMA, классификация 1h-тренда, 5m pullback-reclaim.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  emaSeries, classifyTrend, detectPullbackReclaim, detectCandyGirlSignal,
} = await import('../src/modules/candyGirlEma.js');

// ── Helpers ────────────────────────────────────
function candle(close, spread = 1) {
  return { high: close + spread / 2, low: close - spread / 2, close };
}
/** Свечи с заданными closes; high/low = close ± spread/2. oldest→newest. */
function fromCloses(closes, spread = 1) {
  return closes.map((c) => candle(c, spread));
}
function rising(n, start, step) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function falling(n, start, step) {
  return Array.from({ length: n }, (_, i) => start - i * step);
}

// ── emaSeries ──────────────────────────────────

test('emaSeries: < period → всё null', () => {
  const s = emaSeries([1, 2, 3], 5);
  assert.deepEqual(s, [null, null, null]);
});

test('emaSeries: seed = SMA первых period, константа → ema = константа', () => {
  const s = emaSeries(Array(10).fill(100), 5);
  assert.equal(s[3], null);
  assert.equal(s[4], 100);  // seed SMA = 100
  assert.equal(s[9], 100);  // EMA константы = константа
});

test('emaSeries: на растущем ряду ema < последней цены (лаг)', () => {
  const closes = rising(30, 100, 1);
  const s = emaSeries(closes, 10);
  const last = s[s.length - 1];
  assert.ok(last < closes[closes.length - 1]);
  assert.ok(last > closes[0]);
});

// ── classifyTrend ──────────────────────────────

const TREND_PARAMS = { fast: 20, slow: 200, slopeLookback: 10 };

test('classifyTrend: мало истории → none + insufficient', () => {
  const r = classifyTrend(fromCloses(rising(50, 100, 1)), 150, TREND_PARAMS);
  assert.equal(r.trend, 'none');
  assert.equal(r.reason, 'insufficient_1h_history');
});

test('classifyTrend: растущий ряд + цена выше EMA20 → up', () => {
  const closes = rising(230, 100, 0.5);
  const candles = fromCloses(closes);
  const price = closes[closes.length - 1] + 1;  // выше последней close
  const r = classifyTrend(candles, price, TREND_PARAMS);
  assert.equal(r.trend, 'up');
  assert.ok(r.emaFast > r.emaSlow);
  assert.ok(r.slope > 0);
});

test('classifyTrend: падающий ряд + цена ниже EMA20 → down', () => {
  const closes = falling(230, 200, 0.5);
  const candles = fromCloses(closes);
  const price = closes[closes.length - 1] - 1;
  const r = classifyTrend(candles, price, TREND_PARAMS);
  assert.equal(r.trend, 'down');
  assert.ok(r.emaFast < r.emaSlow);
  assert.ok(r.slope < 0);
});

test('classifyTrend: плоский ряд → none (нет наклона/разделения EMA)', () => {
  const r = classifyTrend(fromCloses(Array(230).fill(100)), 100, TREND_PARAMS);
  assert.equal(r.trend, 'none');
});

test('classifyTrend: растущий ряд, но цена НИЖЕ EMA20 → none', () => {
  const closes = rising(230, 100, 0.5);
  const r = classifyTrend(fromCloses(closes), 100, TREND_PARAMS);  // цена у самого начала
  assert.equal(r.trend, 'none');
});

// ── detectPullbackReclaim ──────────────────────

const PB_PARAMS = { ema: 20, lookback: 6 };

// UP: ряд растёт, в окне отката пара свечей проваливается ниже EMA, последняя
// закрывается выше EMA → reclaim_long.
test('detectPullbackReclaim UP: откат ниже EMA + reclaim → ok long', () => {
  // 23 растущих + откат (4 ниже) + reclaim
  const base = rising(23, 100, 0.4);            // → ~108.8
  const dip  = [106, 104, 103, 102];            // провал ниже ema, посл. close < ema
  const reclaim = [110];                        // прыжок вверх (свежий кросс)
  const candles = fromCloses([...base, ...dip, ...reclaim], 1.5);
  const r = detectPullbackReclaim(candles, 'up', PB_PARAMS);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'reclaim_long');
  assert.equal(r.entry, 110);
  assert.ok(r.swing < r.entry);
});

test('detectPullbackReclaim UP: нет отката (монотонный рост) → no_pullback', () => {
  const candles = fromCloses(rising(30, 100, 0.5), 0.5);
  const r = detectPullbackReclaim(candles, 'up', PB_PARAMS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_pullback');
});

test('detectPullbackReclaim UP: откат есть, но последняя свеча НЕ вернулась → no_reclaim', () => {
  const base = rising(23, 100, 0.4);
  const dip  = [106, 105, 104, 103];
  const stillDown = [103];   // последняя close всё ещё ниже ema
  const candles = fromCloses([...base, ...dip, ...stillDown], 1.5);
  const r = detectPullbackReclaim(candles, 'up', PB_PARAMS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_reclaim');
});

// Регресс (2026-06-11): после reclaim'а следующая свеча НЕ должна перефаривать.
// Старая state-based логика печатала сигнал на каждой свече выше EMA → спам в
// гринде. Теперь reclaim — событие кросса: prev close уже выше EMA → нет сигнала.
test('detectPullbackReclaim UP: свеча после reclaim не перефаривает → no_reclaim', () => {
  const base = rising(23, 100, 0.4);
  const dip     = [106, 104, 103, 102];  // настоящий откат под EMA
  const reclaim = 110;                    // тут был бы сигнал
  const after   = 111;                    // следующая свеча: prev close (110) уже > EMA
  const candles = fromCloses([...base, ...dip, reclaim, after], 1.5);
  const r = detectPullbackReclaim(candles, 'up', PB_PARAMS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_reclaim');
});

test('detectPullbackReclaim DOWN: откат выше EMA + reclaim вниз → ok short', () => {
  const base = falling(23, 120, 0.4);
  const bounce = [114, 116, 117, 118];       // отскок выше ema, посл. close > ema
  const reclaim = [110];                     // возврат вниз (свежий кросс)
  const candles = fromCloses([...base, ...bounce, ...reclaim], 1.5);
  const r = detectPullbackReclaim(candles, 'down', PB_PARAMS);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'reclaim_short');
  assert.equal(r.entry, 110);
  assert.ok(r.swing > r.entry);
});

test('detectPullbackReclaim: мало 5m-истории → insufficient', () => {
  const r = detectPullbackReclaim(fromCloses(rising(10, 100, 1)), 'up', PB_PARAMS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_5m_history');
});

// ── detectCandyGirlSignal (композит) ───────────

const SIG_PARAMS = { fast1h: 20, slow1h: 200, slopeLookback: 10, ema5m: 20, pullbackLookback: 6, rr: 2 };

test('signal: нет 1h-тренда → null', () => {
  const flat1h = fromCloses(Array(230).fill(100));
  const c5m = fromCloses(rising(30, 100, 0.5));
  const r = detectCandyGirlSignal(flat1h, c5m, 100, SIG_PARAMS);
  assert.equal(r.signal, null);
});

test('signal: 1h up + 5m pullback-reclaim → long с R:R 2:1', () => {
  const c1h = fromCloses(rising(230, 100, 0.5));
  const price = 215.5;  // > последней 1h close (~214.5), up-тренд
  const base = rising(23, 200, 0.4);
  const dip  = [206, 204, 203, 202];
  const reclaim = [212];
  const c5m = fromCloses([...base, ...dip, ...reclaim], 1.5);
  const r = detectCandyGirlSignal(c1h, c5m, price, SIG_PARAMS);
  assert.equal(r.signal, 'long');
  assert.equal(r.entry, 212);
  assert.ok(r.sl < r.entry);
  // TP = entry + 2*(entry-sl)
  const risk = r.entry - r.sl;
  assert.ok(Math.abs(r.tp - (r.entry + 2 * risk)) < 1e-9);
});

test('signal: 1h down + 5m reclaim вниз → short', () => {
  const c1h = fromCloses(falling(230, 300, 0.5));
  const price = 184.5;  // < последней 1h close
  const base = falling(23, 200, 0.4);
  const bounce = [194, 196, 197, 198];
  const reclaim = [188];
  const c5m = fromCloses([...base, ...bounce, ...reclaim], 1.5);
  const r = detectCandyGirlSignal(c1h, c5m, price, SIG_PARAMS);
  assert.equal(r.signal, 'short');
  assert.equal(r.entry, 188);
  assert.ok(r.sl > r.entry);
});

// ── 4h higher-timeframe confluence ─────────────

const SIG_PARAMS_4H = {
  ...SIG_PARAMS,
  fast4h: 20, slow4h: 50, slopeLookback4h: 5, htfConfluence: true,
};

// Готовый 1h-up + 5m reclaim сетап (как в long-тесте выше).
function longSetupParts() {
  const c1h = fromCloses(rising(230, 100, 0.5));
  const base = rising(23, 200, 0.4);
  const c5m = fromCloses([...base, 206, 204, 203, 202, 212], 1.5);
  return { c1h, c5m, price: 215.5 };
}

test('signal+4h: 4h up совпадает с 1h up → long проходит', () => {
  const { c1h, c5m, price } = longSetupParts();
  const c4h = fromCloses(rising(60, 100, 1));   // 4h up-тренд
  const r = detectCandyGirlSignal(c1h, c5m, price, { ...SIG_PARAMS_4H, candles4h: c4h });
  assert.equal(r.signal, 'long');
  assert.equal(r.trend4h, 'up');
});

test('signal+4h: 4h down против 1h up → сигнал зарезан (htf_mismatch)', () => {
  const { c1h, c5m, price } = longSetupParts();
  const c4h = fromCloses(falling(60, 300, 1));  // 4h down-тренд
  const r = detectCandyGirlSignal(c1h, c5m, price, { ...SIG_PARAMS_4H, candles4h: c4h });
  assert.equal(r.signal, null);
  assert.equal(r.trend4h, 'down');
  assert.equal(r.reason, 'htf_mismatch');
});

test('signal+4h: confluence off → 4h игнорится, long проходит', () => {
  const { c1h, c5m, price } = longSetupParts();
  const c4h = fromCloses(falling(60, 300, 1));
  const r = detectCandyGirlSignal(c1h, c5m, price, { ...SIG_PARAMS_4H, htfConfluence: false, candles4h: c4h });
  assert.equal(r.signal, 'long');
});

test('signal+4h: нет 4h-свечей → back-compat, gate не применяется', () => {
  const { c1h, c5m, price } = longSetupParts();
  const r = detectCandyGirlSignal(c1h, c5m, price, SIG_PARAMS_4H);  // candles4h не передан
  assert.equal(r.signal, 'long');
  assert.equal(r.trend4h, 'none');
});
