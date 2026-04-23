// Тесты balanceCache (через wallet.js fetcher).
//
// Запуск: npm test
//
// Кейсы:
//  - Живой ответ → обновление кэша (+ персист на диск)
//  - $0 при наличии свежего кэша → отдаёт кэш, не $0
//  - $0 при отсутствии кэша → отдаёт $0
//  - Сетевая ошибка с/без кэша
//  - Дисковый кэш переживает "рестарт"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── ENV до импорта ──
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const CACHE_FILE = join('data', 'balance_cache.json');

function deleteCacheFile() {
  if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE);
}

// Удаляем дисковый кэш до импорта модуля — чтобы loadFromDisk не нашёл старые данные
deleteCacheFile();

const axiosModule = await import('axios');
const wallet = await import('../src/modules/wallet.js');
const balanceCache = await import('../src/core/balanceCache.js');

let mockResponse = null;
let mockError = null;

const originalPost = axiosModule.default.post;
axiosModule.default.post = async () => {
  if (mockError) throw mockError;
  return { data: mockResponse };
};

function setApi({ accountValue, withdrawable, unrealizedPnl = 0 }) {
  mockError = null;
  mockResponse = {
    marginSummary: {
      accountValue:       String(accountValue),
      totalUnrealizedPnl: String(unrealizedPnl),
    },
    withdrawable: String(withdrawable),
  };
}

function setApiError(err) {
  mockResponse = null;
  mockError = err;
}

function freshStart() {
  deleteCacheFile();
  balanceCache._resetBalanceCache();
}

test('balanceCache: live non-zero response updates cache', async () => {
  freshStart();
  setApi({ accountValue: 50, withdrawable: 42 });
  const eq = await wallet.getAccountEquity();
  const av = await wallet.getAvailableBalance();
  assert.equal(eq, 50);
  assert.equal(av, 42);
});

test('balanceCache: $0 response with fresh cache returns cached value', async () => {
  freshStart();
  setApi({ accountValue: 75, withdrawable: 70 });
  await wallet.getAccountEquity();

  setApi({ accountValue: 0, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  const av = await wallet.getAvailableBalance();
  assert.equal(eq, 75, 'accountValue должен быть из кэша');
  assert.equal(av, 70, 'withdrawable должен быть из кэша');
});

test('balanceCache: $0 response without cache returns 0', async () => {
  freshStart();
  setApi({ accountValue: 0, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 0);
});

test('balanceCache: recovered non-zero response resets stream', async () => {
  freshStart();
  setApi({ accountValue: 100, withdrawable: 90 });
  await wallet.getAccountEquity();

  setApi({ accountValue: 0, withdrawable: 0 });
  await wallet.getAccountEquity();

  setApi({ accountValue: 120, withdrawable: 110 });
  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 120);

  const snap = balanceCache._getBalanceCacheState();
  assert.equal(snap.zeroStreakMs, 0, 'zero-streak должен сброситься');
  assert.equal(snap.freezeAlerted, false, 'freezeAlerted должен сброситься');
});

test('balanceCache: network error with fresh cache returns cached value', async () => {
  freshStart();
  setApi({ accountValue: 60, withdrawable: 55 });
  await wallet.getAccountEquity();

  const netErr = new Error('ECONNRESET');
  netErr.code = 'ECONNRESET';
  setApiError(netErr);

  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 60, 'должен отдать из кэша при сетевой ошибке');
});

test('balanceCache: network error without cache throws', async () => {
  freshStart();
  const netErr = new Error('ECONNRESET');
  netErr.code = 'ECONNRESET';
  setApiError(netErr);

  await assert.rejects(() => wallet.getAccountEquity());
});

test('balanceCache: partial non-zero (маржа занята) не считается глитчем', async () => {
  freshStart();
  setApi({ accountValue: 50, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  const av = await wallet.getAvailableBalance();
  assert.equal(eq, 50);
  assert.equal(av, 0);
  const snap = balanceCache._getBalanceCacheState();
  assert.equal(snap.hasCache, true, 'кэш должен обновиться');
});

test('balanceCache: персист на диск + загрузка после "рестарта"', async () => {
  freshStart();

  // Шаг 1: живой ответ — должен персистнуться
  setApi({ accountValue: 123.45, withdrawable: 100, unrealizedPnl: 2.5 });
  await wallet.getAccountEquity();

  assert.ok(existsSync(CACHE_FILE), 'файл кэша должен появиться');

  // Шаг 2: симулируем рестарт — сбрасываем in-memory кэш, но файл оставляем
  balanceCache._resetBalanceCache();

  // Шаг 3: API глюкнул ($0), но диск помнит — должен вернуть кэш
  setApi({ accountValue: 0, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 123.45, 'после рестарта кэш должен подняться с диска');

  const snap = balanceCache._getBalanceCacheState();
  assert.equal(snap.cachedValue.unrealizedPnl, 2.5, 'unrealizedPnl тоже должен сохраниться');
});

test('balanceCache: устаревший дисковый кэш (>6ч) игнорируется', async () => {
  freshStart();

  // Пишем на диск кэш с возрастом 7 часов
  mkdirSync('data', { recursive: true });
  const staleTs = Date.now() - 7 * 3_600_000;
  writeFileSync(
    CACHE_FILE,
    JSON.stringify({
      value: { accountValue: 999, withdrawable: 900, unrealizedPnl: 0 },
      ts: staleTs,
    }),
  );

  // API возвращает $0 — нет свежего кэша (ни в памяти, ни на диске свежего)
  setApi({ accountValue: 0, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 0, 'устаревший кэш не должен подниматься');
});

test('cleanup: restore axios.post + delete cache file', () => {
  axiosModule.default.post = originalPost;
  deleteCacheFile();
});
