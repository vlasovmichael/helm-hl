// Вытеснение свечных кэшей.
//
// Why (09.08.2026): контейнер упал с FATAL "Reached heap limit" при rss 242 из
// 512 МБ и чистом dmesg — упёрлись не в cgroup, а в потолок кучи V8 (259 МБ,
// который Node вывел из лимита контейнера). Росли четыре карты в candleCache:
// TTL решал только «идти в сеть или отдать кэш», а записи не удалялись никогда.
//
// Здесь проверяется то, что теперь держит потолок: вытеснение по lastAccess
// (а не по fetchedAt — иначе деградация под весовым бюджетом выбрасывала бы
// ровно то, что нужнее всего) и жёсткий backstop по размеру.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.CANDLE_CACHE_IDLE_MS = String(60 * 60_000);   // 1ч
process.env.CANDLE_CACHE_MAX_ENTRIES = '5';

const {
  seedCandleCache, seedFiveMinCache, clearCandleCache, clearFiveMinCache,
  sweepCandleCaches, candleCacheStats, _resetSweepThrottleForTest,
  getHourlyCandles,
} = await import('../src/modules/candleCache.js');

const CANDLES = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, vol: 10 }];

function reset() {
  clearCandleCache();
  clearFiveMinCache();
  _resetSweepThrottleForTest();
}

test('монету перестали смотреть дольше idle — запись уходит', () => {
  reset();
  const t0 = 1_000_000;
  seedCandleCache('OLD', CANDLES, t0);
  seedCandleCache('FRESH', CANDLES, t0);

  // FRESH трогаем спустя два часа — обращение продлевает жизнь.
  const later = t0 + 2 * 60 * 60_000;
  getHourlyCandles('FRESH', 24, later);

  const res = sweepCandleCaches(later + 1000, { force: true });
  assert.equal(res.evicted, 1);
  assert.equal(candleCacheStats().sizes['1h'], 1);
});

test('свежую запись не трогаем', () => {
  reset();
  const t0 = 2_000_000;
  seedCandleCache('SOL', CANDLES, t0);
  const res = sweepCandleCaches(t0 + 60_000, { force: true });
  assert.equal(res.evicted, 0);
  assert.equal(candleCacheStats().sizes['1h'], 1);
});

test('backstop по размеру: сверх лимита выкидываем самые давние', () => {
  reset();
  const t0 = 3_000_000;
  // 8 монет с разным lastAccess, все в пределах idle → режет только размер.
  for (let i = 0; i < 8; i++) seedCandleCache(`C${i}`, CANDLES, t0 + i * 1000);
  const res = sweepCandleCaches(t0 + 8000, { force: true });

  assert.equal(candleCacheStats().sizes['1h'], 5);
  assert.equal(res.evicted, 3);
  // Ушли три самые давние — C0..C2, остались последние пять.
  const stats = candleCacheStats();
  assert.equal(stats.total, 5);
});

test('вытеснение общее: 5m-кэш подметается тем же проходом', () => {
  reset();
  const t0 = 4_000_000;
  seedFiveMinCache('OLD5', CANDLES, t0);
  const res = sweepCandleCaches(t0 + 3 * 60 * 60_000, { force: true });
  assert.equal(res.evicted, 1);
  assert.equal(candleCacheStats().sizes['5m'], 0);
});

test('троттл: без force второй вызов подряд пропускается', () => {
  reset();
  const t0 = 5_000_000;
  seedCandleCache('X', CANDLES, t0);
  assert.notEqual(sweepCandleCaches(t0, { force: true }), null);
  assert.equal(sweepCandleCaches(t0 + 1000), null);
});
