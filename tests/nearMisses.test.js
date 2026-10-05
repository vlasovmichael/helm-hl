import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { recordNearMiss, getNearMisses, clearNearMisses } = await import('../src/modules/nearMisses.js');

beforeEach(clearNearMisses);

test('near misses: записывает поля, null для нечислового спайка и timestamp по умолчанию', () => {
  const before = Date.now();
  recordNearMiss({ strategy: 'hunter', coin: 'BTC', side: 'SHORT', spikePct: '4', reason: 'vol' });
  const [row] = getNearMisses();
  assert.equal(row.strategy, 'hunter');
  assert.equal(row.coin, 'BTC');
  assert.equal(row.side, 'SHORT');
  assert.equal(row.spikePct, null);
  assert.equal(row.reason, 'vol');
  assert.equal(row.detail, '');
  assert.ok(row.ts >= before);
});

test('near misses: возвращает новые первыми, отсекает по времени и ограничивает число', () => {
  recordNearMiss({ coin: 'A', side: 'LONG', spikePct: 1, reason: 'a', detail: 'one', ts: 10 });
  recordNearMiss({ coin: 'B', side: 'LONG', spikePct: -2, reason: 'b', detail: 'two', ts: 20 });
  recordNearMiss({ coin: 'C', side: 'SHORT', spikePct: 3, reason: 'c', detail: 'three', ts: 30 });
  assert.deepEqual(getNearMisses({ limit: 2 }).map((x) => x.coin), ['C', 'B']);
  assert.deepEqual(getNearMisses({ since: 20, limit: 5 }).map((x) => x.coin), ['C', 'B']);
  assert.deepEqual(getNearMisses({ since: 31 }), []);
});

test('near misses: кольцо держит последние 200 элементов и полностью очищается', () => {
  for (let i = 0; i < 201; i++) {
    recordNearMiss({ coin: String(i), side: 'LONG', spikePct: i, reason: 'r', detail: 'd', ts: i });
  }
  const all = getNearMisses({ limit: 300 });
  assert.equal(all.length, 200);
  assert.equal(all[0].coin, '200');
  assert.equal(all.at(-1).coin, '1');
  clearNearMisses();
  assert.deepEqual(getNearMisses({ limit: 300 }), []);
});
