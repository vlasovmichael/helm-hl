import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.RECONCILER_FAKE_DEPS === '1';
const maybeTest = enabled ? test : test.skip;
const reconciler = await import('../src/modules/executor/reconciler.js');
const exchange = await import('./helpers/reconciler-exchange-fake.js');
const ntfy = await import('./helpers/reconciler-ntfy-fake.js');
const logger = await import('./helpers/reconciler-logger-fake.js');

const realSetTimeout = globalThis.setTimeout;
before(() => { globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; }; });
after(() => { globalThis.setTimeout = realSetTimeout; });

function reset(options) { exchange.resetExchange(options); ntfy.resetNtfy(); logger.resetLogger(); }

maybeTest('fetchPositionState находит монету без учёта регистра и суффикса, но нулевой размер считает отсутствием', async () => {
  reset({ nextPositions: [{ position: { coin: 'eth-PERP', szi: '-2', entryPx: '100' } }] });
  assert.deepEqual(await reconciler.fetchPositionState('ETH'), { hasPos: true, szi: -2, posData: { coin: 'eth-PERP', szi: '-2', entryPx: '100' } });
  reset({ nextPositions: [{ coin: '@ETH', szi: '0' }] });
  assert.equal((await reconciler.fetchPositionState('eth')).hasPos, false);
});

maybeTest('успешное открытие подтверждается первым polling и сверяет допустимый размер', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '2', entryPx: '100' } }] });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true, expectedSzUsd: 205 });
  assert.equal(exchange.calls.filter((x) => x === 'positions').length, 1);
  assert.equal(exchange.calls.includes('full'), false);
  assert.equal(ntfy.notifications.length, 0);
  assert.match(logger.logs.at(-1)[1], /size OK/);
});

maybeTest('успешное закрытие подтверждается отсутствием позиции', async () => {
  reset({ nextPositions: [] });
  await reconciler.reconcile('ETH', 'CLOSE', { expectPosition: false });
  assert.equal(ntfy.notifications.length, 0);
  assert.match(logger.logs.at(-1)[1], /no position confirmed/);
});

maybeTest('несовпадение размера только предупреждает, без тревоги', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '1', entryPx: '100' } }] });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true, expectedSzUsd: 200 });
  assert.equal(ntfy.notifications.length, 0);
  assert.ok(logger.logs.some(([level, message]) => level === 'warn' && message === '[Reconcile] ⚠️ OPEN #ETH — size mismatch: expected ~$200.00, actual ~$100.00 (Δ50.0%)'));
});

maybeTest('после исчерпания light polling heavy check подтверждает запоздавшую позицию', async () => {
  reset({ nextPositions: [], nextFullState: { assetPositions: [{ position: { coin: 'ETH', szi: '3', entryPx: '100' } }], marginSummary: { accountValue: '123' } } });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  assert.deepEqual(exchange.calls, ['positions', 'positions', 'positions', 'positions', 'positions', 'full']);
  assert.equal(ntfy.notifications.length, 0);
  assert.ok(logger.logs.some(([, message]) => /FOUND via final check/.test(message)));
});

maybeTest('heavy check подтверждает закрытие после запоздалого light endpoint', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '1' } }], nextFullState: { assetPositions: [], marginSummary: { accountValue: '123' } } });
  await reconciler.reconcile('ETH', 'CLOSE', { expectPosition: false });
  assert.equal(ntfy.notifications.length, 0);
  assert.ok(logger.logs.some(([, message]) => /absent confirmed via final check/.test(message)));
});

maybeTest('не найденная после final check позиция посылает срочную тревогу', async () => {
  reset({ nextPositions: [], nextFullState: { assetPositions: [], marginSummary: { accountValue: '9' } } });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  assert.equal(ntfy.notifications.length, 1);
  assert.equal(ntfy.notifications[0].title, '⚠️ Reconcile #ETH: позиции НЕТ на бирже');
  assert.equal(ntfy.notifications[0].message, 'После OPEN позиция не найдена (5 попыток + final check).\nПроверь вручную.');
  assert.deepEqual(ntfy.notifications[0].tags, ['rotating_light']);
  assert.equal(ntfy.notifications[0].urgent, true);
});

maybeTest('висящая после final check позиция посылает срочную тревогу', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '-1' } }], nextFullState: { assetPositions: [{ position: { coin: 'ETH', szi: '-1' } }], marginSummary: { accountValue: '9' } } });
  await reconciler.reconcile('ETH', 'CLOSE', { expectPosition: false });
  assert.equal(ntfy.notifications.length, 1);
  assert.match(ntfy.notifications[0].title, /ВСЁ ЕЩЁ открыта/);
  assert.match(ntfy.notifications[0].message, /szi=-1/);
});

maybeTest('сбой heavy check сохраняет последний light state и не пробрасывается наружу', async () => {
  reset({ nextPositions: [], nextFullState: {} });
  exchange.failFullState(new Error('down'));
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  assert.equal(ntfy.notifications.length, 1);
  assert.ok(logger.logs.some(([level, message]) => level === 'error' && /final check FAILED: down/.test(message)));
});

maybeTest('ошибка polling не бросается и логируется как fail-soft', async () => {
  reset(); exchange.failPositions(new Error('network'));
  await assert.doesNotReject(reconciler.reconcile('ETH', 'OPEN', { expectPosition: true }));
  assert.match(logger.logs.at(-1)[1], /Failed for OPEN #ETH: network/);
});

maybeTest('не сопоставляет чужую монету, пустой тикер и битую позицию', async () => {
  reset({ nextPositions: [null, {}, { position: { coin: 'BTC', szi: '2' } }] });
  assert.deepEqual(await reconciler.fetchPositionState('ETH'), { hasPos: false, szi: 0, posData: null });
  reset({ nextPositions: [{ position: { coin: '', szi: '2' } }] });
  assert.equal((await reconciler.fetchPositionState('ETH')).hasPos, false);
});

maybeTest('сопоставляет все документированные формы тикера и не принимает похожие', async () => {
  for (const coin of ['eth', 'ETH-PERP', '@eTh', 'ETH-perp']) {
    reset({ nextPositions: [{ position: { coin, szi: '1' } }] });
    assert.equal((await reconciler.fetchPositionState('ETH')).hasPos, true, coin);
  }
  reset({ nextPositions: [{ position: { coin: 'ETHX-PERP', szi: '1' } }] });
  assert.equal((await reconciler.fetchPositionState('ETH')).hasPos, false);
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '1' } }] });
  assert.equal((await reconciler.fetchPositionState(undefined)).hasPos, false);
});

maybeTest('polling делает backoff, пока позиция не появится на второй попытке', async () => {
  let attempt = 0;
  reset({ nextPositions: () => (++attempt === 1 ? [] : [{ position: { coin: 'ETH', szi: '1', entryPx: '100' } }]) });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  assert.deepEqual(exchange.calls, ['positions', 'positions']);
  assert.ok(logger.logs.some(([, message]) => /next in 2ms/.test(message)));
});

maybeTest('polling применяет удвоение и потолок backoff до heavy check', async () => {
  reset({ nextPositions: [] });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  const waits = logger.logs.filter(([, message]) => /waiting for position to index/.test(message)).map(([, message]) => message);
  assert.deepEqual(waits, [
    '[Reconcile] OPEN #ETH — waiting for position to index… (attempt 1/5, next in 2ms)',
    '[Reconcile] OPEN #ETH — waiting for position to index… (attempt 2/5, next in 10000ms)',
    '[Reconcile] OPEN #ETH — waiting for position to index… (attempt 3/5, next in 10000ms)',
    '[Reconcile] OPEN #ETH — waiting for position to index… (attempt 4/5, next in 10000ms)',
  ]);
});

maybeTest('диагностические сообщения содержат операцию, размер и данные full snapshot', async () => {
  reset({ nextPositions: [], nextFullState: { assetPositions: [], marginSummary: { accountValue: '12.5' } } });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  assert.ok(logger.logs.some(([level, message]) => level === 'info' && message === '[Reconcile] OPEN #ETH — waiting 1ms for exchange indexing…'));
  assert.ok(logger.logs.some(([level, message]) => level === 'info' && message === '[Reconcile] OPEN #ETH — final check: equity=$12.50 | total positions=0 | #ETH szi=0 hasPos=false'));
  assert.ok(logger.logs.some(([level, message]) => level === 'error' && message === '[Reconcile] ❌ OPEN #ETH — expected position but found NONE after 5 retries + final clearinghouseState check!'));
});

maybeTest('пограничная разница ровно tolerance считается допустимой', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '1', entryPx: '105' } }] });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true, expectedSzUsd: 100 });
  assert.ok(logger.logs.some(([level, message]) => level === 'info' && /size OK/.test(message)));
  assert.equal(logger.logs.some(([, message]) => /size mismatch/.test(message)), false);
});

maybeTest('heavy check пишет debug dump при подтверждённом расхождении', async () => {
  reset({ nextPositions: [], nextFullState: { assetPositions: [], marginSummary: { accountValue: '7' }, marker: 'snapshot' } });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true });
  assert.ok(logger.logs.some(([level, message]) => level === 'error' && /DEBUG DUMP/.test(message) && /snapshot/.test(message)));
});

maybeTest('тревога висящей позиции передаёт полный контракт ntfy', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '2' } }], nextFullState: { assetPositions: [{ position: { coin: 'ETH', szi: '2' } }], marginSummary: { accountValue: '1' } } });
  await reconciler.reconcile('ETH', 'CLOSE', { expectPosition: false });
  assert.deepEqual(ntfy.notifications[0], {
    title: '⚠️ Reconcile #ETH: позиция ВСЁ ЕЩЁ открыта',
    message: 'После CLOSE szi=2 (5 попыток + final check).\nВозможно, частичный fill. Проверь вручную.',
    tags: ['rotating_light'], urgent: true,
  });
});

maybeTest('не рассчитывает размер без положительного ожидания и не считает отсутствующую entryPx ценой', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '1' } }] });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true, expectedSzUsd: 0 });
  assert.equal(logger.logs.some(([, message]) => /size (OK|mismatch)/.test(message)), false);
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '1' } }] });
  await reconciler.reconcile('ETH', 'OPEN', { expectPosition: true, expectedSzUsd: 100 });
  assert.ok(logger.logs.some(([, message]) => /actual ~\$0\.00/.test(message)));
});
