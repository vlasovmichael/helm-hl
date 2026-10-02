// Фандинг сделки и её net: единый расчёт для ленты, модалки, Today и Statistics.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { parseFundingDeltas, sumFunding, tradeFunding, tradeNet, fetchAllFunding } = await import('../src/modules/funding.js');
const { attachFunding, closeMoney } = await import('../src/modules/dashboard/routes/manualTrades.js');

const H = 3_600_000;
const T = Date.UTC(2026, 9, 2, 16, 0, 0);

const deltas = [
  { ts: T, coin: 'SAND', usdc: -0.062148 },
  { ts: T + H, coin: 'SAND', usdc: -0.05 },
  { ts: T + 2 * H, coin: 'SAND', usdc: -0.109204 },
  { ts: T + 2 * H, coin: 'BTC', usdc: 0.5 },
];

test('parseFundingDeltas: берёт время, монету и сумму из ответа userFunding', () => {
  const raw = [{ time: T, hash: '0x', delta: { type: 'funding', coin: 'SAND', usdc: '-0.062148', szi: '-876.0' } }];
  assert.deepEqual(parseFundingDeltas(raw), [{ ts: T, coin: 'SAND', usdc: -0.062148 }]);
  assert.deepEqual(parseFundingDeltas(null), []);
});

test('sumFunding: окно включительно, фильтр по монете', () => {
  assert.equal(sumFunding(deltas, { start: T + 2 * H, end: T + 2 * H }), -0.109204 + 0.5);
  assert.equal(sumFunding(deltas, { start: T + 2 * H, end: T + 2 * H, coin: 'SAND' }), -0.109204);
});

test('tradeFunding: начисление в 18:00:00 попадает в сделку, закрытую в 18:00:09', () => {
  const entry = T + H + 44 * 60_000;
  const close = T + 2 * H + 9_000;
  assert.equal(tradeFunding(deltas, 'SAND', entry, close), -0.109204);
});

test('tradeFunding: начисления до входа и по другим монетам не считаются', () => {
  assert.equal(tradeFunding(deltas, 'SAND', T + 10 * 60_000, T + 20 * 60_000), 0);
  assert.equal(tradeFunding(deltas, 'ETH', T, T + 3 * H), 0);
});

test('tradeFunding: без времени закрытия — ноль', () => {
  assert.equal(tradeFunding(deltas, 'SAND', T, null), 0);
});

test('tradeNet: цена − комиссии + фандинг', () => {
  const net = tradeNet({ pnl: 0.230388, fee: 0.050883, funding: -0.062148 });
  assert.ok(Math.abs(net - 0.117357) < 1e-9);
  assert.equal(tradeNet({ pnl: 1, fee: 0.1 }), 0.9);
});

test('attachFunding: фандинг только у закрытых сделок', () => {
  const [closed, open] = attachFunding([
    { coin: 'SAND', status: 'closed', entryTime: T - 60_000, closeTime: T + 60_000 },
    { coin: 'SAND', status: 'open', entryTime: T - 60_000, closeTime: null },
  ], deltas);
  assert.equal(closed.funding, -0.062148);
  assert.equal(open.funding, undefined);
});

test('closeMoney: строка БД берёт суммы своего round-trip', () => {
  const trips = [{ coin: 'SAND', status: 'closed', closeTime: T + 1_000, pnl: 0.23, fee: 0.05, funding: -0.06 }];
  const row = { coin: 'SAND', closed_at: T + 3_000, realized_pnl: 0.18, fee_paid: 0.05 };
  const m = closeMoney(trips, row, 5_000);
  assert.ok(Math.abs(m.pnl - 0.12) < 1e-9);
  assert.equal(m.fee, 0.05);
  assert.equal(m.funding, -0.06);
});

test('closeMoney: нет пары на бирже — суммы из БД, фандинг неизвестен', () => {
  const trips = [{ coin: 'SAND', status: 'closed', closeTime: T + 60_000, pnl: 1, fee: 0, funding: 0 }];
  const row = { coin: 'SAND', closed_at: T, realized_pnl: 0.18, fee_paid: 0.05 };
  assert.deepEqual(closeMoney(trips, row, 5_000), { pnl: 0.18, fee: 0.05, funding: null });
});

test('fetchAllFunding: склеивает страницы по 500 и не теряет монеты на стыке', async () => {
  const H0 = Date.UTC(2026, 3, 8);
  const all = [];
  for (let i = 0; i < 700; i++) {
    all.push({ time: H0 + Math.floor(i / 2) * H, delta: { coin: i % 2 ? 'BTC' : 'SAND', usdc: '0.01' } });
  }
  const calls = [];
  const out = await fetchAllFunding(async (startTime) => {
    calls.push(startTime);
    return all.filter((r) => r.time >= startTime).slice(0, 500);
  });
  assert.equal(out.length, 700);
  assert.equal(calls.length, 2);
});

test('fetchAllFunding: первая страница не пришла — null, кэш остаётся прежним', async () => {
  assert.equal(await fetchAllFunding(async () => null), null);
});
