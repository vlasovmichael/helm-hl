import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.CLOSE_FAKE_DEPS === '1';
const maybeTest = enabled ? test : test.skip;
const { productionClose } = await import('../src/modules/executor/close.js');
const fake = await import('./helpers/close-deps-fake.js');

const position = (overrides = {}) => ({ id: 17, coin: 'ETH', side: 'short', entry_time: Date.now() - 3_600_000, entry_price: 100, entry_equity: 100, size_usd: 200, ...overrides });
const signal = (overrides = {}) => ({ reason: 'stop', price: 100, ...overrides });
const called = (name) => fake.calls.filter(([n]) => n === name);

maybeTest('market-закрытие считает funding, пишет DB, cooldown и контракт уведомления', async () => {
  fake.resetCloseDeps();
  const out = await productionClose(signal(), position());
  assert.deepEqual(out, { ok: true, pnl: 2.4, holdHours: out.holdHours });
  assert.deepEqual(called('market')[0].slice(1), ['ETH', undefined, 0.03]);
  assert.equal(called('parse').length, 1);
  assert.equal(called('pnl')[0][4], 0.5);
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 110, realized_pnl: 2.4, fee_paid: 0.1, reason: 'stop', exitFeatures: null }]);
  assert.deepEqual(called('oid')[0].slice(1), [7, 'ETH', 'close', 17]);
  assert.equal(called('cooldown').length, 1);
  assert.equal(called('notifyClose').length, 1);
  assert.deepEqual(called('reconcile')[0].slice(1), ['ETH', 'CLOSE', { expectPosition: false }]);
});

maybeTest('limit-fill не банится за дрейф и использует maker-комиссию', async () => {
  fake.resetCloseDeps({ closeLimitEnabled: true, slippage: { ban: true, warn: false, label: '2%' } });
  await productionClose(signal(), position(), true);
  assert.deepEqual(called('limit')[0].slice(1), [{ coin: 'ETH', side: 'short' }]);
  assert.equal(called('market').length, 0);
  assert.equal(called('parse').length, 0);
  assert.equal(called('ban').length, 0);
  assert.equal(called('pnl')[0][5], 0.00003);
  assert.equal(called('notifyClose').length, 0);
});

maybeTest('market-slippage ban и убыточный circuit breaker отправляют оба уведомления', async () => {
  fake.resetCloseDeps({ slippage: { ban: true, warn: false, label: '3%' }, pnl: { pricePnl: -2, fundingPnl: 0, totalFee: 0.1, realizedPnl: -2.1, fundingSource: 'real' }, lossTrips: true });
  const out = await productionClose(signal(), position(), true);
  assert.equal(out.pnl, -2.1);
  assert.deepEqual(called('ban')[0].slice(1), ['ETH']);
  assert.equal(called('notifyBan').length, 1);
  assert.deepEqual(called('loss')[0].slice(1), ['ETH', -2.1]);
  assert.equal(called('notifyBreaker').length, 1);
});

maybeTest('сетевая ошибка ордера сохраняет позицию и уведомляет об ошибке', async () => {
  fake.resetCloseDeps({ marketError: new Error('network down') });
  assert.deepEqual(await productionClose(signal(), position()), { ok: false });
  assert.equal(called('dbClose').length, 0);
  assert.deepEqual(called('notifyFailed')[0][1], { coin: 'ETH', error: 'Ордер не отправлен (сетевая ошибка):\n<code>network down</code>', positionStillOpen: true });
});

maybeTest('обычный отказ биржи не закрывает DB и уведомляет', async () => {
  fake.resetCloseDeps({ parsedFill: { ok: false, error: 'insufficient margin' } });
  assert.deepEqual(await productionClose(signal(), position()), { ok: false });
  assert.equal(called('dbClose').length, 0);
  assert.deepEqual(called('notifyRejected')[0][1], { coin: 'ETH', error: 'insufficient margin' });
});

maybeTest('reduce-only отказ при исчезнувшей позиции синхронизирует реальный round trip', async () => {
  let reads = 0;
  fake.resetCloseDeps({
    positions: () => (++reads === 1 ? [{ position: { coin: 'ETH', cumFunding: { sinceOpen: '0' } } }] : []),
    parsedFill: { ok: false, error: 'Reduce only order would increase position' },
    roundTrip: { fee: 1.2, pnl: -3, closePx: 90, closedAt: 123 },
    classified: { reason: 'sl_trigger', fee: 0.2, pnl: -2, closePx: 91, closedAt: 124 },
  });
  assert.deepEqual(await productionClose(signal(), position()), { ok: false });
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 90, realized_pnl: -4.2, fee_paid: 1.2, closed_at: 123, reason: 'sl_trigger' }]);
  assert.equal(called('notifyExternal').length, 1);
  assert.equal(called('notifyRejected').length, 0);
});

maybeTest('No position found при отправке тоже идёт в external-close, а плохая equity не рисует убыток', async () => {
  fake.resetCloseDeps({ marketError: new Error('No position found'), summary: { equity: 10 } });
  assert.deepEqual(await productionClose(signal(), position()), { ok: false });
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 0, realized_pnl: 0, fee_paid: 0, closed_at: undefined, reason: 'external_close_detected_on_exit' }]);
  assert.equal(called('notifyExternal').length, 1);
});

maybeTest('adopt сохраняет MFE/MAE и чистит оба shadow-состояния', async () => {
  fake.resetCloseDeps();
  await productionClose(signal({ reason: 'adopt_trail_tp', peakPct: 6, giveBackPct: 2 }), position({ strategy_id: 'adopt' }), true);
  const features = called('dbClose')[0][2].exitFeatures;
  assert.deepEqual(features, { mfe_pct: 4, mae_pct: -2, mfe_usd: 8, mae_usd: -4, hold_seconds: features.hold_seconds, trail_peak_pct: 6, trail_give_back_pct: 2 });
  assert.equal(called('timeCut').length, 1);
  assert.equal(called('trail').length, 1);
  assert.equal(called('clearTrail').length, 1);
  assert.equal(called('clearAdopt').length, 1);
});

maybeTest('same-side сверка различает long/short, игнорирует нулевой размер и fail-soft при ошибке', async () => {
  const rejected = { ok: false, error: 'No position found' };
  fake.resetCloseDeps({ parsedFill: rejected, positions: [{ position: { coin: 'ETH', szi: '-2', cumFunding: {} } }] });
  await productionClose(signal(), position({ side: 'short' }));
  assert.equal(called('notifyRejected').length, 1);
  assert.equal(called('dbClose').length, 0);
  fake.resetCloseDeps({ parsedFill: rejected, positions: [{ position: { coin: 'ETH', szi: '2', cumFunding: {} } }] });
  await productionClose(signal(), position({ side: 'long' }));
  assert.equal(called('notifyRejected').length, 1);
  fake.resetCloseDeps({ parsedFill: rejected, positions: [null, { position: { coin: 'ETH', szi: '0' } }] });
  await productionClose(signal(), position());
  assert.equal(called('dbClose').length, 1);
  fake.resetCloseDeps({ parsedFill: rejected, positionsError: new Error('state down') });
  await productionClose(signal(), position());
  assert.equal(called('notifyRejected').length, 1);
  assert.equal(called('dbClose').length, 0);
});

maybeTest('funding fallback не меняет успешное закрытие при отсутствии, мусоре и ошибке источника', async () => {
  for (const options of [
    { positions: [] },
    { positions: [{ position: { coin: 'ETH', cumFunding: { sinceOpen: 'oops' } } }] },
    { positionsError: new Error('down') },
  ]) {
    fake.resetCloseDeps(options);
    assert.equal((await productionClose(signal(), position(), true)).ok, true);
    assert.equal(called('pnl')[0][4], null);
  }
});

maybeTest('external close берёт fallback classifyClose, переносит equity и переживает сбой fills', async () => {
  fake.resetCloseDeps({
    marketError: new Error('No position found'), summary: { equity: 112 },
    classified: { reason: 'tp_trigger', fee: 0.4, pnl: 3, closePx: 115, closedAt: 99 },
  });
  await productionClose(signal(), position());
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 115, realized_pnl: 2.6, fee_paid: 0.4, closed_at: 99, reason: 'tp_trigger' }]);
  assert.equal(called('notifyExternal')[0][1].estimatedPnl, 2.6);
  fake.resetCloseDeps({ marketError: new Error('No position found'), summaryError: new Error('summary down'), fillsError: new Error('fills down') });
  await productionClose(signal(), position());
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 0, realized_pnl: 0, fee_paid: 0, closed_at: undefined, reason: 'external_close_detected_on_exit' }]);
});

maybeTest('предупреждение slippage, long-направление и тихое уведомление сохраняют контракт close', async () => {
  fake.resetCloseDeps({ slippage: { ban: false, warn: true, label: '0.6%' } });
  await productionClose(signal(), position({ side: 'long' }), false);
  assert.deepEqual(called('slippage')[0].slice(1), [100, 110, 'SELL']);
  assert.match(called('log:warn')[0][1], /SLIPPAGE #ETH SELL: expected \$100 → fill \$110 \(0.6%\)/);
  assert.equal(called('notifyClose')[0][1].side, 'long');
});

maybeTest('adopt breakeven берёт peak из состояния, а нулевой размер не превращает MFE в число', async () => {
  fake.resetCloseDeps();
  await productionClose(signal({ reason: 'adopt_breakeven_ratchet' }), position({ strategy_id: 'adopt', size_usd: 0 }), true);
  const features = called('dbClose')[0][2].exitFeatures;
  assert.equal(features.trail_peak_pct, 9);
  assert.equal(features.trail_give_back_pct, null);
  assert.equal(features.mfe_usd, 0);
  assert.equal(features.mae_usd, -0);
});
