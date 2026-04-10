// ─────────────────────────────────────────────────
//  Binance Client — подписанные REST-запросы
// ─────────────────────────────────────────────────
// Только read-only endpoints для tax collection.
// Подпись: HMAC-SHA256(query_string, secret).
// Все endpoints сами разбивают по 30-дневным окнам, т.к. Binance ограничивает.

import axios from 'axios';
import crypto from 'crypto';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

const BINANCE_API = 'https://api.binance.com';
const RECV_WINDOW = 10_000;

/**
 * Включён ли модуль (есть ли ключи).
 */
export function isConfigured() {
  return !!(config.binance?.apiKey && config.binance?.apiSecret);
}

/**
 * Подписывает params HMAC-SHA256 и делает GET.
 * @returns {Promise<any>}
 */
async function signedGet(path, params = {}) {
  if (!isConfigured()) {
    throw new Error('Binance API keys not configured');
  }

  const timestamp = Date.now();
  const allParams = { ...params, timestamp, recvWindow: RECV_WINDOW };
  const queryString = new URLSearchParams(allParams).toString();
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${BINANCE_API}${path}?${queryString}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

  const { data } = await axios.get(url, { headers, timeout: 15_000 });
  return data;
}

/**
 * Разбивает большой временной интервал на окна по N дней (Binance лимит).
 * Возвращает массив [{ start, end }].
 */
function splitWindows(startMs, endMs, windowDays = 30) {
  const windowMs = windowDays * 24 * 3_600_000;
  const windows = [];
  let cur = startMs;
  while (cur < endMs) {
    const next = Math.min(cur + windowMs, endMs);
    windows.push({ start: cur, end: next });
    cur = next;
  }
  return windows;
}

// ─────────────────────────────────────────────────
//  Endpoints — каждый возвращает плоский массив raw-записей
// ─────────────────────────────────────────────────

/**
 * Fiat Deposit/Withdraw History (банковские переводы PLN/EUR/USD).
 * @param {0|1} transactionType — 0=deposit, 1=withdraw
 */
export async function getFiatOrders(startMs, endMs, transactionType) {
  const out = [];
  for (const w of splitWindows(startMs, endMs)) {
    try {
      const data = await signedGet('/sapi/v1/fiat/orders', {
        transactionType,
        beginTime: w.start,
        endTime: w.end,
        rows: 500,
      });
      if (Array.isArray(data?.data)) {
        for (const r of data.data) out.push({ ...r, _source: 'fiat_orders', _txType: transactionType });
      }
    } catch (err) {
      logger.warn(`[Binance] fiat/orders type=${transactionType} window failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * Fiat Payments History (Card Buy/Sell — покупка крипты с банковской карты).
 * @param {0|1} transactionType — 0=buy crypto with fiat, 1=sell crypto for fiat
 */
export async function getFiatPayments(startMs, endMs, transactionType) {
  const out = [];
  for (const w of splitWindows(startMs, endMs)) {
    try {
      const data = await signedGet('/sapi/v1/fiat/payments', {
        transactionType,
        beginTime: w.start,
        endTime: w.end,
        rows: 500,
      });
      if (Array.isArray(data?.data)) {
        for (const r of data.data) out.push({ ...r, _source: 'fiat_payments', _txType: transactionType });
      }
    } catch (err) {
      logger.warn(`[Binance] fiat/payments type=${transactionType} window failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * P2P (C2C) Trade History.
 * @param {'BUY'|'SELL'} tradeType
 */
export async function getC2cHistory(startMs, endMs, tradeType) {
  const out = [];
  for (const w of splitWindows(startMs, endMs)) {
    try {
      const data = await signedGet('/sapi/v1/c2c/orderMatch/listUserOrderHistory', {
        tradeType,
        startTimestamp: w.start,
        endTimestamp: w.end,
        rows: 100,
      });
      if (Array.isArray(data?.data)) {
        for (const r of data.data) out.push({ ...r, _source: 'c2c', _tradeType: tradeType });
      }
    } catch (err) {
      logger.warn(`[Binance] c2c ${tradeType} window failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * Convert Trade Flow.
 * Здесь вернутся ВСЕ конверсии (включая крипта-крипта).
 * Фильтрацию делает classifier.js — нам нужны только те, где одна из сторон — фиат.
 */
export async function getConvertHistory(startMs, endMs) {
  const out = [];
  for (const w of splitWindows(startMs, endMs)) {
    try {
      const data = await signedGet('/sapi/v1/convert/tradeFlow', {
        startTime: w.start,
        endTime: w.end,
        limit: 1000,
      });
      if (Array.isArray(data?.list)) {
        for (const r of data.list) out.push({ ...r, _source: 'convert' });
      }
    } catch (err) {
      logger.warn(`[Binance] convert/tradeFlow window failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * Удобная обёртка: тащит ВСЁ за период одним вызовом.
 * Возвращает массив raw-событий с пометкой _source/_txType/_tradeType.
 */
export async function fetchAllFiatEvents(startMs, endMs) {
  logger.info(
    `[Binance] Fetching fiat events: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
  );

  const [
    fiatDeposits, fiatWithdrawals,
    cardBuys, cardSells,
    p2pBuys, p2pSells,
    converts,
  ] = await Promise.all([
    getFiatOrders(startMs, endMs, 0),
    getFiatOrders(startMs, endMs, 1),
    getFiatPayments(startMs, endMs, 0),
    getFiatPayments(startMs, endMs, 1),
    getC2cHistory(startMs, endMs, 'BUY'),
    getC2cHistory(startMs, endMs, 'SELL'),
    getConvertHistory(startMs, endMs),
  ]);

  const all = [
    ...fiatDeposits, ...fiatWithdrawals,
    ...cardBuys, ...cardSells,
    ...p2pBuys, ...p2pSells,
    ...converts,
  ];

  logger.info(
    `[Binance] Fetched ${all.length} raw events ` +
      `(fiat-dep=${fiatDeposits.length}, fiat-wd=${fiatWithdrawals.length}, ` +
      `card-buy=${cardBuys.length}, card-sell=${cardSells.length}, ` +
      `p2p-buy=${p2pBuys.length}, p2p-sell=${p2pSells.length}, ` +
      `convert=${converts.length})`,
  );

  return all;
}
