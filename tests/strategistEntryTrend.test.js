// Tests for Carry entry trend gate (Дед v3 — вход-аналог v2 «цена решает»).
// Гейт читается из config.trading в рантайме, поэтому в каждом тесте явно
// включаем флаг и сбрасываем после.

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
    side:         opts.side ?? 'short',
  };
}

function withTrendGate(lookbackMin, adversePct, fn, opts = {}) {
  const t = config.trading;
  const prev = { ...t };
  t.carryEntryTrendEnabled     = true;
  t.carryEntryTrendLookbackMin = lookbackMin;
  t.carryEntryTrendAdversePct  = adversePct;
  // Long-вход тестируем через carryLongEnabled (иначе analyze берёт только short).
  if (opts.carryLong) t.carryLongEnabled = true;
  try { fn(); }
  finally {
    t.carryEntryTrendEnabled     = prev.carryEntryTrendEnabled;
    t.carryEntryTrendLookbackMin = prev.carryEntryTrendLookbackMin;
    t.carryEntryTrendAdversePct  = prev.carryEntryTrendAdversePct;
    t.carryLongEnabled           = prev.carryLongEnabled;
    priceHistory.clearAll();
    analyze([], undefined); // reset internal state
  }
}

test('Entry trend: short — цена ещё растёт > порога за окно → HOLD', () => {
  withTrendGate(15, 0.6, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // 15мин назад 100, сейчас 101 → +1% > 0.6% → импульс против шорта
    priceHistory.push('XMR', 100, now - 15 * MIN - 1000);
    priceHistory.push('XMR', 101, now);

    const r = analyze([scoutItem('XMR', 50, { price: 101 })], undefined);
    assert.equal(r.action, 'HOLD');
  });
});

test('Entry trend: short — импульс выдохся (< порога) → OPEN', () => {
  withTrendGate(15, 0.6, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // 15мин назад 100, сейчас 100.3 → +0.3% < 0.6% → можно фейдить
    priceHistory.push('XMR', 100, now - 15 * MIN - 1000);
    priceHistory.push('XMR', 100.3, now);

    const r = analyze([scoutItem('XMR', 50, { price: 100.3 })], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.coin, 'XMR');
  });
});

test('Entry trend: short — пампанула 2ч назад, плато последние 15м → OPEN (валидный fade)', () => {
  withTrendGate(15, 0.6, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // Большой памп час+ назад, но recent окно ровное → импульс уже мёртв
    priceHistory.push('XMR', 100, now - 120 * MIN);
    priceHistory.push('XMR', 110, now -  60 * MIN);
    priceHistory.push('XMR', 110, now -  15 * MIN - 1000);
    priceHistory.push('XMR', 110.1, now);  // +0.09% за 15м

    const r = analyze([scoutItem('XMR', 50, { price: 110.1 })], undefined);
    assert.equal(r.action, 'OPEN');
  });
});

test('Entry trend: short — цена падает за окно → OPEN (попутный ветер для шорта)', () => {
  withTrendGate(15, 0.6, () => {
    const now = Date.now();
    priceHistory.clearAll();
    priceHistory.push('XMR', 100, now - 15 * MIN - 1000);
    priceHistory.push('XMR',  98, now);   // -2% — благоприятно для шорта

    const r = analyze([scoutItem('XMR', 50, { price: 98 })], undefined);
    assert.equal(r.action, 'OPEN');
  });
});

test('Entry trend: long — цена ещё падает > порога → HOLD', () => {
  withTrendGate(15, 0.6, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // long-carry на negative funding: smoothedApy отрицательный, side=long
    priceHistory.push('TON', 100, now - 15 * MIN - 1000);
    priceHistory.push('TON',  99, now);   // -1% > 0.6% → импульс против лонга

    const r = analyze([scoutItem('TON', -50, { price: 99, side: 'long' })], undefined);
    assert.equal(r.action, 'HOLD');
  }, { carryLong: true });
});

test('Entry trend: нет истории на окно назад → PASS (не блокируем, OPEN)', () => {
  withTrendGate(15, 0.6, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // Только свежие сэмплы — окна на 15м назад нет. В отличие от velocity gate,
    // trend gate пропускает (это тонкий фильтр поверх velocity, без restart-blackout).
    priceHistory.push('XMR', 100, now - 5 * MIN);
    priceHistory.push('XMR', 105, now);   // даже +5%, но истории на 15м нет

    const r = analyze([scoutItem('XMR', 50, { price: 105 })], undefined);
    assert.equal(r.action, 'OPEN');
  });
});

test('Entry trend: off (default) → не вмешивается, OPEN', () => {
  // Флаг НЕ включаем — гейт пропускает вход даже при живом импульсе.
  priceHistory.clearAll();
  analyze([], undefined);
  const now = Date.now();
  priceHistory.push('XMR', 100, now - 15 * MIN - 1000);
  priceHistory.push('XMR', 105, now);   // +5% за 15м, но гейт off
  const r = analyze([scoutItem('XMR', 50, { price: 105 })], undefined);
  assert.equal(r.action, 'OPEN');
});
