import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.LIMIT_CLOSE_FAKE_DEPS === '1';
const maybeTest = enabled ? test : test.skip;
const { closeLimitFirst } = await import('../src/modules/executor/limitClose.js');
const exchange = await import('./helpers/limit-close-exchange-fake.js');
const retry = await import('./helpers/limit-close-retry-fake.js');
const parser = await import('./helpers/limit-close-fill-parser-fake.js');
const fills = await import('./helpers/limit-close-fills-fake.js');

function reset(options = {}) {
  exchange.resetExchange(options); retry.resetRetry(); parser.resetFillParser(); fills.setFills([]);
}
const immediate = (filled) => ({ response: { data: { statuses: [{ filled }] } } });
const resting = (oid = 8) => ({ response: { data: { statuses: [{ resting: { oid } }] } } });

maybeTest('закрывает short пассивным BUY по bid и возвращает мгновенный maker fill', async () => {
  reset({ nextLimitResult: immediate({ oid: 7, totalSz: '2', avgPx: '100' }) });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 7, totalSz: 2, avgPx: 100, kind: 'limit' });
  assert.deepEqual(exchange.calls, [['limit', { coin: 'ETH', isBuy: true, sz: 2, px: '100', tif: 'Alo', reduceOnly: true }]]);
  assert.deepEqual(retry.calls, [{ label: 'close-limit-ETH', maxRetries: 2, baseDelayMs: 1000 }]);
});

maybeTest('закрывает long пассивным SELL по ask', async () => {
  reset({ nextLimitResult: immediate({ oid: 8, totalSz: '2', avgPx: '101' }) });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'long' });
  assert.equal(result.avgPx, 101);
  assert.deepEqual(exchange.calls[0][1], { coin: 'ETH', isBuy: false, sz: 2, px: '101', tif: 'Alo', reduceOnly: true });
});

maybeTest('без позиции сообщает вызывающему external-close путь', async () => {
  reset({ nextPositions: [] });
  await assert.rejects(closeLimitFirst({ coin: 'ETH', side: 'long' }), /No position found/);
  assert.deepEqual(exchange.calls, []);
});

maybeTest('без цены стакана сразу добивает маркетом и сохраняет ответ fill-парсера', async () => {
  reset({ nextBook: { levels: [[], []] }, nextMarketResult: { any: 'response' } });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 22, totalSz: 2, avgPx: 99 } });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 22, totalSz: 2, avgPx: 99, kind: 'market' });
  assert.deepEqual(exchange.calls, [['market', ['ETH', undefined, 0.03]]]);
});

maybeTest('отказ лимитки добивает маркетом, но пробрасывает отказ без позиции', async () => {
  reset({ nextLimitResult: { response: { data: { statuses: ['post only rejected'] } } } });
  await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.equal(exchange.calls.at(-1)[0], 'market');
  reset({ nextLimitResult: { response: { data: { statuses: ['No position found'] } } } });
  await assert.rejects(closeLimitFirst({ coin: 'ETH', side: 'short' }), /No position found/);
  assert.equal(exchange.calls.some(([kind]) => kind === 'market'), false);
});

maybeTest('после частичного resting-ордера отменяет его и возвращает mixed VWAP всех fill-ов', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(18), nextPositions: () => (++n === 1 ? [{ position: { coin: 'ETH', szi: '-2' } }] : [{ position: { coin: 'ETH', szi: '-0.5' } }]) });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 9, totalSz: 0.5, avgPx: 101 } });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 2, px: 100 }]);
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.equal(exchange.calls.some(([kind]) => kind === 'cancel'), true);
  assert.equal(exchange.calls.at(-1)[0], 'market');
  assert.deepEqual(result, { ok: true, oid: 9, totalSz: 2, avgPx: 100, kind: 'mixed' });
});
