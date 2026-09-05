// ─────────────────────────────────────────────────
//  NBP Client — курсы PLN с T-1 правилом и кешем
// ─────────────────────────────────────────────────
// Польская налоговая (PIT-38) требует курс на РАБОЧИЙ день,
// предшествующий дню транзакции. NBP API возвращает 404 на выходных
// и праздниках — откатываемся ещё на день назад, до 7 итераций.

import axios from 'axios';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { logger } from '../../core/logger.js';

const NBP_API   = 'https://api.nbp.pl/api/exchangerates/rates/A';
const CACHE_PATH = 'data/tax/nbp_cache.json';
const MAX_ROLLBACK_DAYS = 7;

// In-memory кеш — синхронизирован с диском
let cache = null;

async function loadCache() {
  if (cache !== null) return cache;
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    cache = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[NBP] Cache read error: ${err.message} — starting empty`);
    }
    cache = {};
  }
  return cache;
}

async function persistCache() {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[NBP] Cache write error: ${err.message}`);
  }
}

/**
 * Возвращает дату в формате YYYY-MM-DD по польскому календарю (Europe/Warsaw).
 * Польская налоговая считает по локальному дню, не UTC.
 */
export function toWarsawDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  // sv-SE даёт ISO-формат YYYY-MM-DD
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Сдвигает YYYY-MM-DD на N дней назад. */
function shiftDays(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * Получает курс конкретной валюты на конкретную дату.
 * Возвращает { rate, effectiveDate } или null если NBP не отдал.
 */
async function fetchNbpForDate(currency, isoDate) {
  const url = `${NBP_API}/${currency}/${isoDate}/?format=json`;
  try {
    const { data } = await axios.get(url, { timeout: 10_000 });
    const rate = data?.rates?.[0]?.mid;
    const effectiveDate = data?.rates?.[0]?.effectiveDate;
    if (typeof rate === 'number' && effectiveDate) {
      return { rate, effectiveDate };
    }
    return null;
  } catch (err) {
    if (err.response?.status === 404) {
      return null; // выходной/праздник — нормальная ситуация
    }
    // Сетевая или 5xx ошибка — пробрасываем, чтобы caller решил что делать
    throw new Error(`NBP API ${currency} ${isoDate}: ${err.message}`, { cause: err });
  }
}

/**
 * Главная функция: курс валюты на T-1 от даты транзакции,
 * с откатом по выходным/праздникам до 7 дней.
 *
 * @param {string} currency — "USD" | "EUR" | "PLN" | ...
 * @param {string|Date} txDate — дата транзакции (любой формат)
 * @returns {Promise<{ rate: number, nbpDate: string } | null>}
 *   PLN всегда возвращает { rate: 1, nbpDate: warsawDate(txDate) } без обращения к API.
 *   null — если NBP лежит или 7 дней подряд нет курса (никогда не должно случиться в норме).
 */
export async function getNbpRate(currency, txDate) {
  const cur = currency?.toUpperCase();

  // PLN — фиктивный курс 1, не дёргаем API
  if (cur === 'PLN') {
    return { rate: 1, nbpDate: toWarsawDate(txDate) };
  }

  if (!['USD', 'EUR'].includes(cur)) {
    logger.warn(`[NBP] Unsupported currency: ${currency}`);
    return null;
  }

  await loadCache();

  const txWarsawDate = toWarsawDate(txDate);
  let probeDate = shiftDays(txWarsawDate, -1); // T-1

  for (let attempt = 0; attempt < MAX_ROLLBACK_DAYS; attempt++) {
    const cacheKey = `${cur}_${probeDate}`;

    // Попадание в кеш
    if (cache[cacheKey]) {
      return { rate: cache[cacheKey].rate, nbpDate: cache[cacheKey].effectiveDate };
    }

    // Дёрнуть NBP
    let result;
    try {
      result = await fetchNbpForDate(cur, probeDate);
    } catch (err) {
      logger.warn(`[NBP] ${err.message} — will retry tomorrow`);
      return null;
    }

    if (result) {
      cache[cacheKey] = result;
      await persistCache();
      return { rate: result.rate, nbpDate: result.effectiveDate };
    }

    // 404 — нерабочий день, откатываемся
    probeDate = shiftDays(probeDate, -1);
  }

  logger.error(
    `[NBP] No rate found for ${cur} within ${MAX_ROLLBACK_DAYS} days back from ${txWarsawDate}`,
  );
  return null;
}
