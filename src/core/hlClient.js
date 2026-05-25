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

// HL info-endpoint доком: 1200 req/min/IP ≈ 20 req/sec. Дашборд раньше летел
// штормом параллельных candleSnapshot и системно ловил 429 → каждый ретрил
// независимо → ещё больший шторм. Жёсткий потолок + min-gap дают serial-rate
// ≤ ~13 req/sec, с запасом под пиковые случаи (метаданные + bulk-ratch).
const MAX_CONCURRENT = parseInt(process.env.HL_MAX_CONCURRENT || '2', 10);
const MIN_GAP_MS    = parseInt(process.env.HL_MIN_GAP_MS      || '75', 10);
const TIMEOUT_MS    = parseInt(process.env.HL_TIMEOUT_MS      || '8000', 10);
// Глобальная пауза после 429 — пока кулдаун активен, никакие новые запросы
// не уходят. Все ретраи скоординированно ждут вместо рассинхронных залпов.
const COOLDOWN_429_MS = parseInt(process.env.HL_COOLDOWN_429_MS || '3000', 10);

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

let inFlight = 0;
let lastSentAt = 0;
let cooldownUntil = 0;
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
  // Сначала ждём глобальный 429-кулдаун если активен.
  const cdRemain = cooldownUntil - Date.now();
  if (cdRemain > 0) {
    await new Promise((r) => setTimeout(r, cdRemain));
  }
  const elapsed = Date.now() - lastSentAt;
  if (elapsed < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
  }
  lastSentAt = Date.now();
}

function trip429() {
  const newUntil = Date.now() + COOLDOWN_429_MS;
  if (newUntil > cooldownUntil) cooldownUntil = newUntil;
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
      } catch (err) {
        // На 429 — взводим глобальный кулдаун, чтобы остальные запросы в очереди
        // дождались вместо параллельного ретрая. Retry-After в секундах если есть.
        if (err.response?.status === 429) {
          const retryAfter = parseInt(err.response.headers?.['retry-after'] ?? '0', 10);
          if (retryAfter > 0) {
            const until = Date.now() + retryAfter * 1000;
            if (until > cooldownUntil) cooldownUntil = until;
          } else {
            trip429();
          }
        }
        throw err;
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
    cooldownRemainMs: Math.max(0, cooldownUntil - Date.now()),
  };
}

logger.info(
  `[HL] info-client: max_concurrent=${MAX_CONCURRENT}, ` +
  `min_gap_ms=${MIN_GAP_MS}, timeout_ms=${TIMEOUT_MS}, ` +
  `cooldown_429_ms=${COOLDOWN_429_MS}`,
);
