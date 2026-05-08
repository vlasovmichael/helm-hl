// Tests for Market Regime BTC entry gate (Iter B).
// Гейт читает config.trading в рантайме — флаг ставим явно в каждом тесте.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.ENTRY_APY_THRESHOLD   = '40';
process.env.MIN_APY_THRESHOLD     = '20';
process.env.EXIT_BUFFER           = '5';
process.env.MIN_HOLD_TIME_MINUTES = '60';
process.env.BREATHING_MINUTES     = '30';
process.env.LEVERAGE              = '1';

const { analyze } = await import('../src/modules/strategist.js');
const { config }  = await import('../src/core/config.js');
const priceHistory = await import('../src/core/priceHistory.js');

const MIN = 60_000;

function scoutItem(coin, smoothedApy, opts = {}) {
  return {
    coin,
    price:        opts.price ?? 100,
    fundingRate:  smoothedApy / 100 / 365 / 24,
    rawApy:       smoothedApy,
    smoothedApy,
    slowApy:      smoothedApy,
    predictedApy: smoothedApy,
    side:         opts.side ?? (smoothedApy >= 0 ? 'short' : 'long'),
  };
}

function withBtcGate(pumpPct, lookbackMin, fn, opts = {}) {
  const t = config.trading;
  const prev = {
    btcEnabled: t.marketRegimeBtcEnabled,
    btcPumpPct: t.marketRegimeBtcPumpPct,
    btcLookback: t.marketRegimeBtcLookbackMin,
    carryLong: t.carryLongEnabled,
  };
  t.marketRegimeBtcEnabled       = true;
  t.marketRegimeBtcPumpPct       = pumpPct;
  t.marketRegimeBtcLookbackMin   = lookbackMin;
  if (opts.carryLong) t.carryLongEnabled = true;
  try { fn(); }
  finally {
    t.marketRegimeBtcEnabled     = prev.btcEnabled;
    t.marketRegimeBtcPumpPct     = prev.btcPumpPct;
    t.marketRegimeBtcLookbackMin = prev.btcLookback;
    t.carryLongEnabled           = prev.carryLong;
    priceHistory.clearAll();
    analyze([], undefined);
  }
}

// ═══════════════════════════════════════════════
// Short-side BTC gate
// ═══════════════════════════════════════════════

test('BTC gate: BTC pumpнул > порога → HOLD на short', () => {
  withBtcGate(2, 60, () => {
    const now = Date.now();
    priceHistory.push('BTC', 100_000, now - 60 * MIN - 1000);
    priceHistory.push('BTC', 103_000, now); // +3% > 2%
    const r = analyze([scoutItem('XMR', 50, { price: 100 })], undefined);
    assert.equal(r.action, 'HOLD');
  });
});

test('BTC gate: BTC спокоен (< порога) → OPEN', () => {
  withBtcGate(2, 60, () => {
    const now = Date.now();
    priceHistory.push('BTC', 100_000, now - 60 * MIN - 1000);
    priceHistory.push('BTC', 100_500, now); // +0.5% < 2%
    priceHistory.push('XMR',     100, now); // current price для velocity gate (off, но getPriceNMinAgo не используется)
    const r = analyze([scoutItem('XMR', 50, { price: 100 })], undefined);
    assert.equal(r.action, 'OPEN');
  });
});

test('BTC gate: BTC dumpнул → OPEN на short (попутный ветер)', () => {
  withBtcGate(2, 60, () => {
    const now = Date.now();
    priceHistory.push('BTC', 100_000, now - 60 * MIN - 1000);
    priceHistory.push('BTC',  95_000, now); // -5% — для shorts благоприятно
    const r = analyze([scoutItem('XMR', 50, { price: 100 })], undefined);
    assert.equal(r.action, 'OPEN');
  });
});

// ═══════════════════════════════════════════════
// Long-side BTC gate (симметрично)
// ═══════════════════════════════════════════════

test('BTC gate: BTC dumpнул → HOLD на long', () => {
  withBtcGate(2, 60, () => {
    const now = Date.now();
    priceHistory.push('BTC', 100_000, now - 60 * MIN - 1000);
    priceHistory.push('BTC',  97_000, now); // -3% < -2% adverse для long
    const r = analyze([scoutItem('LDO', -80, { price: 100 })], undefined);
    assert.equal(r.action, 'HOLD');
  }, { carryLong: true });
});

test('BTC gate: BTC pumpнул → OPEN на long (попутный ветер)', () => {
  withBtcGate(2, 60, () => {
    const now = Date.now();
    priceHistory.push('BTC', 100_000, now - 60 * MIN - 1000);
    priceHistory.push('BTC', 105_000, now); // +5% — для long благоприятно
    const r = analyze([scoutItem('LDO', -80, { price: 100 })], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.side, 'long');
  }, { carryLong: true });
});

// ═══════════════════════════════════════════════
// Defensive defaults
// ═══════════════════════════════════════════════

test('BTC gate: нет истории на lookback назад → HOLD (защитный default)', () => {
  withBtcGate(2, 60, () => {
    priceHistory.push('BTC', 100_000, Date.now() - 5 * MIN);
    priceHistory.push('BTC', 100_500, Date.now());
    const r = analyze([scoutItem('XMR', 50, { price: 100 })], undefined);
    assert.equal(r.action, 'HOLD');
  });
});

test('BTC gate: off (default) — не вмешивается, OPEN без BTC истории', () => {
  priceHistory.clearAll();
  analyze([], undefined);
  const r = analyze([scoutItem('XMR', 50, { price: 100 })], undefined);
  assert.equal(r.action, 'OPEN');
});
