// ─────────────────────────────────────────────────
//  HL /info — единая точка входа, semaphore + retry
// ─────────────────────────────────────────────────
//
// Why: до этого каждый модуль (scout, dashboard, volatility, candleCache,
// sync, wallet, exchange, userFills) делал свой axios.post / fetch к
// api.hyperliquid.xyz/info. Дашбордовский enrichVolMult бросал 20
// параллельных candleSnapshot каждые ~30s и системно ловил 429,
// рикошетом убивая Scout. Здесь — глобальный потолок concurrency,
// мин-gap и retry с уважением к Retry-After.

import axios from 'axios';
import { retryWithBackoff } from './retry.js';
import { logger } from './logger.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const MAX_CONCURRENT = parseInt(process.env.HL_MAX_CONCURRENT || '4', 10);
const MIN_GAP_MS    = parseInt(process.env.HL_MIN_GAP_MS      || '50', 10);
const TIMEOUT_MS    = parseInt(process.env.HL_TIMEOUT_MS      || '8000', 10);

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

let inFlight = 0;
let lastSentAt = 0;
const waiters = [];

function acquire() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) {
    inFlight++;
    next();
  }
}

async function gap() {
  const elapsed = Date.now() - lastSentAt;
  if (elapsed < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
  }
  lastSentAt = Date.now();
}

/**
 * Один POST на /info с retry, semaphore и min-gap.
 *
 * @param {Object} body — payload запроса (например { type: 'metaAndAssetCtxs' })
 * @param {Object} [opts]
 * @param {string} [opts.label]      — метка для логов retry (например 'scout/markets')
 * @param {number} [opts.timeoutMs]  — override таймаута
 * @param {number} [opts.maxRetries] — override числа попыток (default 3)
 * @returns {Promise<any>} data из ответа HL
 */
export async function hlInfo(body, opts = {}) {
  const { label = 'hl/info', timeoutMs, maxRetries = 3 } = opts;

  return retryWithBackoff(
    async () => {
      await acquire();
      try {
        await gap();
        const response = await axios.post(HL_INFO_URL, body, {
          timeout: timeoutMs ?? TIMEOUT_MS,
          headers: DEFAULT_HEADERS,
        });
        return response.data;
      } finally {
        release();
      }
    },
    { maxRetries, label },
  );
}

/**
 * Диагностика — сколько запросов сейчас в полёте и в очереди.
 * Можно дернуть из дашборда / лог-снапшота.
 */
export function hlClientStats() {
  return {
    inFlight,
    queued: waiters.length,
    maxConcurrent: MAX_CONCURRENT,
    minGapMs: MIN_GAP_MS,
  };
}

logger.info(
  `[HL] info-client: max_concurrent=${MAX_CONCURRENT}, ` +
  `min_gap_ms=${MIN_GAP_MS}, timeout_ms=${TIMEOUT_MS}`,
);
