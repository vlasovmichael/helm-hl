import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { contractUsd, withinWindow, summarize, WINDOW_MS } =
  await import('../src/core/liqEvents.js');

test('liqEvents: номинал = контракты × множитель × цена', () => {
  // BTC: контракт 0.01 BTC, 0.1 контракта по $80000 → 0.1 × 0.01 × 80000.
  assert.equal(contractUsd('0.1', 0.01, '80000'), 80);
  // DOGE: контракт 1000 монет — без множителя вышло бы в тысячу раз меньше.
  assert.equal(contractUsd('2', 1000, '0.15'), 300);
});

test('liqEvents: мусор на входе не превращается в ноль долларов', () => {
  assert.equal(contractUsd('', 0.01, '80000'), null);
  assert.equal(contractUsd('0.1', undefined, '80000'), null);
  assert.equal(contractUsd('0.1', 0.01, '0'), null);
  assert.equal(contractUsd('-1', 0.01, '80000'), null);
});

test('liqEvents: окно режет по возрасту, граница включительно', () => {
  const now = 1_000_000_000;
  assert.equal(withinWindow({ t: now }, now), true);
  assert.equal(withinWindow({ t: now - WINDOW_MS }, now), true);
  assert.equal(withinWindow({ t: now - WINDOW_MS - 1 }, now), false);
  assert.equal(withinWindow({}, now), false);
});

test('liqEvents: свод делит стороны и фильтрует по монете', () => {
  const now = 1_000_000_000;
  const list = [
    { t: now, coin: 'BTC', usd: 100, side: 'long' },
    { t: now, coin: 'BTC', usd: 40, side: 'short' },
    { t: now, coin: 'ETH', usd: 7, side: 'long' },
    { t: now - WINDOW_MS - 1, coin: 'BTC', usd: 999, side: 'long' }, // вне окна
  ];

  const btc = summarize(list, { coin: 'BTC', now });
  assert.equal(btc.longUsd, 100);
  assert.equal(btc.shortUsd, 40);
  assert.equal(btc.totalUsd, 140);
  assert.equal(btc.n, 2);

  // Без монеты — весь рынок, но всё так же без протухших событий.
  const market = summarize(list, { now });
  assert.equal(market.totalUsd, 147);
  assert.equal(market.n, 3);
});
