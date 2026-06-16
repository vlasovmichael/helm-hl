import { logger } from './logger.js';

/**
 * Выполняет асинхронную функцию с экспоненциальным retry.
 *
 * Сценарий:
 *   Попытка 1 → fail → ждём 1с
 *   Попытка 2 → fail → ждём 2с
 *   Попытка 3 → fail → бросаем ошибку
 *
 * Retry только для сетевых/транзиентных ошибок:
 *   - HTTP 502, 503, 504 (биржа моргнула)
 *   - ECONNRESET, ETIMEDOUT, ENOTFOUND (сеть)
 *   - Rate limit 429 (ждём дольше)
 *
 * НЕ ретраим:
 *   - 400 Bad Request (наш запрос кривой — retry не поможет)
 *   - 401/403 (авторизация)
 *   - Любая бизнес-логика (insufficient margin, unknown asset, etc.)
 *
 * @param {Function}  fn              — async функция для выполнения
 * @param {Object}    [opts]
 * @param {number}    [opts.maxRetries=3]    — максимум попыток
 * @param {number}    [opts.baseDelayMs=1000] — начальная задержка (удваивается)
 * @param {number}    [opts.maxDelayMs=10000] — потолок задержки
 * @param {string}    [opts.label='']        — метка для логов
 * @param {boolean}   [opts.quiet=false]     — косметика (LOW-приоритет): ретраи
 *                    логируем на debug, а не warn/error — чтобы блипы Vol×/htf
 *                    не выглядели в логе как авария (они сами дожёвываются/гасятся
 *                    в null). Торговый путь остаётся громким.
 * @returns {Promise<any>}            — результат fn()
 * @throws {Error}                    — если все попытки исчерпаны
 */
export async function retryWithBackoff(fn, opts = {}) {
  const {
    maxRetries  = 3,
    baseDelayMs = 1000,
    maxDelayMs  = 10_000,
    label       = '',
    quiet       = false,
  } = opts;

  const tag = label ? `[Retry:${label}]` : '[Retry]';
  const logWarn  = quiet ? logger.debug.bind(logger) : logger.warn.bind(logger);
  const logErr   = quiet ? logger.debug.bind(logger) : logger.error.bind(logger);

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // ── Определяем, стоит ли ретраить ───────────────
      if (!isRetryable(err)) {
        logErr(`${tag} Non-retryable error on attempt ${attempt}: ${err.message}`);
        throw err; // бросаем сразу — retry бесполезен
      }

      // ── Последняя попытка — не ждём, бросаем ───────
      if (attempt === maxRetries) {
        logErr(
          `${tag} All ${maxRetries} attempts failed. Last error: ${err.message}`,
        );
        throw err;
      }

      // ── Считаем задержку ────────────────────────────
      let delay = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s...

      // 429 Rate Limit — берём Retry-After если есть, иначе ждём дольше
      if (err.response?.status === 429) {
        const retryAfter = parseInt(err.response.headers?.['retry-after'] ?? '0', 10);
        delay = Math.max(delay, retryAfter * 1000 || 5000);
      }

      delay = Math.min(delay, maxDelayMs);

      // Jitter ±20% — чтобы не стрелять залпом при восстановлении
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      delay = Math.round(delay + jitter);

      logWarn(
        `${tag} Attempt ${attempt}/${maxRetries} failed: ${err.message} — ` +
        `retrying in ${delay}ms…`,
      );

      await sleep(delay);
    }
  }

  // Сюда мы не попадаем, но TypeScript/ESLint хочет return
  throw lastError;
}

/**
 * Определяет, является ли ошибка транзиентной (стоит ли ретраить).
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryable(err) {
  // ── Сетевые ошибки (axios / node:http) ─────────
  const networkCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ];

  if (err.code && networkCodes.includes(err.code)) {
    return true;
  }

  // ── HTTP статусы ───────────────────────────────
  const status = err.response?.status ?? err.status;

  if (status) {
    // 429 Rate Limit — ретраим с увеличенной задержкой
    if (status === 429) return true;

    // 5xx — серверные ошибки биржи
    if (status >= 500 && status < 600) return true;

    // 4xx (кроме 429) — клиентская ошибка, retry бесполезен
    return false;
  }

  // ── Таймаут axios ──────────────────────────────
  if (err.code === 'ECONNABORTED') return true;

  // ── Специальные случаи (бизнес-логика, которую стоит ретраить) ──
  if (err.message && err.message.includes('possibly indexer lag')) {
    return true;
  }

  // Hyperliquid SDK иногда отвечает "An unknown error occurred" на транзиентах —
  // обычно гасится 1-2 ретраями.
  if (err.message && err.message.toLowerCase().includes('unknown error')) {
    return true;
  }

  // ── По умолчанию: не ретраим неизвестные ошибки ─
  return false;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
