import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.LIMIT_CLOSE_FAKE_DEPS === '1';
const maybeTest = enabled ? test : test.skip;
const { closeLimitFirst } = await import('../src/modules/executor/limitClose.js');
const exchange = await import('./helpers/limit-close-exchange-fake.js');
const retry = await import('./helpers/limit-close-retry-fake.js');
const parser = await import('./helpers/limit-close-fill-parser-fake.js');
const fills = await import('./helpers/limit-close-fills-fake.js');
const timing = await import('./helpers/limit-close-config-fake.js');
const logger = await import('./helpers/limit-close-logger-fake.js');

function reset(options = {}) {
  exchange.resetExchange(options); retry.resetRetry(); parser.resetFillParser(); fills.resetFills();
  timing.setTiming(); logger.resetLogger();
}
const immediate = (filled) => ({ response: { data: { statuses: [{ filled }] } } });
const resting = (oid = 8) => ({ response: { data: { statuses: [{ resting: { oid } }] } } });

maybeTest('закрывает short пассивным BUY по bid и возвращает мгновенный maker fill', async () => {
  reset({ nextLimitResult: immediate({ oid: 7, totalSz: '2', avgPx: '100' }) });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 7, totalSz: 2, avgPx: 100, kind: 'limit' });
  assert.deepEqual(exchange.calls, [['limit', { coin: 'ETH', isBuy: true, sz: 2, px: '100', tif: 'Alo', reduceOnly: true }]]);
  assert.deepEqual(retry.calls, [{ label: 'close-limit-ETH', maxRetries: 2, baseDelayMs: 1000 }]);
  assert.match(logger.calls[0][1], /maker-fill сразу: 2 @ \$100/);
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
  reset({ nextLimitResult: { response: { data: { statuses: [{ error: 'post only rejected' }] } } } });
  await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(exchange.calls.at(-1), ['market', ['ETH', undefined, 0.03]]);
  assert.match(logger.calls[0][1], /лимитка не встала/);
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

maybeTest('отделяет нужную позицию и требует пригодную цену книги', async () => {
  reset({
    nextPositions: [{ position: { coin: 'BTC', szi: '-9' } }, { position: { coin: 'eth', szi: '3' } }],
    nextBook: { levels: [[{ px: 'oops' }], [{ px: null }]] },
  });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'long' });
  assert.equal(result.kind, 'market');
  assert.deepEqual(exchange.calls, [['market', ['ETH', undefined, 0.03]]]);
  assert.match(logger.calls[0][1], /bid=null ask=null/);
});

maybeTest('не падает на неполных ответах позиций и книги, а выбирает защитный market-путь', async () => {
  reset({ nextPositions: [null, { position: {} }, { position: { coin: 'ETH', szi: '-2' } }], nextBook: {} });
  let result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.equal(result.kind, 'market');
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '-2' } }], nextBook: { levels: [[], [{ px: '101' }]] } });
  result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.equal(result.kind, 'market');
  reset({ nextPositions: [{ position: { coin: 'ETH', szi: '-2' } }], nextBook: { levels: [[{ px: '100' }], []] } });
  result = await closeLimitFirst({ coin: 'ETH', side: 'long' });
  assert.equal(result.kind, 'market');
});

maybeTest('после resting fill возвращает VWAP только свежих fill-ов нужной монеты', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(44), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : []) });
  const before = Date.now() - 20_000;
  fills.setFills([
    { coin: 'BTC', time: Date.now(), sz: 7, px: 7 },
    { coin: 'ETH', time: before, sz: 8, px: 8 },
    { coin: 'ETH', time: Date.now(), sz: 1, px: 99 },
    { coin: 'ETH', time: Date.now(), sz: 3, px: 101 },
  ]);
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 44, totalSz: 4, avgPx: 100.5, kind: 'limit' });
  assert.equal(fills.calls.length, 1);
  assert.equal(fills.calls[0][1].force, true);
});

maybeTest('считает fill на точной нижней границе окна и не подмешивает другую монету', async () => {
  const savedNow = Date.now;
  let now = 100_000;
  Date.now = () => ++now;
  let n = 0;
  try {
    reset({ nextLimitResult: resting(49), nextPositions: () => (++n === 1 ? [{ position: { coin: 'ETH', szi: '-2' } }] : []) });
    timing.setTiming({ waitMs: 10, pollMs: 0 });
    fills.setFills([
      { coin: 'ETH', time: 95_001, sz: 1, px: 100 },
      { coin: 'BTC', time: 95_002, sz: 99, px: 1 },
    ]);
    assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }), { ok: true, oid: 49, totalSz: 1, avgPx: 100, kind: 'limit' });
    assert.deepEqual(fills.calls[0], [95_001, { force: true }]);
  } finally {
    Date.now = savedNow;
  }
});

maybeTest('пустые, битые или недоступные fills не меняют размер и цену maker-закрытия', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(45), nextPositions: () => (++n === 1 ? [{ position: { coin: 'ETH', szi: '2' } }] : []) });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: Number.NaN, px: 10 }]);
  let result = await closeLimitFirst({ coin: 'ETH', side: 'long' });
  assert.deepEqual(result, { ok: true, oid: 45, totalSz: 2, avgPx: 101, kind: 'limit' });
  n = 0;
  reset({ nextLimitResult: resting(46), nextPositions: () => (++n === 1 ? [{ position: { coin: 'ETH', szi: '2' } }] : []) });
  fills.setFills(new Error('indexer down'));
  result = await closeLimitFirst({ coin: 'ETH', side: 'long' });
  assert.deepEqual(result, { ok: true, oid: 46, totalSz: 2, avgPx: 101, kind: 'limit' });
  assert.match(logger.calls.at(-2)[1], /не смог прочитать fills/);
  n = 0;
  reset({ nextLimitResult: resting(47), nextPositions: () => (++n === 1 ? [{ position: { coin: 'ETH', szi: '2' } }] : []) });
  fills.setFills([]);
  result = await closeLimitFirst({ coin: 'ETH', side: 'long' });
  assert.deepEqual(result, { ok: true, oid: 47, totalSz: 2, avgPx: 101, kind: 'limit' });
});

maybeTest('после ошибки опроса продолжает ждать и возвращает limit-fill', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(48), nextPositions: () => {
    n += 1;
    if (n === 1) return [{ position: { coin: 'ETH', szi: '-2' } }];
    if (n === 2) throw new Error('temporary');
    return [];
  } });
  timing.setTiming({ waitMs: 20, pollMs: 1 });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.equal(result.kind, 'limit');
  assert.match(logger.calls.find(([level]) => level === 'debug')[1], /опрос позиции упал: temporary/);
});

maybeTest('на дедлайне отменяет resting ордер, учитывает успевший fill и терпит ошибку отмены', async () => {
  let n = 0;
  reset({
    nextLimitResult: resting(55),
    nextPositions: () => (++n === 1 ? [{ position: { coin: 'ETH', szi: '-2' } }] : []),
    nextCancelError: new Error('already filled'),
  });
  timing.setTiming({ waitMs: 0 });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 2, px: 100.25 }]);
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 55, totalSz: 2, avgPx: 100.25, kind: 'limit' });
  assert.deepEqual(exchange.calls, [['limit', { coin: 'ETH', isBuy: true, sz: 2, px: '100', tif: 'Alo', reduceOnly: true }], ['cancel', ['ETH', 55]]]);
  assert.match(logger.calls.find(([level]) => level === 'debug')[1], /cancel oid=55/);
});

maybeTest('после дедлайна добивает остаток маркетом и сообщает процент частичного fill-а', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(61), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : [{ position: { coin: 'ETH', szi: '-0.5' } }]) });
  timing.setTiming({ waitMs: 0 });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 62, totalSz: 0.5, avgPx: 103 } });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 62, totalSz: 0.5, avgPx: 103, kind: 'market' });
  assert.match(logger.calls.at(-1)[1], /за 0с налилось 75% \(остаток 0.5\)/);
});

maybeTest('market fallback сохраняет ошибку парсера и отличает чистый market от mixed', async () => {
  reset({ nextBook: { levels: [[], []] } });
  parser.resetFillParser({ nextParsed: { ok: false, error: 'rejected' } });
  assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }), { ok: false, error: 'rejected' });
  reset({ nextBook: { levels: [[], []] } });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 99, totalSz: 2, avgPx: 98 } });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 2, px: 97 }]);
  assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }), { ok: true, oid: 99, totalSz: 2, avgPx: 97, kind: 'market' });
});

maybeTest('market fallback передаёт парсеру CLOSE и retry точные параметры', async () => {
  reset({ nextBook: { levels: [[], []] } });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 19, totalSz: 2, avgPx: 98 } });
  await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(retry.calls, [{ label: 'close-ETH', maxRetries: 2, baseDelayMs: 1500 }]);
  assert.deepEqual(parser.calls, [[{}, 'CLOSE']]);
});

maybeTest('не отменяет неидентифицированный resting-ордер и добивает позицию маркетом', async () => {
  reset({ nextLimitResult: { response: { data: { statuses: [{ resting: {} }] } } } });
  timing.setTiming({ waitMs: 0 });
  await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.equal(exchange.calls.some(([kind]) => kind === 'cancel'), false);
  assert.equal(exchange.calls.at(-1)[0], 'market');
});

maybeTest('чистый market не становится mixed только из-за лишних свежих fills', async () => {
  reset({ nextBook: { levels: [[], []] } });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 71, totalSz: 2, avgPx: 99 } });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 3, px: 98 }]);
  assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }),
    { ok: true, oid: 71, totalSz: 3, avgPx: 98, kind: 'market' });
});

maybeTest('mixed требует строго большего объёма fills, чем market-fill с допуском', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(72), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : [{ position: { coin: 'ETH', szi: '-1' } }]) });
  timing.setTiming({ waitMs: 0 });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 73, totalSz: 1, avgPx: 102 } });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 1 + 1e-12, px: 101 }]);
  assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }),
    { ok: true, oid: 73, totalSz: 1 + 1e-12, avgPx: 101, kind: 'market' });
});

maybeTest('не падает на пустом объекте позиции и на отсутствующем уровне книги', async () => {
  reset({
    nextPositions: [{}, { position: { coin: 'ETH', szi: '-2' } }],
    nextBook: { levels: [undefined, [{ px: '101' }]] },
  });
  assert.equal((await closeLimitFirst({ coin: 'ETH', side: 'short' })).kind, 'market');
});

maybeTest('не учитывает fill с непригодным размером, даже если цена пригодна', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(74), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : []) });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: Infinity, px: 100 }]);
  assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }),
    { ok: true, oid: 74, totalSz: 2, avgPx: 100, kind: 'limit' });
});

maybeTest('после полного fill в polling не переходит к market-добивке и логирует длительность и цену', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(75), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : [{ position: { coin: 'ETH', szi: '0' } }]) });
  timing.setTiming({ waitMs: 20, pollMs: 1 });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 2, px: 100.5 }]);
  assert.deepEqual(await closeLimitFirst({ coin: 'ETH', side: 'short' }),
    { ok: true, oid: 75, totalSz: 2, avgPx: 100.5, kind: 'limit' });
  assert.equal(exchange.calls.some(([kind]) => kind === 'market'), false);
  assert.match(logger.calls.at(-1)[1], /налилось мейкером за 0\.0с @ \$100\.5/);
});

maybeTest('на нулевом дедлайне не делает лишний poll: остаток добивается market-ордером', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(76), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : n === 2 ? [{ position: { coin: 'ETH', szi: '-1' } }] : []) });
  timing.setTiming({ waitMs: 0 });
  assert.equal((await closeLimitFirst({ coin: 'ETH', side: 'short' })).kind, 'market');
  assert.equal(exchange.calls.at(-1)[0], 'market');
});

maybeTest('на дедлайне без индексированных fills сохраняет исходный размер и пассивную цену', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(77), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : []) });
  timing.setTiming({ waitMs: 0 });
  const result = await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.deepEqual(result, { ok: true, oid: 77, totalSz: 2, avgPx: 100, kind: 'limit' });
  assert.match(logger.calls.at(-1)[1], /налилось мейкером на дедлайне @ \$100/);
});

maybeTest('resting-ветка сохраняет диагностический лог с oid', async () => {
  reset({ nextLimitResult: resting(78) });
  timing.setTiming({ waitMs: 0 });
  await closeLimitFirst({ coin: 'ETH', side: 'short' });
  assert.match(logger.calls[0][1], /reduce-only Alo sz=2 @ 100 oid=78/);
});

maybeTest('на дедлайне берёт фактический неполный объём fills, а не исходный размер', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(79), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : []) });
  timing.setTiming({ waitMs: 0 });
  fills.setFills([{ coin: 'ETH', time: Date.now(), sz: 1, px: 100 }]);
  assert.equal((await closeLimitFirst({ coin: 'ETH', side: 'short' })).totalSz, 1);
});

maybeTest('чистый market с нулевыми fills не считается mixed при отрицательном parser-объёме', async () => {
  let n = 0;
  reset({ nextLimitResult: resting(80), nextPositions: () => (++n === 1
    ? [{ position: { coin: 'ETH', szi: '-2' } }]
    : [{ position: { coin: 'ETH', szi: '-1' } }]) });
  timing.setTiming({ waitMs: 0 });
  parser.resetFillParser({ nextParsed: { ok: true, oid: 81, totalSz: -1, avgPx: 99 } });
  assert.equal((await closeLimitFirst({ coin: 'ETH', side: 'short' })).kind, 'market');
});

maybeTest('отсутствующий размер найденной позиции считается отсутствием позиции', async () => {
  reset({ nextPositions: [{ position: { coin: 'ETH' } }] });
  await assert.rejects(closeLimitFirst({ coin: 'ETH', side: 'short' }), /No position found/);
});

maybeTest('для long отсутствие ask-уровня ведёт в защитный market-путь', async () => {
  reset({ nextBook: { levels: [[{ px: '100' }], undefined] } });
  assert.equal((await closeLimitFirst({ coin: 'ETH', side: 'long' })).kind, 'market');
});

maybeTest('лог дедлайна переводит миллисекунды ожидания в секунды', async () => {
  const savedNow = Date.now;
  let now = 100_000;
  Date.now = () => ++now;
  try {
    reset({ nextLimitResult: resting(82) });
    timing.setTiming({ waitMs: 10, pollMs: 0 });
    await closeLimitFirst({ coin: 'ETH', side: 'short' });
    assert.match(logger.calls.at(-1)[1], /за 0с налилось 0% \(остаток 2\)/);
  } finally {
    Date.now = savedNow;
  }
});
