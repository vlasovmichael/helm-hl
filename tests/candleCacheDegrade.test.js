// Деградация свечного кэша при заторе весового бюджета.
//
// С 2026-07-31 клиент HL отшивает косметику по дедлайну (WeightBudgetTimeoutError)
// вместо того, чтобы копить очередь и тянуть за собой тик. Контракт кэша при
// таком отказе: отдать ПРОТУХШИЕ свечи, если они есть. Устаревший 1h-тренд на
// дашборде полезнее пустоты, а торговые решения этот источник не принимает.
// Обычная сетевая ошибка по-прежнему даёт null (и громкий warn).
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const axiosModule = await import('axios');
const {
  getHourlyCandles, seedCandleCache, clearCandleCache,
} = await import('../src/modules/candleCache.js');

const CANDLES = [{ t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' }];
const parsed = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, vol: 10 }];

let mode = 'ok';
axiosModule.default.post = async () => {
  if (mode === 'weight') {
    const err = new Error('weight budget wait > 1500ms (candleCache/SOL)');
    err.isWeightTimeout = true;
    throw err;
  }
  if (mode === 'network') {
    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    throw err;
  }
  return { data: CANDLES };
};

test('отказ по бюджету → отдаём протухшие свечи, а не null', async () => {
  clearCandleCache();
  // Кэш из прошлого: TTL 5 мин, поэтому «час назад» = протух.
  seedCandleCache('SOL', parsed, Date.now() - 3_600_000);

  mode = 'weight';
  const got = await getHourlyCandles('SOL', 48);
  assert.deepEqual(got, parsed, 'должны вернуться старые свечи из кэша');
});

test('отказ по бюджету без кэша → null (врать нечем)', async () => {
  clearCandleCache();
  mode = 'weight';
  const got = await getHourlyCandles('ETH', 48);
  assert.equal(got, null);
});

test('обычная сетевая ошибка → null, даже если кэш есть (это авария, не деградация)', async () => {
  clearCandleCache();
  seedCandleCache('BTC', parsed, Date.now() - 3_600_000);
  mode = 'network';
  const got = await getHourlyCandles('BTC', 48);
  assert.equal(got, null);
});

test('нормальный путь не задет: свежий ответ парсится и кладётся в кэш', async () => {
  clearCandleCache();
  mode = 'ok';
  const got = await getHourlyCandles('AVAX', 48);
  assert.deepEqual(got, parsed);
});
