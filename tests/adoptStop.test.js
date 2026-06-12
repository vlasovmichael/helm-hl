import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
// Дефолты: ADOPT_STOP_MODE=atr, ATR_MULT=1.5, MIN=2, MAX=8, STOP_PCT=5.

const { computeStopDistPct } = await import('../src/app/adoptReconcile.js');
const { seedCandleCache, clearCandleCache } = await import('../src/modules/candleCache.js');

// Свечи с заданным размахом: high-low = `range`, close = `close`.
function candles(n, range, close) {
  return Array.from({ length: n }, (_, i) => ({
    open:  close,
    high:  close + range / 2,
    low:   close - range / 2,
    close,
    time:  i,
  }));
}

test('adopt stop: ATR в коридоре → basis atr, дистанция = ATR×1.5/цена', async () => {
  clearCandleCache();
  // close=100, range=2 (TR≈2) → ATR≈2 → ×1.5 = 3 → /100 = 3% (в [2,8])
  seedCandleCache('AAA', candles(20, 2, 100));
  const r = await computeStopDistPct('AAA');
  assert.equal(r.basis, 'atr');
  assert.ok(Math.abs(r.distPct - 3) < 0.01, `expected ~3%, got ${r.distPct}`);
});

test('adopt stop: тихая монета → зажим снизу MIN_PCT (2%)', async () => {
  clearCandleCache();
  // range 0.2 → ATR 0.2 → ×1.5=0.3 → 0.3% < MIN 2 → зажим до 2
  seedCandleCache('QUIET', candles(20, 0.2, 100));
  const r = await computeStopDistPct('QUIET');
  assert.equal(r.basis, 'atr');
  assert.equal(r.distPct, 2);
});

test('adopt stop: дёрганая монета → зажим сверху MAX_PCT (8%)', async () => {
  clearCandleCache();
  // range 10 → ATR 10 → ×1.5=15 → 15% > MAX 8 → зажим до 8
  seedCandleCache('WILD', candles(20, 10, 100));
  const r = await computeStopDistPct('WILD');
  assert.equal(r.basis, 'atr');
  assert.equal(r.distPct, 8);
});

test('adopt stop: свечей нет → фолбэк на фикс ADOPT_STOP_PCT (5%)', async () => {
  clearCandleCache();
  const r = await computeStopDistPct('NOCANDLES');
  assert.equal(r.basis, 'pct');
  assert.equal(r.distPct, 5);
});
