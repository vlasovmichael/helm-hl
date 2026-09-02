// WS-фид собственных филлов: дедуп и отличие снапшота от событий.
//
// Why (02.09.2026): бот узнавал о своих сделках только опросом раз в 60с, и при
// сработавшей защитной эвристике это дало четыре часа слепоты. Фид даёт событие
// в момент исполнения. Две вещи, которые обязаны работать:
//   1. снапшот при подписке (isSnapshot) НЕ будит тик — иначе каждый реконнект
//      переигрывал бы всю историю филлов;
//   2. один и тот же филл не обрабатывается дважды.
//
// Тестируются чистые функции — без сети и без кошелька.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { pickFreshFills, fillKey } = await import('../src/core/fillFeed.js');

const fill = (tid, coin = 'HEMI') => ({ tid, coin, sz: '100', px: '0.0149', dir: 'Close Long' });

test('снапшот при подписке не порождает событий, но запоминается', () => {
  const seen = new Set();
  const fresh = pickFreshFills({ data: { isSnapshot: true, fills: [fill(1), fill(2)] } }, seen);
  assert.deepEqual(fresh, [], 'история при подписке — не новые сделки');
  assert.equal(seen.size, 2, 'но она должна попасть в дедуп');
});

test('после снапшота те же филлы повторно не всплывают', () => {
  const seen = new Set();
  pickFreshFills({ data: { isSnapshot: true, fills: [fill(1), fill(2)] } }, seen);
  const fresh = pickFreshFills({ data: { fills: [fill(1), fill(2)] } }, seen);
  assert.deepEqual(fresh, [], 'реконнект не должен переигрывать историю');
});

test('новый филл проходит и обрабатывается один раз', () => {
  const seen = new Set();
  const first = pickFreshFills({ data: { fills: [fill(7)] } }, seen);
  assert.equal(first.length, 1);
  assert.equal(first[0].tid, 7);
  const again = pickFreshFills({ data: { fills: [fill(7)] } }, seen);
  assert.deepEqual(again, [], 'повтор того же tid игнорируется');
});

test('филлы без tid различаются по hash + oid + time', () => {
  const a = { coin: 'SOL', hash: '0xabc', oid: 1, time: 100 };
  const b = { coin: 'SOL', hash: '0xabc', oid: 2, time: 100 };
  assert.notEqual(fillKey(a), fillKey(b));
  const seen = new Set();
  assert.equal(pickFreshFills({ data: { fills: [a, b] } }, seen).length, 2);
});

test('пустые и битые сообщения безопасны', () => {
  const seen = new Set();
  assert.deepEqual(pickFreshFills({}, seen), []);
  assert.deepEqual(pickFreshFills({ data: {} }, seen), []);
  assert.deepEqual(pickFreshFills({ data: { fills: [] } }, seen), []);
  assert.deepEqual(pickFreshFills(null, seen), []);
});

test('множество виденных филлов не растёт бесконечно', () => {
  const seen = new Set();
  for (let i = 0; i < 1200; i++) pickFreshFills({ data: { fills: [fill(i)] } }, seen);
  assert.ok(seen.size <= 500, `ожидали подрезку до 500, получили ${seen.size}`);
  // свежий филл всё ещё распознаётся как новый
  assert.equal(pickFreshFills({ data: { fills: [fill(99999)] } }, seen).length, 1);
});
