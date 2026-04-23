// Тесты pending-sniper slot API и Sniper-констант.
//
// Запуск: npm test
//
// Iter 1: только каркас, никакой интеграции нет — проверяем
// чистый API state.js (arm/get/update/clear/has) и экспорт констант.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта ──
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const {
  armSniper, getSniper, updateSniper, clearSniper, hasSniper,
} = await import('../src/modules/executor/state.js');

const {
  MAKER_FEE_RATE, SNIPER_WINDOW_MS, SNIPER_SOFT_REASONS,
  FEE_RATE,
} = await import('../src/modules/executor/math.js');

// ── Константы ─────────────────────────────────

test('MAKER_FEE_RATE меньше FEE_RATE (maker дешевле taker)', () => {
  assert.ok(Number.isFinite(MAKER_FEE_RATE), 'MAKER_FEE_RATE должен быть числом');
  assert.ok(MAKER_FEE_RATE < FEE_RATE, `MAKER_FEE_RATE (${MAKER_FEE_RATE}) должен быть < FEE_RATE (${FEE_RATE})`);
  assert.ok(MAKER_FEE_RATE >= 0, 'MAKER_FEE_RATE не должен быть отрицательным (rebate-тиров пока не моделируем)');
});

test('SNIPER_WINDOW_MS — 15 минут', () => {
  assert.equal(SNIPER_WINDOW_MS, 15 * 60_000);
});

test('SNIPER_SOFT_REASONS содержит soft-причины', () => {
  assert.ok(SNIPER_SOFT_REASONS instanceof Set);
  assert.ok(SNIPER_SOFT_REASONS.has('apy_below_threshold'));
  assert.ok(SNIPER_SOFT_REASONS.has('fade_time_stop'));
});

test('SNIPER_SOFT_REASONS НЕ содержит emergency-причин', () => {
  assert.ok(!SNIPER_SOFT_REASONS.has('delisted'));
  assert.ok(!SNIPER_SOFT_REASONS.has('price_spike_protection'));
  assert.ok(!SNIPER_SOFT_REASONS.has('negative_funding'));
  assert.ok(!SNIPER_SOFT_REASONS.has('better_apy'));  // ROTATE, не close
});

// ── Sniper slot API ───────────────────────────

test('изначально слот пуст', () => {
  clearSniper();
  assert.equal(getSniper(), null);
  assert.equal(hasSniper(), false);
});

test('armSniper заполняет слот и ставит armedAt', () => {
  clearSniper();
  const before = Date.now();
  armSniper({
    positionId: 42, coin: 'kPEPE', reason: 'apy_below_threshold',
    armPrice: 0.001234, side: 'BUY',
  });
  const after = Date.now();

  const slot = getSniper();
  assert.equal(slot.positionId, 42);
  assert.equal(slot.coin, 'kPEPE');
  assert.equal(slot.reason, 'apy_below_threshold');
  assert.equal(slot.armPrice, 0.001234);
  assert.equal(slot.side, 'BUY');
  assert.ok(slot.armedAt >= before && slot.armedAt <= after, 'armedAt должен быть выставлен в текущий момент');
  assert.equal(hasSniper(), true);
});

test('armSniper перезаписывает предыдущий слот', () => {
  clearSniper();
  armSniper({ positionId: 1, coin: 'ETH', reason: 'fade_time_stop' });
  armSniper({ positionId: 2, coin: 'BTC', reason: 'apy_below_threshold' });

  const slot = getSniper();
  assert.equal(slot.positionId, 2);
  assert.equal(slot.coin, 'BTC');
});

test('updateSniper мержит patch, не теряя остальных полей', () => {
  clearSniper();
  armSniper({ positionId: 7, coin: 'SOL', reason: 'apy_below_threshold', armPrice: 100 });
  updateSniper({ orderId: 'oid-123', armPrice: 99.5 });

  const slot = getSniper();
  assert.equal(slot.positionId, 7);
  assert.equal(slot.coin, 'SOL');
  assert.equal(slot.orderId, 'oid-123');
  assert.equal(slot.armPrice, 99.5);
});

test('updateSniper на пустом слоте — no-op', () => {
  clearSniper();
  updateSniper({ orderId: 'ghost' });
  assert.equal(getSniper(), null);
  assert.equal(hasSniper(), false);
});

test('clearSniper идемпотентен', () => {
  clearSniper();
  clearSniper();
  assert.equal(getSniper(), null);
  assert.equal(hasSniper(), false);
});

test('clearSniper снимает армированный слот', () => {
  armSniper({ positionId: 1, coin: 'X', reason: 'fade_time_stop' });
  assert.equal(hasSniper(), true);
  clearSniper();
  assert.equal(hasSniper(), false);
  assert.equal(getSniper(), null);
});
