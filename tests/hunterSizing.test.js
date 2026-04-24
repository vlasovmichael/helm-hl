// Тест: calcSize с utilization-параметром (Hunter 50% vs default 95%).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const {
  calcSize, BALANCE_UTILIZATION, HUNTER_BALANCE_UTILIZATION, MIN_ORDER_USD,
} = await import('../src/modules/executor/math.js');

test('HUNTER_BALANCE_UTILIZATION = 0.5 (50% от баланса)', () => {
  assert.equal(HUNTER_BALANCE_UTILIZATION, 0.5);
  assert.ok(HUNTER_BALANCE_UTILIZATION < BALANCE_UTILIZATION);
});

test('calcSize default utilization = BALANCE_UTILIZATION (backward compat)', () => {
  const r = calcSize(100, 10, 2);
  assert.equal(r.sizeUsd, 100 * BALANCE_UTILIZATION);
  assert.equal(r.sz, 9.5);  // 95 / 10 = 9.5
  assert.equal(r.tooSmall, false);
});

test('calcSize с HUNTER_BALANCE_UTILIZATION на $50 → $25 order', () => {
  const r = calcSize(50, 10, 2, HUNTER_BALANCE_UTILIZATION);
  assert.equal(r.sizeUsd, 25);
  assert.equal(r.sz, 2.5);
  assert.equal(r.tooSmall, false);
});

test('calcSize с hunter на $20 → $10 order, меньше MIN_ORDER_USD → tooSmall', () => {
  const r = calcSize(20, 10, 2, HUNTER_BALANCE_UTILIZATION);
  // 20 * 0.5 = 10, меньше MIN_ORDER_USD=11
  assert.equal(r.sizeUsd, 10);
  assert.equal(r.tooSmall, true);
  assert.ok(r.sizeUsd < MIN_ORDER_USD);
});

test('calcSize с hunter на граничных $22 → $11 == MIN → допустимо', () => {
  const r = calcSize(22, 10, 2, HUNTER_BALANCE_UTILIZATION);
  assert.equal(r.sizeUsd, 11);
  assert.equal(r.tooSmall, false);
});

test('calcSize: большой балaнс, hunter в 1.9x меньше carry по размеру', () => {
  const balance = 1000;
  const carry  = calcSize(balance, 100, 2);
  const hunter = calcSize(balance, 100, 2, HUNTER_BALANCE_UTILIZATION);
  // 950 / 500 = 1.9
  assert.equal((carry.sizeUsd / hunter.sizeUsd).toFixed(2), '1.90');
});
