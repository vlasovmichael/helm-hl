// ─────────────────────────────────────────────────
//  Fill Parser — парсинг ответов SDK + resolve asset
// ─────────────────────────────────────────────────

import { logger } from '../../core/logger.js';
import { findAsset, getUniverse, isUniverseFresh } from '../../core/universe.js';
import { banRuntime, RUNTIME_BAN_TTL_MS } from './state.js';

/**
 * Разбирает ответ SDK на placeOrder / marketOpen / marketClose.
 *
 * Hyperliquid возвращает statuses[] где каждый элемент — это:
 *   { filled: { oid, totalSz, avgPx } }    — ордер исполнен
 *   { resting: { oid } }                    — на книге (не для нас, мы IoC)
 *   "Some error string"                     — бизнес-ошибка (НЕ бросается SDK)
 *
 * @param {Object} result — ответ SDK
 * @param {string} context — "OPEN" / "CLOSE" для логов
 * @returns {{ ok: boolean, oid?: number, avgPx?: number, totalSz?: number, error?: string }}
 */
export function parseFillResponse(result, context) {
  try {
    const statuses = result?.response?.data?.statuses;

    if (!Array.isArray(statuses) || statuses.length === 0) {
      return {
        ok: false,
        error: `Empty statuses in ${context} response: ${JSON.stringify(result).slice(0, 300)}`,
      };
    }

    const status = statuses[0];

    if (typeof status === "string") {
      return { ok: false, error: status };
    }

    if (status.filled) {
      return {
        ok: true,
        oid: status.filled.oid,
        totalSz: parseFloat(status.filled.totalSz),
        avgPx: parseFloat(status.filled.avgPx),
      };
    }

    if (status.resting) {
      return {
        ok: false,
        error: `Order resting (oid=${status.resting.oid}) instead of filling — IoC order should not rest`,
      };
    }

    if (status.error) {
      return { ok: false, error: status.error };
    }

    return {
      ok: false,
      error: `Unknown status shape: ${JSON.stringify(status).slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse ${context} response: ${err.message}`,
    };
  }
}

/**
 * Возвращает szDecimals для монеты из ОБЩЕГО universe кеша.
 *
 * Источник данных — core/universe.js, куда Scout записывает
 * universe каждый тик. Executor НЕ делает своих getMeta() запросов.
 *
 * Side effect: банит монету в runtimeBlacklist при свежем кеше.
 *
 * @param {string} coin — "ETH", "BTC" и т.д. (без "-PERP")
 * @returns {{ szDecimals: number }}
 * @throws {Error} если монета не найдена
 */
export function resolveAsset(coin) {
  const universe = getUniverse();
  const asset    = findAsset(coin);

  if (!asset) {
    const sample = universe.slice(0, 10).map((a) => {
      return typeof a === 'string' ? a : a?.name ?? JSON.stringify(a);
    });
    const fresh = isUniverseFresh();

    logger.error(
      `[FillParser] resolveAsset("${coin}") FAILED | ` +
        `universe: ${universe.length} assets, fresh: ${fresh} | ` +
        `sample: [${sample.join(', ')}] | ` +
        `type of first: ${typeof universe[0]}`,
    );

    if (fresh) {
      banRuntime(coin);
      logger.warn(
        `[FillParser] "${coin}" added to runtime blacklist for ${RUNTIME_BAN_TTL_MS / 60_000}min ` +
          `(runtime blacklist updated)`,
      );
    } else {
      logger.warn(
        `[FillParser] "${coin}" not found but universe is stale/empty — NOT banning`,
      );
    }

    throw new Error(
      `Asset "${coin}" not found in universe (${universe.length} assets, fresh=${fresh})`,
    );
  }

  return { szDecimals: asset.szDecimals };
}
