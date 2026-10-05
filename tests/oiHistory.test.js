import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordOiSnapshot, getOiNMinAgo, _resetOiHistory } from '../src/core/oiHistory.js';

const MIN = 60_000;

test('пустая и невалидная история не выдаёт OI', () => {
  _resetOiHistory();
  recordOiSnapshot(null, 100);
  recordOiSnapshot([], 100);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 0 }, { coin: 'ETH', oiUsd: -1 }], 100);
  assert.equal(getOiNMinAgo('BTC', 1, 2 * MIN), null);
});

test('берёт последний снимок на или до целевой метки', () => {
  _resetOiHistory();
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 100 }], 0);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 120 }], MIN);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 150 }], 2 * MIN);
  assert.equal(getOiNMinAgo('BTC', 1, 2 * MIN), 120);
  assert.equal(getOiNMinAgo('BTC', 2, 2 * MIN), 100);
  assert.equal(getOiNMinAgo('BTC', 3, 2 * MIN), null);
});

test('maxStaleMin отсекает слишком старую базу, но не равную границу', () => {
  _resetOiHistory();
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 100 }], 0);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 110 }], 10 * MIN);
  assert.equal(getOiNMinAgo('BTC', 5, 10 * MIN, { maxStaleMin: 5 }), 100);
  assert.equal(getOiNMinAgo('BTC', 5, 11 * MIN, { maxStaleMin: 5 }), null);
  _resetOiHistory();
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 100 }], 4 * MIN);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 110 }], 11 * MIN);
  assert.equal(getOiNMinAgo('BTC', 1, 11 * MIN, { maxStaleMin: 7 }), 100);
});

test('истории монет изолированы, а буфер хранит последние сорок снимков', () => {
  _resetOiHistory();
  for (let i = 0; i < 42; i++) recordOiSnapshot([
    { coin: 'BTC', oiUsd: i + 1 }, { coin: 'ETH', oiUsd: 100 + i },
  ], i * MIN);
  assert.equal(getOiNMinAgo('BTC', 39, 41 * MIN), 3);
  assert.equal(getOiNMinAgo('ETH', 39, 41 * MIN), 102);
});

test('один валидный снимок недостаточен, reset действительно очищает историю', () => {
  _resetOiHistory();
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 0 }], 0);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 10 }], MIN);
  assert.equal(getOiNMinAgo('BTC', 1, MIN), null);
  recordOiSnapshot([{ coin: 'BTC', oiUsd: 20 }], 2 * MIN);
  assert.equal(getOiNMinAgo('BTC', 1, 2 * MIN), 10);
  _resetOiHistory();
  assert.equal(getOiNMinAgo('BTC', 1, 2 * MIN), null);
});
