import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
const maybeTest = process.env.LEDGER_FAKE_DEPS === '1' ? test : test.skip;

const { getMonthlyLedger } = await import('../src/modules/ledger.js');
const fills = await import('./helpers/ledger-fills-fake.js');
const funding = await import('./helpers/ledger-funding-fake.js');
const realNow = Date.now;
let now = Date.UTC(2026, 9, 5, 12);
Date.now = () => now;
after(() => { Date.now = realNow; });

maybeTest('ledger агрегирует bot/adopted/manual, комиссии, funding и дневную разбивку', async () => {
  fills.setTrades([
    { status: 'closed', source: 'bot', pnl: 10, fee: 1, sizeUsd: 100, closeTime: now },
    { status: 'closed', source: 'adopted', pnl: -3, fee: 0.5, sizeUsd: 40, closeTime: now },
    { status: 'closed', source: 'manual', pnl: 2, fee: 0.2, sizeUsd: 20, closeTime: now },
    { status: 'open', source: 'manual', pnl: 99, fee: 9, sizeUsd: 9, closeTime: now },
  ]);
  funding.setFunding([{ ts: now, usdc: 1.25 }]);
  const result = await getMonthlyLedger();
  assert.equal(result.live, true); assert.equal(result.startDate, '2026-04-08');
  assert.equal(result.months.length, 1);
  const [month] = result.months;
  assert.equal(month.month, '2026-10'); assert.equal(month.botNet, 9); assert.equal(month.adoptedNet, -3.5); assert.equal(month.manualNet, 1.8);
  assert.equal(month.funding, 1.25); assert.equal(month.fees, 1.7); assert.equal(month.net, 8.55); assert.equal(month.cumulativeNet, 8.55);
  assert.equal(month.botWinRate, 100); assert.equal(month.adoptedWinRate, 0); assert.equal(month.manualWinRate, 100);
  assert.equal(month.feesBp, 53.12); assert.deepEqual(month.days, [{ date: '2026-10-05', week: '2026-10-05', botNet: 9, botCount: 1, botWins: 1, adoptedNet: -3.5, adoptedCount: 1, adoptedWins: 0, manualNet: 1.8, manualCount: 1, manualWins: 1, fees: 1.7, feesBp: 53.12, funding: 1.25, net: 8.55 }]);
  assert.equal(result.totals.net, 8.55); assert.equal(result.totals.botCount, 1); assert.equal(result.totals.adoptedCount, 1);
});

maybeTest('ledger кэширует до TTL и после TTL пересчитывает новые данные', async () => {
  const first = await getMonthlyLedger();
  fills.setTrades([{ status: 'closed', source: 'manual', pnl: 7, fee: 0, sizeUsd: 10, closeTime: now }]); funding.setFunding([]);
  assert.equal(await getMonthlyLedger(), first);
  now += 60_001;
  const refreshed = await getMonthlyLedger();
  assert.notEqual(refreshed, first); assert.equal(refreshed.months[0].manualNet, 7); assert.equal(refreshed.totals.net, 7);
});

maybeTest('ledger даёт нулевые ставки и bp без сделок/оборота', async () => {
  now += 60_001; fills.setTrades([]); funding.setFunding([]);
  const result = await getMonthlyLedger();
  assert.deepEqual(result.months, []);
  assert.deepEqual(result.totals, { botNet: 0, adoptedNet: 0, manualNet: 0, fees: 0, funding: 0, net: 0, botCount: 0, adoptedCount: 0, manualCount: 0, botWins: 0, adoptedWins: 0, manualWins: 0, botWinRate: 0, adoptedWinRate: 0, manualWinRate: 0 });
});
