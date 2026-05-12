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
// Кэш персистится на диск, чтобы пережить рестарт во время глитча.
//
// Политика:
//   1. Живой ответ (хоть одно из полей > 0) → обновляем кэш (+диск), возвращаем.
//   2. Ответ "всё по нулям" при наличии свежего кэша (<6ч) →
//      возвращаем кэш, WARN, одноразовый TG-алерт.
//   3. Сетевая ошибка при наличии свежего кэша → возвращаем кэш, WARN.
//   4. Иначе (нет кэша / кэш старый / реально пустой счёт) → возвращаем нули.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { sendMessage } from '../modules/reporter.js';

const STALE_MAX_AGE_MS = 6 * 60 * 60_000; // 6 часов
const CACHE_FILE = join('data', 'balance_cache.json');

let lastGood = null;         // { value: {accountValue, withdrawable, unrealizedPnl}, ts }
let zeroStreakStart = 0;     // когда начался эпизод $0
let freezeAlerted = false;   // одноразовый TG-алерт на эпизод
let diskLoaded = false;      // попытались ли уже загрузить с диска

/**
 * Ленивая загрузка кэша с диска при первом обращении.
 * Sync — файл крошечный (~100 байт), это одноразовое действие при старте.
 */
function loadFromDisk() {
  if (diskLoaded) return;
  diskLoaded = true;

  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw);

    if (
      typeof data?.ts === 'number' &&
      data?.value &&
      typeof data.value.accountValue === 'number'
    ) {
      const ageMs = Date.now() - data.ts;
      if (ageMs < STALE_MAX_AGE_MS) {
        lastGood = { value: data.value, ts: data.ts };
        const ageMin = (ageMs / 60_000).toFixed(0);
        logger.info(
          `[BalanceCache] Loaded from disk: $${data.value.accountValue.toFixed(2)} ` +
            `(${ageMin}min old)`,
        );
      } else {
        logger.info(
          `[BalanceCache] Disk cache too old (${(ageMs / 3_600_000).toFixed(1)}h) — ignored`,
        );
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[BalanceCache] Failed to load disk cache: ${err.message}`);
    }
    // ENOENT — ок, просто первый запуск
  }
}

/**
 * Атомарная запись на диск (tmp + rename). Fire-and-forget — никакой await.
 */
function persistToDisk() {
  if (!lastGood) return;

  const payload = JSON.stringify({ value: lastGood.value, ts: lastGood.ts });
  const tmpPath = `${CACHE_FILE}.${process.pid}.tmp`;

  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, CACHE_FILE);
  } catch (err) {
    logger.warn(`[BalanceCache] Failed to persist cache: ${err.message}`);
  }
}

/**
 * Оборачивает fetcher защитой от stale/glitched ответов.
 *
 * @param {() => Promise<{ accountValue: number, withdrawable: number, unrealizedPnl?: number }>} fetcher
 * @returns {Promise<{ accountValue: number, withdrawable: number, unrealizedPnl: number, stale: boolean }>}
 */
export async function getCachedBalance(fetcher) {
  loadFromDisk();

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

  const normalized = {
    accountValue:  Number(fresh.accountValue) || 0,
    withdrawable:  Number(fresh.withdrawable) || 0,
    unrealizedPnl: Number(fresh.unrealizedPnl) || 0,
  };

  const isZero = normalized.accountValue === 0 && normalized.withdrawable === 0;

  if (!isZero) {
    lastGood = { value: normalized, ts: Date.now() };
    persistToDisk();
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
        `using cache. If auto-transfer succeeded, it logged above as ` +
        `[Exchange] ✅ ...; if it failed/was skipped (spot empty too) — ` +
        `see [Exchange] ❌ / [BalanceDiag] for the actual perp/spot split.`,
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

  const cacheInfo = lastGood
    ? `cache age ${((Date.now() - lastGood.ts) / 60_000 / 60).toFixed(1)}h`
    : 'cache empty';
  logger.warn(`[BalanceCache] API returned $0.00 — no fresh cache (${cacheInfo})`);

  return { ...normalized, stale: false };
}

/**
 * Sync-доступ к закэшированному equity (accountValue). Возвращает null,
 * если кэша ещё нет / он устарел. Используется в sync-местах (например,
 * strategist analyze()) — fetcher запускать оттуда нельзя.
 *
 * @returns {number|null}
 */
export function getCachedAccountValueSync() {
  loadFromDisk();
  if (!lastGood) return null;
  if (Date.now() - lastGood.ts >= STALE_MAX_AGE_MS) return null;
  return lastGood.value.accountValue;
}

/**
 * Для тестов — сброс состояния кэша (включая флаг загрузки с диска).
 */
export function _resetBalanceCache() {
  lastGood = null;
  zeroStreakStart = 0;
  freezeAlerted = false;
  diskLoaded = false;
}

/**
 * Для тестов — заполнить кэш заданным accountValue, минуя диск.
 */
export function _seedBalanceCache(accountValue) {
  diskLoaded = true; // блокируем чтение диска
  lastGood = {
    value: { accountValue, withdrawable: accountValue, unrealizedPnl: 0 },
    ts:    Date.now(),
  };
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
