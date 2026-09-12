// ─────────────────────────────────────────────────
//  Будильник: кого он вообще слушает
// ─────────────────────────────────────────────────
// Топ-N по обороту расширяет явный список. Закрываем ровно то, что может
// испортить будильник молча: монета без оборота не должна вытеснять монету с
// оборотом, а `*` обязан оставаться «без фильтра», а не «список из нуля монет».

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { pickWatchedCoins } = await import('../src/modules/watchlistAlerts.js');

const snap = [
  { coin: 'AAA', volume24hUsd: 500 },
  { coin: 'BBB', volume24hUsd: 3000 },
  { coin: 'CCC', volume24hUsd: 1000 },
  { coin: 'DDD', volume24hUsd: null },
];

test('топ-N берёт самые оборотистые, список остаётся', () => {
  const got = pickWatchedCoins(snap, { watchlist: ['BTC'], topN: 2, watchAll: false });
  assert.deepEqual([...got].sort(), ['BBB', 'BTC', 'CCC']);
});

test('монета без оборота в топ не попадает', () => {
  const got = pickWatchedCoins(snap, { watchlist: [], topN: 4, watchAll: false });
  assert.ok(!got.has('DDD'));
  assert.equal(got.size, 3);
});

test('topN=0 оставляет только явный список', () => {
  const got = pickWatchedCoins(snap, { watchlist: ['BTC', 'SOL'], topN: 0, watchAll: false });
  assert.deepEqual([...got].sort(), ['BTC', 'SOL']);
});

test('watchAll = нет фильтра, а не пустой набор', () => {
  // null здесь смысловой: вызывающий обязан пропустить ВСЮ вселенную.
  assert.equal(pickWatchedCoins(snap, { watchlist: [], topN: 0, watchAll: true }), null);
});

test('пустой снапшот не валит выбор', () => {
  const got = pickWatchedCoins([], { watchlist: ['BTC'], topN: 5, watchAll: false });
  assert.deepEqual([...got], ['BTC']);
});
