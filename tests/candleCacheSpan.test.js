// Глубина свечного кэша: запись одна на монету, а окна у вызывающих разные.
// Короткий запрос не должен урезать длинный, длинный — удлинять короткий.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const axiosModule = await import('axios');
const { getHourlyCandles, clearCandleCache } = await import('../src/modules/candleCache.js');

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;
const requests = [];

// Биржа отдаёт по бару на каждый час окна запроса.
axiosModule.default.post = async (_url, body) => {
  const { startTime, endTime } = body.req;
  requests.push((endTime - startTime) / HOUR);
  const data = [];
  for (let t = Math.ceil(startTime / HOUR) * HOUR; t < endTime; t += HOUR) {
    data.push({ t, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' });
  }
  return { data };
};

test('длинный запрос после короткого идёт в сеть и получает всю глубину', async () => {
  clearCandleCache();
  requests.length = 0;
  assert.equal((await getHourlyCandles('LIT', 60, NOW)).length, 60);
  assert.equal((await getHourlyCandles('LIT', 480, NOW)).length, 480);
  assert.deepEqual(requests, [60, 480]);
});

test('короткий запрос после длинного берёт кэш, но только своё окно', async () => {
  clearCandleCache();
  requests.length = 0;
  await getHourlyCandles('LIT', 480, NOW);
  const short = await getHourlyCandles('LIT', 48, NOW);
  assert.equal(short.length, 48);
  assert.equal(short.at(-1).time, (NOW / HOUR - 1) * HOUR);
  assert.deepEqual(requests, [480]);
});

test('длинный запрос не ждёт чужой короткий в полёте', async () => {
  clearCandleCache();
  requests.length = 0;
  const [short, long] = await Promise.all([getHourlyCandles('LIT', 60, NOW), getHourlyCandles('LIT', 480, NOW)]);
  assert.equal(short.length, 60);
  assert.equal(long.length, 480);
});
