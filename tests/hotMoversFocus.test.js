// Фокус Hot Movers: витрина показывает только свои монеты (HOT_MOVERS_COINS).
// Сторож против двух регрессий: (1) пустой список молча вырезает всё;
// (2) фильтр съедает строку монеты с открытой позой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFocusCoins } from '../src/modules/hotMoversSetup.js';

const rows = ['BTC', 'SOL', 'HYPE', 'PEPE', 'WIF'].map((coin) => ({ coin }));
const coins = (r) => r.map((m) => m.coin);

test('пустой фокус = вся вселенная, тот же массив', () => {
  assert.equal(applyFocusCoins(rows, new Set(), new Set()), rows);
  assert.equal(applyFocusCoins(rows, null, new Set()), rows);
});

test('фокус оставляет только свои монеты', () => {
  const out = applyFocusCoins(rows, new Set(['BTC', 'SOL', 'HYPE']), new Set());
  assert.deepEqual(coins(out), ['BTC', 'SOL', 'HYPE']);
});

test('монета с открытой позой проходит мимо фокуса', () => {
  const out = applyFocusCoins(rows, new Set(['BTC']), new Set(['WIF']));
  assert.deepEqual(coins(out), ['BTC', 'WIF']);
});
