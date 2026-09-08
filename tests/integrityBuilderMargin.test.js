// Маржа, занятая площадкой HIP-3, — не лаг API.
//
// Why: позиция GOLD на builder-DEX'е xyz держит $7.7 спотовых USDC, а в
// clearinghouseState основного DEX'а её нет. Эвристика «позиций нет + маржа
// занята → API отстал» читала это как лаг и держала закрытую строку SOPH
// открытой: сделка не попадала в ленту, а health-плашка каждую минуту слала
// drift.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { unexplainedMarginUsd } = await import('../src/app/integrity.js');

test('эквити HIP-3 объясняет занятую маржу', () => {
  // equity $15.28, свободно $7.58 → занято $7.70; на xyz стоит $7.71.
  assert.ok(unexplainedMarginUsd(15.28, 7.58, 7.71) < 1);
});

test('без площадок HIP-3 занятая маржа остаётся необъяснённой', () => {
  assert.equal(Math.round(unexplainedMarginUsd(15.28, 7.58, 0) * 100) / 100, 7.7);
});

test('площадка объясняет лишь часть — остаток виден', () => {
  assert.ok(unexplainedMarginUsd(100, 40, 20) > 1, 'иначе прикроем настоящий лаг');
});

test('отказ чтения площадок (0) не превращается в отрицательный остаток', () => {
  assert.equal(unexplainedMarginUsd(10, 10, -5), 0);
});
