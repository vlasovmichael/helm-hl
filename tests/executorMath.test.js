// Iter 1.3: side-aware PnL в executor/math.js.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  calcPnl, calcPaperClose, calcRiskSize, calcSize, calcVolSizeMultiplier,
  checkSlippage, MAKER_FEE_RATE, MIN_ORDER_USD, formatHlPrice, roundDown,
} =
  await import('../src/modules/executor/math.js');

// ── Хелперы ───────────────────────────────────
function makePos({ side, entry_price = 100, size_usd = 100, entry_apy = 50 } = {}) {
  return { side, entry_price, size_usd, entry_apy };
}

// ═══════════════════════════════════════════════
// calcPnl: side-aware pricePnl
// ═══════════════════════════════════════════════

test('calcPnl short: цена упала → pricePnl положителен', () => {
  const pos = makePos({ side: 'short', entry_price: 100, size_usd: 100 });
  const r = calcPnl(pos, 95, 1, null, MAKER_FEE_RATE);
  // (100 - 95)/100 * 100 = +5
  assert.equal(Math.round(r.pricePnl * 100) / 100, 5);
});

test('calcPnl short: цена выросла → pricePnl отрицателен', () => {
  const pos = makePos({ side: 'short', entry_price: 100, size_usd: 100 });
  const r = calcPnl(pos, 105, 1);
  assert.equal(Math.round(r.pricePnl * 100) / 100, -5);
});

test('calcPnl long: цена выросла → pricePnl положителен', () => {
  const pos = makePos({ side: 'long', entry_price: 100, size_usd: 100 });
  const r = calcPnl(pos, 105, 1);
  assert.equal(Math.round(r.pricePnl * 100) / 100, 5);
});

test('calcPnl long: цена упала → pricePnl отрицателен', () => {
  const pos = makePos({ side: 'long', entry_price: 100, size_usd: 100 });
  const r = calcPnl(pos, 95, 1);
  assert.equal(Math.round(r.pricePnl * 100) / 100, -5);
});

test('calcPnl без side → дефолт short (обратная совместимость)', () => {
  const pos = { entry_price: 100, size_usd: 100, entry_apy: 50 };
  const r = calcPnl(pos, 95, 1);
  assert.equal(Math.round(r.pricePnl * 100) / 100, 5);
});

// ═══════════════════════════════════════════════
// calcPnl: cumFunding side-agnostic (HL convention)
// ═══════════════════════════════════════════════

test('calcPnl: realFundingUsd прокидывается as-is для short', () => {
  const pos = makePos({ side: 'short' });
  const r = calcPnl(pos, 100, 1, 0.5);
  assert.equal(r.fundingPnl, 0.5);
  assert.equal(r.fundingSource, 'cumFunding');
});

test('calcPnl: realFundingUsd прокидывается as-is для long', () => {
  const pos = makePos({ side: 'long' });
  const r = calcPnl(pos, 100, 1, 0.7);
  assert.equal(r.fundingPnl, 0.7);
  assert.equal(r.fundingSource, 'cumFunding');
});

// ═══════════════════════════════════════════════
// calcPnl: estimate funding использует abs(entry_apy)
// ═══════════════════════════════════════════════

test('calcPnl estimate: long с положительным entry_apy → положительный funding', () => {
  // entry_apy сохраняется как abs (см. paperOpen/productionOpen).
  const pos = makePos({ side: 'long', entry_apy: 80 });
  const r = calcPnl(pos, 100, 24);
  // size 100 * 80%/365/24 * 24 = 100 * 0.0000913 * 24 ≈ 0.219
  assert.ok(r.fundingPnl > 0, `expected positive, got ${r.fundingPnl}`);
  assert.equal(r.fundingSource, 'estimate');
});

test('calcPnl estimate: исторический long с подписанным entry_apy не уходит в минус', () => {
  // Старая запись где entry_apy=-80 — abs страховка.
  const pos = makePos({ side: 'long', entry_apy: -80 });
  const r = calcPnl(pos, 100, 24);
  assert.ok(r.fundingPnl > 0);
});

// ═══════════════════════════════════════════════
// calcPaperClose: abs guard
// ═══════════════════════════════════════════════

test('calcPaperClose: long с подписанным entry_apy → положительный funding', () => {
  const pos = makePos({ side: 'long', entry_apy: -80 });
  const r = calcPaperClose(pos, 24);
  assert.ok(r.fundingPnl > 0, `expected positive, got ${r.fundingPnl}`);
});

// ═══════════════════════════════════════════════
// formatHlPrice: HL tick precision rules
// ═══════════════════════════════════════════════

test('formatHlPrice: low-price coin (REZ-like) → 5 sig figs', () => {
  // entry 0.043567 × 1.02 = 0.04443834 — 7 sig figs, HL отклоняет
  const px = formatHlPrice(0.04443834, 1);
  // 5 sig figs → 0.044438; затем maxDp = 6-1 = 5 → 0.04444
  assert.equal(px, 0.04444);
});

test('formatHlPrice: integer price проходит как есть', () => {
  assert.equal(formatHlPrice(50000, 3), 50000);
});

test('formatHlPrice: высокая цена не теряет точность сверх sig figs', () => {
  // BTC ~110234, szDecimals=5, maxDp=1
  // 5 sig figs → 110230; затем maxDp=1 → 110230 (целое, OK)
  const px = formatHlPrice(110234.567, 5);
  assert.equal(px, 110230);
});

test('formatHlPrice: szDecimals=0 (только integer sz) → maxDp=6', () => {
  // 0.123456789 → 0.12346 (5 sig figs)
  const px = formatHlPrice(0.123456789, 0);
  assert.equal(px, 0.12346);
});

test('formatHlPrice: SL для SHORT (entry × 1.02) — типичный hunter случай', () => {
  // ETH-подобный: entry 2456.7, szDecimals=4, maxDp=2
  // 2505.834 → 5 sig figs: 2505.8 → maxDp=2: 2505.8
  const sl = formatHlPrice(2456.7 * 1.02, 4);
  assert.equal(sl, 2505.8);
});

test('formatHlPrice: invalid input → возвращает как есть', () => {
  assert.equal(formatHlPrice(0, 2), 0);
  assert.equal(formatHlPrice(-5, 2), -5);
});

test('roundDown и calcSize не округляют размер вверх и отсекают мелкий ордер', () => {
  assert.equal(roundDown(12.349, 2), 12.34);
  assert.deepEqual(calcSize(10, 2, 2), { sizeUsd: 9.5, sz: 0, tooSmall: true });
  assert.deepEqual(calcSize(20, 3, 2), { sizeUsd: 19, sz: 6.33, tooSmall: false });
  assert.equal(calcSize(11.57, 1000, 3).tooSmall, true);
  assert.equal(calcSize(MIN_ORDER_USD, 100, 2, 1).tooSmall, false);
  assert.equal(calcSize(20, 1e10, 2).tooSmall, true);
});

test('calcRiskSize считает расстояние до стопа, потолок и не торгует без риска', () => {
  assert.deepEqual(calcRiskSize(1000, 100, 98, 2, 0.01, 1000), {
    sizeUsd: 500, sz: 5, tooSmall: false, stopDistPct: 0.02,
  });
  assert.equal(calcRiskSize(1000, 100, 99, 2, 0.02, 300).sizeUsd, 300);
  assert.deepEqual(calcRiskSize(1000, 100, 100, 2, 0.01, 1000), {
    sizeUsd: 0, sz: 0, tooSmall: true, stopDistPct: 0,
  });
  assert.equal(calcRiskSize(10, 100, 99, 2, 0.01, 1000).tooSmall, true);
  assert.equal(calcRiskSize(100, 100, 99, 2, 0.01, 100).sizeUsd, 100);
  assert.equal(calcRiskSize(1100, 100, 99, 2, 0.0001, 1000).tooSmall, false);
});

test('множитель волатильности ограничен полом и единицей', () => {
  assert.equal(calcVolSizeMultiplier(0, 50, 0.4), 1);
  assert.equal(calcVolSizeMultiplier(0.008, 50, 0.4), 0.6);
  assert.equal(calcVolSizeMultiplier(0.1, 50, 0.4), 0.4);
  assert.equal(calcVolSizeMultiplier(NaN, 50, 0.4), 1);
  assert.equal(calcVolSizeMultiplier(0, 50, 0.4), 1);
});

test('проскальзывание учитывает сторону, пороги и знак в человекочитаемом виде', () => {
  assert.deepEqual(checkSlippage(100, 99, 'SELL'), {
    pct: 1, absPct: 1, warn: true, ban: false, label: '+1.000%',
  });
  assert.deepEqual(checkSlippage(100, 101.5, 'BUY'), {
    pct: 1.5, absPct: 1.5, warn: true, ban: false, label: '+1.500%',
  });
  assert.equal(checkSlippage(100, 98.4, 'BUY').ban, true);
  assert.equal(checkSlippage(100, 100, 'SELL').label, '+0.000%');
  assert.equal(checkSlippage(100, 100.5, 'BUY').warn, false);
});

test('закрытие считает funding, комиссии и итог независимо от источника funding', () => {
  const pos = makePos({ entry_price: 100, size_usd: 100, entry_apy: 87.6 });
  const paper = calcPaperClose(pos, 24, MAKER_FEE_RATE);
  assert.ok(Math.abs(paper.fundingPnl - 0.24) < 1e-12);
  assert.ok(Math.abs(paper.totalFee - 0.033) < 1e-12);
  assert.ok(Math.abs(paper.realizedPnl - 0.207) < 1e-12);

  const actual = calcPnl(pos, 105, 24, null, MAKER_FEE_RATE);
  assert.equal(actual.pricePnl, -5);
  assert.ok(Math.abs(actual.fundingPnl - 0.24) < 1e-12);
  assert.ok(Math.abs(actual.totalFee - 0.023) < 1e-12);
  assert.ok(Math.abs(actual.realizedPnl - (-4.783)) < 1e-12);
  assert.deepEqual(calcPnl(pos, 100, 1, Number.NaN).fundingSource, 'estimate');
  assert.equal(calcPnl({ ...pos, side: '' }, 95, 1).pricePnl, 5);
});

test('formatHlPrice сохраняет ноль, NaN и нецелую цену', () => {
  assert.equal(formatHlPrice(Number.NaN, 2), Number.NaN);
  assert.equal(formatHlPrice(0, 2), 0);
  assert.equal(formatHlPrice(10.12345, 2), 10.123);
});
