// Весовой бюджет /info. Лимит HL — 1200 ЕДИНИЦ ВЕСА в минуту, не 1200 запросов:
// большинство info-запросов весят 20 (→ ~60/мин, один в секунду), лёгкие — 2,
// userRole — 60. Семь прежних фиксов 429 считали штуки и потому не помогали
// (368 отказов за сутки 30.07).
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.HL_WEIGHT_BUDGET = '100';   // маленький бюджет → ожидание видно за тест

const { weightOf, hlClientStats } = await import('../src/core/hlClient.js');

test('лёгкие типы весят 2', () => {
  for (const type of ['allMids', 'l2Book', 'clearinghouseState', 'spotClearinghouseState',
                      'orderStatus', 'exchangeStatus']) {
    assert.equal(weightOf({ type }), 2, type);
  }
});

test('userRole весит 60', () => {
  assert.equal(weightOf({ type: 'userRole' }), 60);
});

test('всё остальное весит 20 (дефолт)', () => {
  for (const type of ['candleSnapshot', 'metaAndAssetCtxs', 'userFills',
                      'userFillsByTime', 'fundingHistory']) {
    assert.equal(weightOf({ type }), 20, type);
  }
  assert.equal(weightOf({}), 20);
  assert.equal(weightOf(undefined), 20);
});

test('арифметика лимита: тяжёлых ~60/мин, лёгких ~600/мин при бюджете 1200', () => {
  assert.equal(Math.floor(1200 / weightOf({ type: 'candleSnapshot' })), 60);
  assert.equal(Math.floor(1200 / weightOf({ type: 'allMids' })), 600);
});

test('stats отдаёт весовые поля', () => {
  const s = hlClientStats();
  assert.equal(s.weightBudget, 100);
  assert.equal(typeof s.weightUsed, 'number');
  assert.equal(typeof s.weightPct, 'number');
  assert.ok(s.weightUsed >= 0);
});
