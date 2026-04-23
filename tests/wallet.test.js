// Тесты balanceCache (через wallet.js fetcher).
//
// Запуск: npm test
//
// Кейсы:
//  - Живой ответ → обновление кэша
//  - $0 при наличии свежего кэша → отдаёт кэш, не $0
//  - $0 при отсутствии кэша → отдаёт $0
//  - Сетевая ошибка с/без кэша

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта ──
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

// Перехватываем axios.post внутри wallet.js
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

test('balanceCache: live non-zero response updates cache', async () => {
  balanceCache._resetBalanceCache();
  setApi({ accountValue: 50, withdrawable: 42 });
  const eq = await wallet.getAccountEquity();
  const av = await wallet.getAvailableBalance();
  assert.equal(eq, 50);
  assert.equal(av, 42);
});

test('balanceCache: $0 response with fresh cache returns cached value', async () => {
  balanceCache._resetBalanceCache();
  setApi({ accountValue: 75, withdrawable: 70 });
  await wallet.getAccountEquity();

  setApi({ accountValue: 0, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  const av = await wallet.getAvailableBalance();
  assert.equal(eq, 75, 'accountValue должен быть из кэша');
  assert.equal(av, 70, 'withdrawable должен быть из кэша');
});

test('balanceCache: $0 response without cache returns 0', async () => {
  balanceCache._resetBalanceCache();
  setApi({ accountValue: 0, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 0);
});

test('balanceCache: recovered non-zero response resets stream', async () => {
  balanceCache._resetBalanceCache();
  setApi({ accountValue: 100, withdrawable: 90 });
  await wallet.getAccountEquity();

  setApi({ accountValue: 0, withdrawable: 0 });
  await wallet.getAccountEquity(); // отдаёт кэш

  setApi({ accountValue: 120, withdrawable: 110 });
  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 120);

  const snap = balanceCache._getBalanceCacheState();
  assert.equal(snap.zeroStreakMs, 0, 'zero-streak должен сброситься при восстановлении');
  assert.equal(snap.freezeAlerted, false, 'freezeAlerted должен сброситься');
});

test('balanceCache: network error with fresh cache returns cached value', async () => {
  balanceCache._resetBalanceCache();
  setApi({ accountValue: 60, withdrawable: 55 });
  await wallet.getAccountEquity();

  const netErr = new Error('ECONNRESET');
  netErr.code = 'ECONNRESET';
  setApiError(netErr);

  const eq = await wallet.getAccountEquity();
  assert.equal(eq, 60, 'должен отдать из кэша при сетевой ошибке');
});

test('balanceCache: network error without cache throws', async () => {
  balanceCache._resetBalanceCache();
  const netErr = new Error('ECONNRESET');
  netErr.code = 'ECONNRESET';
  setApiError(netErr);

  await assert.rejects(() => wallet.getAccountEquity());
});

test('balanceCache: partial non-zero (e.g. position uses all margin) is NOT treated as glitch', async () => {
  // accountValue=50, withdrawable=0 — нормальная ситуация с полностью занятой маржой.
  // Кэш обновляется, не считаем это глитчем.
  balanceCache._resetBalanceCache();
  setApi({ accountValue: 50, withdrawable: 0 });
  const eq = await wallet.getAccountEquity();
  const av = await wallet.getAvailableBalance();
  assert.equal(eq, 50);
  assert.equal(av, 0);
  const snap = balanceCache._getBalanceCacheState();
  assert.equal(snap.hasCache, true, 'кэш должен обновиться');
});

// Cleanup
test('cleanup: restore axios.post', () => {
  axiosModule.default.post = originalPost;
});
