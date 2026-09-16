// Тёплый старт буфера цен: снимок на диск и подъём при рестарте. Сторож против
// трёх регрессий: снимок тащит больше часа, битый файл роняет старт, поднятый
// снимок затирает уже накопленные живые сэмплы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  push,
  snapshot,
  restore,
  clearAll,
  getPriceNMinAgo,
  getBufferLength,
} from '../src/core/priceHistory.js';

const NOW = 1_700_000_000_000;
const minAgo = (m) => NOW - m * 60_000;

test('снимок переживает рестарт: окна 2/5/15м читаются сразу', () => {
  clearAll();
  for (const m of [15, 5, 2, 0]) push('BTC', 100 + m, minAgo(m));
  const snap = snapshot(60, NOW);

  clearAll();
  assert.equal(getPriceNMinAgo('BTC', 15, NOW), null, 'после рестарта буфер пуст');

  const { coins, samples } = restore(snap, NOW);
  assert.equal(coins, 1);
  assert.equal(samples, 4);
  assert.equal(getPriceNMinAgo('BTC', 15, NOW), 115);
  assert.equal(getPriceNMinAgo('BTC', 5, NOW), 105);
  assert.equal(getPriceNMinAgo('BTC', 2, NOW), 102);
});

test('в снимок не едет старше часа', () => {
  clearAll();
  push('SOL', 1, minAgo(200));
  push('SOL', 2, minAgo(90));
  push('SOL', 3, minAgo(30));
  const snap = snapshot(60, NOW);
  assert.equal(snap.samples, 1, 'только сэмпл за последний час');
  assert.deepEqual(snap.coins.SOL, [[minAgo(30), 3]]);
});

test('битый снимок не роняет старт и не мусорит в буфер', () => {
  clearAll();
  for (const bad of [null, undefined, {}, { v: 99, coins: {} }, { v: 1 }]) {
    assert.deepEqual(restore(bad, NOW), { coins: 0, samples: 0 });
  }
  const dirty = {
    v: 1,
    coins: { WIF: [[minAgo(10), 0], [minAgo(10), -1], ['x', 5], [minAgo(10)], [NOW + 60_000, 7]] },
  };
  assert.deepEqual(restore(dirty, NOW), { coins: 0, samples: 0 });
  assert.equal(getBufferLength('WIF'), 0);
});

test('живые сэмплы не затираются — снимок ложится перед ними', () => {
  clearAll();
  push('ETH', 10, minAgo(30));
  const snap = snapshot(60, NOW);

  clearAll();
  push('ETH', 99, NOW); // скаут успел тикнуть до подъёма снимка
  restore(snap, NOW);

  assert.equal(getBufferLength('ETH'), 2);
  assert.equal(getPriceNMinAgo('ETH', 30, NOW), 10, 'история из снимка');
  assert.equal(getPriceNMinAgo('ETH', 0, NOW), 99, 'живой сэмпл на месте');
});

test('сэмплы старше окна буфера (4ч) при подъёме отбрасываются', () => {
  clearAll();
  const stale = { v: 1, savedAt: minAgo(300), coins: { PEPE: [[minAgo(300), 5]] } };
  assert.deepEqual(restore(stale, NOW), { coins: 0, samples: 0 });
});
