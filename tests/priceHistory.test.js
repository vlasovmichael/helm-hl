// Тесты ring-buffer priceHistory.js (Iter A.1 Sniper-Hunter).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const {
  push, getPriceNMinAgo, hasEnoughHistory, getBufferLength, clearAll,
} = await import('../src/core/priceHistory.js');

const MIN = 60_000;

test('пустой буфер → getPriceNMinAgo null', () => {
  clearAll();
  assert.equal(getPriceNMinAgo('BTC', 2, 1_000_000), null);
  assert.equal(hasEnoughHistory('BTC', 2, 1_000_000), false);
});

test('push + getPriceNMinAgo: возвращает цену ближайшего (не позже) сэмпла', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  push('BTC', 50000, t0);                  // 3 мин назад
  push('BTC', 51000, t0 + 1 * MIN);        // 2 мин назад
  push('BTC', 52000, t0 + 2 * MIN);        // 1 мин назад
  push('BTC', 53000, t0 + 3 * MIN);        // сейчас
  const now = t0 + 3 * MIN;

  assert.equal(getPriceNMinAgo('BTC', 2, now), 51000);  // ровно 2 мин назад
  assert.equal(getPriceNMinAgo('BTC', 1, now), 52000);
  assert.equal(getPriceNMinAgo('BTC', 3, now), 50000);
});

test('getPriceNMinAgo: недостаточно истории → null', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  push('BTC', 50000, t0);
  push('BTC', 51000, t0 + 30_000);  // только 30 сек
  assert.equal(getPriceNMinAgo('BTC', 2, t0 + 30_000), null);
});

test('getPriceNMinAgo: ровно на границе targetTs попадает в выборку', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  push('BTC', 50000, t0);
  push('BTC', 51000, t0 + 2 * MIN);  // ровно 2 мин позже
  // now = t0 + 2*MIN, targetTs = now - 2*MIN = t0
  // Сэмпл в t0 подходит (ts <= targetTs)
  assert.equal(getPriceNMinAgo('BTC', 2, t0 + 2 * MIN), 50000);
});

test('автоматический prune: сэмплы старше 60мин удаляются', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  push('BTC', 100, t0);                   // t0
  push('BTC', 200, t0 + 30 * MIN);        // +30мин
  assert.equal(getBufferLength('BTC'), 2);
  push('BTC', 300, t0 + 61 * MIN);        // +61мин → t0 должен быть срезан (>60мин старше)
  assert.equal(getBufferLength('BTC'), 2);  // [+30мин, +61мин]

  // t0 (цена 100) должна исчезнуть → запрос 60мин назад от +61мин (=+1мин) даёт null
  assert.equal(getPriceNMinAgo('BTC', 60, t0 + 61 * MIN), null);
  // Но 31 мин назад от +61мин (=+30мин) даёт уцелевший сэмпл 200
  assert.equal(getPriceNMinAgo('BTC', 31, t0 + 61 * MIN), 200);
});

test('невалидные цены (0, NaN, отрицательные) silent-ignore', () => {
  clearAll();
  push('BTC', 0, 1);
  push('BTC', NaN, 2);
  push('BTC', -100, 3);
  push('BTC', 50000, 1_000_000);
  assert.equal(getBufferLength('BTC'), 1);
});

test('разные coin изолированы', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  push('BTC', 50000, t0);
  push('ETH', 3000, t0);
  push('BTC', 51000, t0 + 2 * MIN);
  push('ETH', 3100, t0 + 2 * MIN);

  const now = t0 + 2 * MIN;
  assert.equal(getPriceNMinAgo('BTC', 2, now), 50000);
  assert.equal(getPriceNMinAgo('ETH', 2, now), 3000);
  assert.equal(getBufferLength('BTC'), 2);
  assert.equal(getBufferLength('ETH'), 2);
});

test('hasEnoughHistory: true только когда есть сэмпл на границе', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  push('BTC', 50000, t0);
  assert.equal(hasEnoughHistory('BTC', 2, t0 + 1 * MIN), false);  // только 1 мин
  assert.equal(hasEnoughHistory('BTC', 2, t0 + 2 * MIN), true);   // 2 мин есть
  assert.equal(hasEnoughHistory('BTC', 2, t0 + 5 * MIN), true);
});
