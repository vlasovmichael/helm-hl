import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
const maybeTest = process.env.PAPER_ENTRY_FAKE_DEPS === '1' ? test : test.skip;

const { planPaperExit } = await import('../src/modules/paperEntry.js');
const { resolvePrice, safeEquity, openPaperPosition } = await import('../src/modules/paperEntry.js');
const price = await import('./helpers/paper-entry-price-fake.js');
const exchange = await import('./helpers/paper-entry-exchange-fake.js');
const wallet = await import('./helpers/paper-entry-wallet-fake.js');
const gate = await import('./helpers/paper-entry-gate-fake.js');
const database = await import('./helpers/paper-entry-database-fake.js');
const reconcile = await import('./helpers/paper-entry-reconcile-fake.js');
const log = await import('./helpers/paper-entry-logger-fake.js');

beforeEach(() => {
  price.setLive(null); exchange.setMap(new Map()); wallet.setEquity(0); gate.setNanny(false);
  reconcile.setStop({ distPct: 2, basis: 'fixed' }); database.resetDatabase(); log.resetLogger();
});

maybeTest('paper exit: short получает стоп выше входа и цель ниже', () => {
  const plan = planPaperExit({ side: 'short', entry: 100, stopDistPct: 2, sizeUsd: 50 });
  assert.equal(plan.slPrice, 102);
  assert.equal(plan.tpPrice, 98);
  assert.equal(plan.tpDistPct, 2);
  assert.deepEqual(plan.rungs, []);
});

maybeTest('paper exit: long зеркален short', () => {
  const plan = planPaperExit({ side: 'long', entry: 100, stopDistPct: 2.5, sizeUsd: 50 });
  assert.equal(plan.slPrice, 97.5);
  assert.ok(Math.abs(plan.tpPrice - 102.5) < 1e-10);
  assert.equal(plan.tpDistPct, 2.5);
});

maybeTest('paper exit: TP и стоп меняются с дистанцией риска, не с размером позиции', () => {
  const small = planPaperExit({ side: 'long', entry: 80, stopDistPct: 1, sizeUsd: 11 });
  const large = planPaperExit({ side: 'long', entry: 80, stopDistPct: 4, sizeUsd: 1000 });
  assert.equal(small.slPrice, 79.2);
  assert.equal(small.tpPrice, 80.8);
  assert.equal(large.slPrice, 76.8);
  assert.equal(large.tpPrice, 83.2);
});

maybeTest('resolvePrice предпочитает валидную WS-цену, нормализует тикер и отбрасывает мусор', async () => {
  price.setLive({ price: 123 });
  assert.equal(await resolvePrice('sol'), 123);
  price.setLive({ price: 0 }); exchange.setMap(new Map([['SOL', 99]]));
  assert.equal(await resolvePrice('sol'), 99);
  exchange.setMap(new Map([['SOL', 0]]));
  assert.equal(await resolvePrice('sol'), null);
  exchange.fail();
  assert.equal(await resolvePrice('sol'), null);
});

maybeTest('safeEquity принимает только положительное конечное депо и fail-soft ошибки', async () => {
  wallet.setEquity(42); assert.equal(await safeEquity(), 42);
  wallet.setEquity(0); assert.equal(await safeEquity(), 0);
  wallet.setEquity(NaN); assert.equal(await safeEquity(), 0);
  wallet.fail(); assert.equal(await safeEquity(), 0);
});

maybeTest('openPaperPosition валидирует вход до вызова фида', async () => {
  assert.deepEqual(await openPaperPosition({ coin: '', side: 'long', sizeUsd: 1 }), { ok: false, error: 'coin required' });
  assert.deepEqual(await openPaperPosition({ coin: 'SOL', side: 'flat', sizeUsd: 1 }), { ok: false, error: 'side must be long|short' });
  assert.deepEqual(await openPaperPosition({ coin: 'SOL', side: 'long', sizeUsd: 0 }), { ok: false, error: 'sizeUsd must be > 0' });
  assert.deepEqual(await openPaperPosition({ coin: 'SOL', side: 'long', sizeUsd: 1 }), { ok: false, error: 'no live price for SOL' });
});

maybeTest('openPaperPosition берёт fallback entryPrice, чистит тикер и сохраняет без плана при выключенной няньке', async () => {
  wallet.setEquity(50);
  const result = await openPaperPosition({ coin: '@sol-perp', side: 'short', sizeUsd: 20, leverage: 3, strategyId: 'manual_paper', entryPrice: 100 });
  assert.deepEqual(result, { ok: true, id: 1, entryPrice: 100, slPrice: null, tpPrice: null, rungs: [] });
  assert.equal(database.saved.length, 1);
  assert.deepEqual(database.saved[0], {
    coin: 'SOL', size_usd: 20, entry_price: 100, entry_apy: 0, entry_time: database.saved[0].entry_time,
    mode: 'PAPER', strategy_id: 'manual_paper', side: 'short', leverage: 3, entry_equity: 50, sl_price: null, tp_price: null,
  });
  assert.match(log.messages[0][1], /OPEN short #SOL/);
});

maybeTest('openPaperPosition строит nanny-план, TP-сетку и передаёт ATR-стоп в запись', async () => {
  price.setLive({ price: 100 }); wallet.setEquity(0); gate.setNanny(true);
  reconcile.setStop({ distPct: 4, basis: 'atr' });
  const { config } = await import('./helpers/paper-entry-config-fake.js');
  config.trading.adoptTpGridLegs = [{ frac: 0.5, r: 1 }];
  const result = await openPaperPosition({ coin: 'sol', side: 'long', sizeUsd: 40, leverage: 2, strategyId: 'manual_paper' });
  assert.equal(result.slPrice, 96); assert.equal(result.tpPrice, 104);
  assert.deepEqual(result.rungs, [{ px: 104, usd: 20, label: '1R' }]);
  assert.equal(database.saved[0].entry_equity, null);
  assert.equal(database.saved[0].sl_price, 96); assert.equal(database.saved[0].tp_price, 104);
  assert.match(log.messages[0][1], /ATR/); assert.match(log.messages[0][1], /сетка 1 ступ/);
  config.trading.adoptTpGridLegs = [];
});

maybeTest('ошибка расчёта стопа не отменяет бумажный вход и оставляет план пустым', async () => {
  price.setLive({ price: 10 }); gate.setNanny(true); reconcile.fail(new Error('ATR unavailable'));
  const result = await openPaperPosition({ coin: 'SOL', side: 'long', sizeUsd: 10, leverage: 1, strategyId: 'manual_paper', tag: 'signal' });
  assert.deepEqual(result, { ok: true, id: 1, entryPrice: 10, slPrice: null, tpPrice: null, rungs: [] });
  assert.match(log.messages[0][1], /ATR unavailable/);
  assert.match(log.messages[1][1], /\[signal\] OPEN/);
});
