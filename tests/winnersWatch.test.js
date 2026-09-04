// winnersWatch — дифф срезов «Гении Уолл-стрит»: что считается событием.
//
// Запуск: npm test
//
// Событие = смена СОСТОЯНИЯ позиции, а не филл: на активном адресе 646 филлов
// в сутки против 4.3 открытий/закрытий. Поэтому здесь
// проверяется ровно граница «что молчит, а что звенит»:
//  - появилась позиция → open, исчезла → close
//  - сменилась сторона → flip (один пуш, не пара open+close)
//  - изменился только размер (добор / частичная фиксация) → тишина
//  - одинаковый тикер на двух площадках HIP-3 не схлопывается в один ключ

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { diff } = await import('../src/modules/winnersWatch.js');

const pos = (coin, side, sizeUsd) => ({ coin, side, sizeUsd, entryPrice: 1, leverage: 3 });
const snap = (entries) => new Map(entries);

test('появление позиции = open, исчезновение = close', () => {
  const prev = snap([['main|BTC', pos('BTC', 'LONG', 10_000)]]);
  const next = snap([['xyz|xyz:NFLX', pos('xyz:NFLX', 'SHORT', 5_000)]]);

  const events = diff(prev, next);
  assert.equal(events.length, 2);
  const opened = events.find((e) => e.kind === 'open');
  const closed = events.find((e) => e.kind === 'close');
  assert.equal(opened.coin, 'xyz:NFLX');
  assert.equal(opened.side, 'SHORT');
  assert.equal(closed.coin, 'BTC');
  assert.equal(closed.sizeUsd, 10_000);
});

test('добор и частичная фиксация молчат — размер не событие', () => {
  const prev = snap([['main|BTC', pos('BTC', 'LONG', 10_000)]]);
  const scaledIn = snap([['main|BTC', pos('BTC', 'LONG', 40_000)]]);
  const scaledOut = snap([['main|BTC', pos('BTC', 'LONG', 900)]]);

  assert.deepEqual(diff(prev, scaledIn), []);
  assert.deepEqual(diff(prev, scaledOut), []);
});

test('разворот стороны = один flip, а не пара open+close', () => {
  const prev = snap([['main|BTC', pos('BTC', 'LONG', 10_000)]]);
  const next = snap([['main|BTC', pos('BTC', 'SHORT', 12_000)]]);

  const events = diff(prev, next);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'flip');
  assert.equal(events[0].from, 'LONG');
  assert.equal(events[0].side, 'SHORT');
});

test('один тикер на разных площадках HIP-3 — две независимые позиции', () => {
  // На главном перпе и на builder-DEX'е это разные счета с разной маржой:
  // схлопнув их в один ключ, сторож проглотил бы половину событий.
  const prev = snap([['main|BTC', pos('BTC', 'LONG', 10_000)]]);
  const next = snap([
    ['main|BTC', pos('BTC', 'LONG', 10_000)],
    ['xyz|BTC', pos('BTC', 'SHORT', 8_000)],
  ]);

  const events = diff(prev, next);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'open');
  assert.equal(events[0].side, 'SHORT');
});

test('пустой прошлый срез отдаёт open на всё — потому засев идёт молча', () => {
  // Регрессия на залп после рестарта: сам дифф честно считает всё новым,
  // поэтому глушить первый срез обязан вызывающий (known.has(address)).
  const next = snap([
    ['main|BTC', pos('BTC', 'LONG', 10_000)],
    ['xyz|xyz:GME', pos('xyz:GME', 'SHORT', 5_000)],
  ]);

  assert.equal(diff(new Map(), next).length, 2);
  assert.ok(diff(new Map(), next).every((e) => e.kind === 'open'));
});
