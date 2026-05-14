// Тесты ядра Strategy #4 (trend_follow / Chill Boy): ATR, squeeze, breakout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  trueRange, atr, detectSqueeze, rangeHighLow,
  breakoutDirection, detectTrendFollowSignal,
} = await import('../src/modules/trendFollowAtr.js');

// ── Helpers ────────────────────────────────────
function candle(high, low, close) {
  return { high, low, close };
}
function flatCandles(n, price, hlSpread = 1) {
  // Свечи с одинаковой ценой и фиксированным high-low spread — нулевая трендовая, низкая vol.
  return Array.from({ length: n }, () =>
    candle(price + hlSpread / 2, price - hlSpread / 2, price),
  );
}
function noisyCandles(n, price, hlSpread = 10) {
  return Array.from({ length: n }, () =>
    candle(price + hlSpread / 2, price - hlSpread / 2, price),
  );
}

// ── trueRange ──────────────────────────────────

test('trueRange: первая свеча (нет prev) → high - low', () => {
  const tr = trueRange(candle(110, 100, 105), null);
  assert.equal(tr, 10);
});

test('trueRange: gap up — учитывает prev.close', () => {
  // prev.close=100, curr.high=120, curr.low=115. TR = max(5, 20, 15) = 20.
  const tr = trueRange(candle(120, 115, 118), { close: 100 });
  assert.equal(tr, 20);
});

test('trueRange: gap down', () => {
  // prev.close=100, curr.high=90, curr.low=80. TR = max(10, 10, 20) = 20.
  const tr = trueRange(candle(90, 80, 85), { close: 100 });
  assert.equal(tr, 20);
});

// ── atr ────────────────────────────────────────

test('atr: недостаточно свечей → null', () => {
  assert.equal(atr(flatCandles(5, 100, 1), 10), null);
});

test('atr: ровные свечи hl=2 → atr ≈ 2', () => {
  const a = atr(flatCandles(25, 100, 2), 20);
  assert.equal(a, 2);
});

test('atr: больший spread → бОльший ATR', () => {
  const calm  = atr(flatCandles(25, 100, 1), 20);
  const wild  = atr(flatCandles(25, 100, 10), 20);
  assert.ok(wild > calm * 5);
});

// ── detectSqueeze ──────────────────────────────

test('squeeze: одинаковая vol по short+long → ratio≈1, not in squeeze', () => {
  const sq = detectSqueeze(flatCandles(60, 100, 2), 20, 50, 0.7);
  assert.equal(sq.inSqueeze, false);
  assert.ok(sq.ratio > 0.9 && sq.ratio < 1.1);
});

test('squeeze: успокоение (последние 20 узкие, до того широкие) → ratio < 0.7', () => {
  // 50 широких + 25 узких (last 25, чтобы и shortPeriod+1=21 точно влез в "узкую" часть).
  const wide   = noisyCandles(50, 100, 10);   // high-low = 10
  const narrow = flatCandles(25, 100, 1);     // high-low = 1
  const sq = detectSqueeze([...wide, ...narrow], 20, 50, 0.7);
  assert.equal(sq.inSqueeze, true);
  assert.ok(sq.ratio < 0.7);
});

test('squeeze: пустой массив → not in squeeze, atr=null', () => {
  const sq = detectSqueeze([], 20, 50, 0.7);
  assert.equal(sq.inSqueeze, false);
  assert.equal(sq.atrShort, null);
});

// ── rangeHighLow ───────────────────────────────

test('rangeHighLow: возвращает high/low за period свечей ДО текущей', () => {
  const candles = [
    candle(100, 90, 95),
    candle(110, 100, 105),
    candle(120, 110, 115),
    candle(200, 50, 130),  // "текущая" — должна быть исключена
  ];
  const r = rangeHighLow(candles, 3);
  assert.equal(r.high, 120);
  assert.equal(r.low, 90);
});

test('rangeHighLow: недостаточно свечей → null', () => {
  assert.equal(rangeHighLow(flatCandles(2, 100), 5), null);
});

// ── breakoutDirection ──────────────────────────

test('breakout: цена выше range_high + ATR*mult → long', () => {
  const dir = breakoutDirection(110, { high: 100, low: 90 }, 2, 1);
  // trigger = 100 + 2*1 = 102. 110 ≥ 102 → long.
  assert.equal(dir, 'long');
});

test('breakout: цена ниже range_low - ATR*mult → short', () => {
  const dir = breakoutDirection(85, { high: 100, low: 90 }, 2, 1);
  // trigger = 90 - 2*1 = 88. 85 ≤ 88 → short.
  assert.equal(dir, 'short');
});

test('breakout: цена внутри range → null', () => {
  const dir = breakoutDirection(95, { high: 100, low: 90 }, 2, 0.5);
  assert.equal(dir, null);
});

test('breakout: ATR=0 → null (защита от деления)', () => {
  const dir = breakoutDirection(110, { high: 100, low: 90 }, 0, 1);
  assert.equal(dir, null);
});

// ── detectTrendFollowSignal (композитный) ──────

const PARAMS = { atrShort: 20, atrLong: 50, squeezeRatio: 0.7, breakoutMult: 0.5 };

test('signal: нет истории → null + insufficient_history', () => {
  const r = detectTrendFollowSignal(flatCandles(10, 100), 100, PARAMS);
  assert.equal(r.signal, null);
  assert.equal(r.reason, 'insufficient_history');
});

test('signal: история есть, no squeeze → null + no_squeeze', () => {
  const r = detectTrendFollowSignal(flatCandles(60, 100, 2), 100, PARAMS);
  assert.equal(r.signal, null);
  assert.match(r.reason, /^no_squeeze/);
});

test('signal: squeeze + пробой вверх → long', () => {
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const candles = [...wide, ...narrow];
  // ATR(20) ≈ 1, range_high (последние 20 свечей до текущей) = 100.5.
  // long trigger = 100.5 + 1 * 0.5 = 101. Берём 102 — точно пробой.
  const r = detectTrendFollowSignal(candles, 102, PARAMS);
  assert.equal(r.signal, 'long');
  assert.equal(r.inSqueeze, true);
  assert.equal(r.reason, 'breakout_long');
});

test('signal: squeeze + пробой вниз → short', () => {
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const candles = [...wide, ...narrow];
  // short trigger = 99.5 - 1 * 0.5 = 99. Берём 98.
  const r = detectTrendFollowSignal(candles, 98, PARAMS);
  assert.equal(r.signal, 'short');
  assert.equal(r.reason, 'breakout_short');
});

test('signal: squeeze но цена в range → null + in_range', () => {
  const wide   = noisyCandles(50, 100, 10);
  const narrow = flatCandles(25, 100, 1);
  const r = detectTrendFollowSignal([...wide, ...narrow], 100, PARAMS);
  assert.equal(r.signal, null);
  assert.equal(r.inSqueeze, true);
  assert.equal(r.reason, 'in_range');
});
