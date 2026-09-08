// Бюджет комиссий на день — вторая рельса рядом со стоп-лоссом.
//
// Why: минус по PnL решает рынок, а комиссии решает частота. За 91 день оборот
// составил 2905 размеров счёта, комиссии — 162% счёта. Это единственная статья,
// которая растёт от числа сделок гарантированно, поэтому у неё свой потолок.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { feeBudgetState } = await import('../src/modules/dailyRisk.js');

test('комиссии выше потолка — рельса сработала', () => {
  const s = feeBudgetState(0.44, 27.42, 1.5);
  assert.equal(s.exceeded, true);
  assert.equal(Math.round(s.pct * 10) / 10, 1.6);
});

test('комиссии внутри бюджета — молчит', () => {
  assert.equal(feeBudgetState(0.10, 27.42, 1.5).exceeded, false);
});

test('ровно на потолке считается выбранным', () => {
  assert.equal(feeBudgetState(1.5, 100, 1.5).exceeded, true);
});

// 🚨 Неизвестный счёт не должен превращаться в срабатывание: рельса громкая,
// и ложный пуш на пустом балансе обесценит настоящий.
test('нет счёта или потолок 0 — рельсы нет', () => {
  assert.deepEqual(feeBudgetState(1, 0, 1.5), { pct: null, exceeded: false });
  assert.deepEqual(feeBudgetState(1, 100, 0), { pct: null, exceeded: false });
});
