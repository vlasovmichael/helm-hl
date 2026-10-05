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

maybeTest('close публикует полный журнал успешного исполнения с направлениями PnL', async () => {
  fake.resetCloseDeps({
    pnl: { pricePnl: -2, fundingPnl: -0.5, totalFee: 0.1, realizedPnl: -2.6, fundingSource: 'apy' },
  });
  await productionClose(signal({ reason: 'time_stop', price: 101 }), position({ side: 'long' }), true);
  const info = called('log:info').map(([, message]) => message);
  assert.ok(info.some((message) => /PROD CLOSE LONG #ETH — reason: time_stop \| held: 1\.0h \| markPrice: \$101/.test(message)));
  assert.ok(info.includes('[Executor] PROD CLOSE #ETH — cumFunding.sinceOpen=-0.5 → realFundingUsd=$0.500000'));
  assert.ok(info.includes('[Executor] ⏳ Re-entry cooldown set: #ETH → 15min'));
  assert.ok(info.some((message) => /oid: 7 \| filled: 2 @ \$110 \| slippage: 0\.00% \| pricePnl: \$-2\.0000 \| fundingPnl: \$-0\.5000 \(apy\) \| fees: \$0\.1000 \| total: \$-2\.6000/.test(message)));
  assert.deepEqual(called('hook')[0].slice(1), ['afterClose', {
    coin: 'ETH', pnl: -2.6, holdHours: called('hook')[0][2].holdHours,
    reason: 'time_stop', fill: { ok: true, oid: 7, totalSz: 2, avgPx: 110 }, mode: 'PRODUCTION', side: 'long',
  }]);
});

maybeTest('external close фильтрует fills, пишет round-trip и публикует наблюдаемую классификацию', async () => {
  const closedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
  fake.resetCloseDeps({
    marketError: new Error('No position found'), summary: { equity: 130 },
    userFills: [{ coin: 'btc' }, { coin: 'ETH' }],
    classified: { reason: 'external_unknown', fee: NaN, pnl: NaN, closePx: NaN, closedAt: NaN },
    roundTrip: { fee: 1.25, pnl: 6, closePx: 113, closedAt },
  });
  const externalPosition = position();
  await productionClose(signal(), externalPosition);
  assert.equal(called('fills')[0][1], externalPosition.entry_time - 60_000, 'окно fills начинается за минуту до entry');
  assert.deepEqual(called('classify')[0][2], [{ coin: 'ETH' }]);
  assert.deepEqual(called('roundTrip')[0][2], [{ coin: 'ETH' }]);
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 113, realized_pnl: 4.75, fee_paid: 1.25, closed_at: closedAt, reason: 'external_close_detected_on_exit' }]);
  const info = called('log:info').map(([, message]) => message);
  assert.ok(info.some((message) => message.includes("external classified as 'external_close_detected_on_exit' | pnl(fills)=$6.0000 gross, fee=$1.2500 (round_trip) → net $4.7500 | closePx(fills)=$113 | closedAt(fills)=2026-01-02T03:04:05.000Z")));
  assert.ok(info.includes('[Executor] ✅ DB synced: #ETH (id=17) → CLOSED | reason: external_close_detected_on_exit | est. PnL: $4.7500'));
});

maybeTest('external close отличает валидную equity от отсутствующей и не теряет уведомление при DB-ошибке', async () => {
  fake.resetCloseDeps({ marketError: new Error('No position found'), summary: { equity: 125 }, dbError: new Error('disk full') });
  await productionClose(signal(), position());
  assert.equal(called('notifyExternal')[0][1].estimatedPnl, 25);
  assert.equal(called('notifyExternal')[0][1].equity, 125);
  assert.ok(called('log:error').some(([, message]) => message === '[Executor] DB close failed: disk full'));

  fake.resetCloseDeps({ marketError: new Error('No position found'), summary: { equity: undefined } });
  await productionClose(signal(), position({ entry_equity: undefined }));
  assert.ok(called('log:warn').some(([, message]) => message === '[Executor] PROD CLOSE #ETH — equity unreadable ($undefined), est. PnL not computable, writing 0 instead of fake negative.'));
});

maybeTest('все исходы защитного close оставляют операторский журнал и контракт уведомления', async () => {
  fake.resetCloseDeps({ marketError: new Error('network down') });
  await productionClose(signal(), position());
  assert.ok(called('log:error').some(([, message]) => message === '[Executor] PROD CLOSE #ETH — order request failed: network down'));

  fake.resetCloseDeps({ parsedFill: { ok: false, error: 'insufficient margin' } });
  await productionClose(signal(), position());
  assert.ok(called('log:error').some(([, message]) => message === '[Executor] PROD CLOSE #ETH — exchange rejected: insufficient margin'));

  fake.resetCloseDeps({ parsedFill: { ok: false, error: 'No position found' }, positionsError: new Error('state down') });
  await productionClose(signal(), position());
  assert.ok(called('log:warn').some(([, message]) => message === '[Executor] #ETH — не смог сверить позу с биржей: state down'));
  assert.ok(called('log:warn').some(([, message]) => message === '[Executor] PROD CLOSE #ETH — reduce-only отвергнут, но поза непроверяема → оставляю integrity разбираться.'));
});

maybeTest('сверка same-side принимает сырой ответ HL, только ненулевой размер и сторону DB по умолчанию', async () => {
  const rejected = { ok: false, error: 'No position found' };
  fake.resetCloseDeps({ parsedFill: rejected, positions: [{ coin: 'ETH', szi: '-3', cumFunding: {} }] });
  await productionClose(signal(), position({ side: undefined }));
  assert.equal(called('notifyRejected').length, 1, 'short same-side не должен синхронизировать DB');
  fake.resetCloseDeps({ parsedFill: rejected, positions: [{ coin: 'ETH', szi: '3', cumFunding: {} }] });
  await productionClose(signal(), position({ side: 'short' }));
  assert.equal(called('dbClose').length, 1, 'long — другая сторона и DB надо синхронизировать');
  fake.resetCloseDeps({ parsedFill: rejected, positions: [{ coin: 'ETH', szi: '-0.01', cumFunding: {} }] });
  await productionClose(signal(), position({ side: 'long' }));
  assert.equal(called('dbClose').length, 1);
});

maybeTest('funding читает сырой position, а все fallback-причины остаются операторски различимы', async () => {
  fake.resetCloseDeps({ positions: [{ position: { coin: 'ETH', cumFunding: { sinceOpen: '0.25' } } }] });
  await productionClose(signal(), position(), true);
  assert.equal(called('pnl')[0][4], -0.25);

  fake.resetCloseDeps({ positions: [] });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:info').some(([, m]) => m === '[Executor] PROD CLOSE #ETH — position absent in clearinghouseState (external close path); skipping cumFunding read'));

  fake.resetCloseDeps({ positions: [{ position: { coin: 'ETH', cumFunding: { sinceOpen: 'bad' } } }] });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:warn').some(([, m]) => m === '[Executor] PROD CLOSE #ETH — cumFunding.sinceOpen unparseable (bad), fallback to APY estimate'));

  fake.resetCloseDeps({ positionsError: new Error('reader down') });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:warn').some(([, m]) => m === '[Executor] PROD CLOSE #ETH — failed to read cumFunding (reader down), fallback to APY estimate'));
});

maybeTest('границы external equity и пустая классификация не подменяют денежную запись', async () => {
  for (const [entryEquity, equity, pnl] of [[0, 130, 0], [100, 50, -50], [100, 0, 0]]) {
    fake.resetCloseDeps({ marketError: new Error('No position found'), summary: { equity } });
    await productionClose(signal(), position({ entry_equity: entryEquity }));
    assert.equal(called('dbClose')[0][2].realized_pnl, pnl);
  }
  fake.resetCloseDeps({ marketError: new Error('No position found'), classified: { reason: 'external_unknown', fee: NaN, pnl: NaN, closePx: NaN, closedAt: NaN } });
  await productionClose(signal(), position());
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 0, realized_pnl: 10, fee_paid: 0, closed_at: undefined, reason: 'external_close_detected_on_exit' }]);
});

maybeTest('slippage и circuit breaker передают точные сроки, а спокойный close оставляет debug', async () => {
  fake.resetCloseDeps({ slippage: { ban: true, warn: false, label: '9%' } });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:error').some(([, m]) => m === '[Executor] 🚫 SLIPPAGE BAN #ETH BUY: 9% (>1.5%) — trading paused for 10min'));
  assert.deepEqual(called('notifyBan')[0][1], { coin: 'ETH', slipLabel: '9%', banMinutes: 10 });

  fake.resetCloseDeps({ pnl: { pricePnl: 1, fundingPnl: 2, totalFee: 0.1, realizedPnl: 2.9, fundingSource: 'real' } });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:debug').some(([, m]) => m === '[Executor] Slippage #ETH BUY: 0.00%'));

  fake.resetCloseDeps({ pnl: { pricePnl: -1, fundingPnl: 0, totalFee: 0.1, realizedPnl: -1.1, fundingSource: 'real' }, lossTrips: true });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:error').some(([, m]) => m === '[Executor] 🛑 CIRCUIT BREAKER TRIPPED after PROD loss #ETH ($-1.1000)'));
  assert.deepEqual(called('notifyBreaker')[0][1], { losses: 3, pauseMinutes: 30, lastCoin: 'ETH', lastPnl: -1.1 });
});

maybeTest('успешный прибыльный close сохраняет тейкерскую комиссию и знаки PnL в журнале', async () => {
  fake.resetCloseDeps({ pnl: { pricePnl: 2, fundingPnl: 0.5, totalFee: 0.1, realizedPnl: 2.4, fundingSource: 'real' } });
  await productionClose(signal(), position(), true);
  assert.equal(called('pnl')[0][5], 0.0002);
  assert.ok(called('log:info').some(([, m]) => /pricePnl: \+\$2\.0000 \| fundingPnl: \+\$0\.5000 \(real\) \| fees: \$0\.1000 \| total: \+\$2\.4000/.test(m)));
});

maybeTest('limit close журналирует дрейф рынка, но не вызывает бан', async () => {
  fake.resetCloseDeps({ closeLimitEnabled: true, slippage: { ban: true, warn: false, label: '4%' } });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:warn').some(([, m]) => m === '[Executor] ⚠️ #ETH цена ушла на 4% за время ожидания мейкер-выхода (kind=limit) — это дрейф рынка, не слиппедж; бан не ставлю'));
  assert.equal(called('ban').length, 0);
});

maybeTest('fallback classifyClose пишет close_fills и не пропускает нулевую границу equity', async () => {
  fake.resetCloseDeps({
    marketError: new Error('No position found'), summary: { equity: 49 },
    classified: { reason: 'tp_trigger', fee: 0.4, pnl: 3, closePx: 115, closedAt: 0 },
  });
  await productionClose(signal(), position());
  assert.deepEqual(called('dbClose')[0].slice(1), [17, { close_price: 115, realized_pnl: 2.6, fee_paid: 0.4, closed_at: 0, reason: 'tp_trigger' }]);
  assert.ok(called('log:warn').some(([, m]) => m === '[Executor] PROD CLOSE #ETH — equity $49.00 implausibly low vs entry_equity $100.00 (likely API glitch), writing 0 instead of fake negative. Check Reporter alert for real PnL.'));
  assert.ok(called('log:info').some(([, m]) => m.includes("fee=$0.4000 (close_fills) → net $2.6000 | closePx(fills)=$115 | closedAt(fills)=n/a")));
});

maybeTest('adopt сохраняет точный hold_seconds и null MFE/MAE без искусственных долларов', async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_600;
  try {
    fake.resetCloseDeps();
    await productionClose(signal({ reason: 'other' }), position({ strategy_id: 'adopt', entry_time: 1_000_000, size_usd: 10 }), true);
    assert.deepEqual(called('dbClose')[0][2].exitFeatures, { mfe_pct: 4, mae_pct: -2, mfe_usd: 0.4, mae_usd: -0.2, hold_seconds: 1001 });
  } finally {
    Date.now = originalNow;
  }
});

maybeTest('нулевой PnL сохраняет плюсовые знаки журнала, но не включает circuit breaker', async () => {
  fake.resetCloseDeps({ pnl: { pricePnl: 0, fundingPnl: 0, totalFee: 0, realizedPnl: 0, fundingSource: 'real' } });
  await productionClose(signal(), position(), true);
  assert.ok(called('log:info').some(([, m]) => /pricePnl: \+\$0\.0000 \| fundingPnl: \+\$0\.0000 \(real\) \| fees: \$0\.0000 \| total: \+\$0\.0000/.test(m)));
  assert.equal(called('loss').length, 0);
  assert.equal(called('notifyBreaker').length, 0);
});

maybeTest('adopt не конвертирует отсутствующие MFE/MAE в нулевые доллары', async () => {
  fake.resetCloseDeps({ mfeMae: { mfePct: null, maePct: null } });
  await productionClose(signal(), position({ strategy_id: 'adopt', size_usd: 100 }), true);
  const features = called('dbClose')[0][2].exitFeatures;
  assert.equal(features.mfe_usd, null);
  assert.equal(features.mae_usd, null);
});
