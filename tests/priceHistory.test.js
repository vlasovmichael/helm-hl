// Тесты ring-buffer priceHistory.js (Iter A.1 Sniper-Hunter).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const {
  push, getPriceNMinAgo, getLatestPrice, getSamplesSince, getPriceSpark,
  snapshot, restore, hasEnoughHistory, getBufferLength, clearAll,
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

test('автоматический prune: сэмплы старше 4ч удаляются', () => {
  clearAll();
  const t0 = 1_000_000_000_000;
  const H = 60 * MIN;
  push('BTC', 100, t0);                   // t0
  push('BTC', 200, t0 + 2 * H);           // +2ч
  assert.equal(getBufferLength('BTC'), 2);
  push('BTC', 300, t0 + 4 * H + MIN);     // +4ч 1мин → t0 должен быть срезан (>4ч старше)
  assert.equal(getBufferLength('BTC'), 2);  // [+2ч, +4ч1мин]

  // t0 (цена 100) должна исчезнуть → запрос 4ч назад от +4ч1мин (=+1мин) даёт null
  assert.equal(getPriceNMinAgo('BTC', 4 * 60, t0 + 4 * H + MIN), null);
  // Но 2ч 1мин назад от +4ч1мин (=+2ч) даёт уцелевший сэмпл 200
  assert.equal(getPriceNMinAgo('BTC', 2 * 60 + 1, t0 + 4 * H + MIN), 200);
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

test('latest, выборка окна и spark возвращают наблюдаемые цены без пустых корзин', () => {
  clearAll();
  const t = 2_000_000;
  push('BTC', 10, t - 4 * MIN);
  push('BTC', 20, t - 2 * MIN);
  push('BTC', 30, t - MIN);
  push('BTC', 40, t);
  assert.equal(getLatestPrice('BTC'), 40);
  assert.equal(getLatestPrice('ETH'), null);
  assert.deepEqual(getSamplesSince('BTC', 2, t).map((x) => x.price), [20, 30, 40]);
  assert.deepEqual(getSamplesSince('ETH', 2, t), []);
  assert.deepEqual(getPriceSpark('BTC', 4, 4, t), [10, 20, 40]);
  assert.deepEqual(getPriceSpark('ETH', 4, 4, t), []);
  assert.deepEqual(getPriceSpark('BTC', 0, 4, t), []);
});

test('spark берёт последнюю цену корзины, включая правую границу', () => {
  clearAll();
  const t = 3_000_000;
  push('BTC', 1, t - 4 * MIN);
  push('BTC', 2, t - 3 * MIN - 1);
  push('BTC', 3, t - 2 * MIN);
  push('BTC', 4, t);
  assert.deepEqual(getPriceSpark('BTC', 4, 2, t), [2, 4]);
});

test('snapshot отбрасывает старое, restore валидирует, сортирует и не дублирует live', () => {
  clearAll();
  const t = 10_000_000;
  push('BTC', 1, t - 61 * MIN);
  push('BTC', 2, t - 60 * MIN);
  push('BTC', 3, t - MIN);
  assert.deepEqual(snapshot(60, t), {
    v: 1, savedAt: t, coins: { BTC: [[t - 60 * MIN, 2], [t - MIN, 3]] }, samples: 2,
  });
  clearAll();
  push('BTC', 9, t - 30_000);
  const result = restore({ v: 1, coins: {
    BTC: [[t - MIN, 3], [t - 2 * MIN, 2], [t - 30_000, 7], [t + 1, 8], ['bad', 1]],
    ETH: 'bad',
  } }, t);
  assert.deepEqual(result, { coins: 1, samples: 3 });
  assert.deepEqual(getSamplesSince('BTC', 3, t).map((x) => x.price), [2, 3, 9]);
  assert.deepEqual(restore(null, t), { coins: 0, samples: 0 });
  assert.deepEqual(restore({ v: 2, coins: {} }, t), { coins: 0, samples: 0 });
});
