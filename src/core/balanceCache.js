// ─────────────────────────────────────────────────
//  Balance Cache — защита от API-глитчей Hyperliquid
// ─────────────────────────────────────────────────
//
// Hyperliquid индексатор иногда "залипает" и возвращает accountValue=0,
// withdrawable=0 — при этом на счёте реально есть деньги. Если верить ответу:
//   - drawdown-гард орёт -100% и блокирует все OPEN,
//   - Auto-Cleanup затирает baseline,
//   - в PROD бот может счесть позицию закрытой и наоткрывать лишних.
//
// Решение: единый кэш {accountValue, withdrawable, unrealizedPnl}, общий
// для PAPER (raw axios в wallet.js) и PROD (SDK в exchange.js).
//
// Политика:
//   1. Живой ответ (хоть одно из полей > 0) → обновляем кэш, возвращаем.
//   2. Ответ "всё по нулям" при наличии свежего кэша (<6ч) →
//      возвращаем кэш, WARN, одноразовый TG-алерт.
//   3. Сетевая ошибка при наличии свежего кэша → возвращаем кэш, WARN.
//   4. Иначе (нет кэша / кэш старый / реально пустой счёт) → возвращаем нули.

import { logger } from './logger.js';
import { sendMessage } from '../modules/reporter.js';

const STALE_MAX_AGE_MS = 6 * 60 * 60_000; // 6 часов

let lastGood = null;         // { value: {accountValue, withdrawable, unrealizedPnl}, ts }
let zeroStreakStart = 0;     // когда начался эпизод $0
let freezeAlerted = false;   // одноразовый TG-алерт на эпизод

/**
 * Оборачивает fetcher защитой от stale/glitched ответов.
 *
 * @param {() => Promise<{ accountValue: number, withdrawable: number, unrealizedPnl?: number }>} fetcher
 * @returns {Promise<{ accountValue: number, withdrawable: number, unrealizedPnl: number, stale: boolean }>}
 */
export async function getCachedBalance(fetcher) {
  let fresh;
  try {
    fresh = await fetcher();
  } catch (err) {
    if (lastGood && Date.now() - lastGood.ts < STALE_MAX_AGE_MS) {
      const ageMin = ((Date.now() - lastGood.ts) / 60_000).toFixed(0);
      logger.warn(
        `[BalanceCache] API unreachable (${err.message}) — using cached ` +
          `$${lastGood.value.accountValue.toFixed(2)} (age ${ageMin}min)`,
      );
      return { ...lastGood.value, stale: true };
    }
    throw err;
  }

  // Нормализуем: unrealizedPnl может быть undefined (wallet.js его не достаёт)
  const normalized = {
    accountValue:  Number(fresh.accountValue) || 0,
    withdrawable:  Number(fresh.withdrawable) || 0,
    unrealizedPnl: Number(fresh.unrealizedPnl) || 0,
  };

  const isZero = normalized.accountValue === 0 && normalized.withdrawable === 0;

  if (!isZero) {
    lastGood = { value: normalized, ts: Date.now() };
    if (zeroStreakStart > 0) {
      const durMin = ((Date.now() - zeroStreakStart) / 60_000).toFixed(1);
      logger.info(`[BalanceCache] ✅ API recovered after ${durMin}min of $0 responses`);
      zeroStreakStart = 0;
      freezeAlerted = false;
    }
    return { ...normalized, stale: false };
  }

  // API вернул $0 — потенциальный глитч
  if (zeroStreakStart === 0) zeroStreakStart = Date.now();

  const hasFreshCache = lastGood && Date.now() - lastGood.ts < STALE_MAX_AGE_MS;

  if (hasFreshCache) {
    const ageMin = ((Date.now() - lastGood.ts) / 60_000).toFixed(0);
    logger.warn(
      `[BalanceCache] ⚠️  API returned $0.00 but cached balance is ` +
        `$${lastGood.value.accountValue.toFixed(2)} (${ageMin}min ago) — ` +
        `using cache (indexer freeze?)`,
    );

    if (!freezeAlerted) {
      freezeAlerted = true;
      sendMessage(
        `⚠️ <b>API Hyperliquid вернул $0.00</b>\n` +
          `<code>─────────────────────</code>\n` +
          `Возможно, индексатор застрял. Использую кэш.\n` +
          `💰 Кэш: <b>$${lastGood.value.accountValue.toFixed(2)}</b> (${ageMin} мин назад)\n` +
          `<i>Если продлится >6ч — бот вернёт $0 и встанет.</i>`,
      ).catch(() => { /* TG недоступен — ок */ });
    }

    return { ...lastGood.value, stale: true };
  }

  // Нет свежего кэша — либо бот только что стартовал, либо $0 длится >6ч,
  // либо кошелёк реально пуст. Возвращаем как есть.
  const cacheInfo = lastGood
    ? `cache age ${((Date.now() - lastGood.ts) / 60_000 / 60).toFixed(1)}h`
    : 'cache empty';
  logger.warn(`[BalanceCache] API returned $0.00 — no fresh cache (${cacheInfo})`);

  return { ...normalized, stale: false };
}

/**
 * Для тестов — сброс состояния кэша.
 */
export function _resetBalanceCache() {
  lastGood = null;
  zeroStreakStart = 0;
  freezeAlerted = false;
}

/**
 * Для тестов/диагностики — текущее состояние кэша.
 */
export function _getBalanceCacheState() {
  return {
    hasCache: !!lastGood,
    cacheAgeMs: lastGood ? Date.now() - lastGood.ts : null,
    cachedValue: lastGood?.value ?? null,
    zeroStreakMs: zeroStreakStart ? Date.now() - zeroStreakStart : 0,
    freezeAlerted,
  };
}
