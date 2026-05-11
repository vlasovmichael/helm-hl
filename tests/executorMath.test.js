// Iter 1.3: side-aware PnL в executor/math.js.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { calcPnl, calcPaperClose, FEE_RATE, MAKER_FEE_RATE, formatHlPrice } =
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
