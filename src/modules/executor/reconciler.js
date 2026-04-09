// ─────────────────────────────────────────────────
//  Reconciler — фоновая проверка позиций на бирже
// ─────────────────────────────────────────────────

import { logger } from '../../core/logger.js';
import { getPositions } from '../exchange.js';
import { sendMessage } from '../reporter.js';
import {
  RECONCILIATION_TOLERANCE_PCT,
  RECONCILE_INITIAL_DELAY_MS,
  RECONCILE_RETRY_DELAY_MS,
  RECONCILE_MAX_RETRIES,
} from './math.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Запрашивает позиции и ищет конкретную монету.
 * @param {string} coin
 * @returns {Promise<{ hasPos: boolean, szi: number, posData: Object|null }>}
 */
export async function fetchPositionState(coin) {
  const positions = await getPositions();

  const pos = positions.find((ap) => {
    const p = ap?.position ?? ap;
    return p?.coin === coin;
  });
  const posData = pos?.position ?? pos ?? null;
  const szi = posData ? parseFloat(posData.szi ?? "0") : 0;

  return { hasPos: szi !== 0, szi, posData };
}

/**
 * Проверяет, что после fill позиция на бирже соответствует ожиданиям.
 *
 * Вызывается ПОСЛЕ успешного fill (fire-and-forget, не блокирует основной поток).
 * Не бросает исключений — только логирует.
 *
 * @param {string} coin
 * @param {string} operation — "OPEN" | "CLOSE" | "ROTATE_CLOSE" | "ROTATE_OPEN"
 * @param {{ expectedSzUsd?: number, expectPosition?: boolean }} checks
 */
export async function reconcile(coin, operation, checks) {
  try {
    logger.info(
      `[Reconcile] ${operation} #${coin} — waiting ${RECONCILE_INITIAL_DELAY_MS}ms for exchange indexing…`,
    );
    await sleep(RECONCILE_INITIAL_DELAY_MS);

    let state;
    let matched = false;

    for (let attempt = 1; attempt <= RECONCILE_MAX_RETRIES; attempt++) {
      state = await fetchPositionState(coin);

      if (checks.expectPosition === true && state.hasPos) {
        matched = true;
        break;
      }
      if (checks.expectPosition === false && !state.hasPos) {
        matched = true;
        break;
      }

      if (attempt < RECONCILE_MAX_RETRIES) {
        logger.info(
          `[Reconcile] ${operation} #${coin} — ` +
            `waiting for position to index… (attempt ${attempt}/${RECONCILE_MAX_RETRIES})`,
        );
        await sleep(RECONCILE_RETRY_DELAY_MS);
      }
    }

    // Ожидали позицию, но не нашли
    if (checks.expectPosition === true && !state.hasPos) {
      logger.error(
        `[Reconcile] ❌ ${operation} #${coin} — expected position on exchange but found NONE ` +
          `after ${RECONCILE_MAX_RETRIES} retries (~${((RECONCILE_INITIAL_DELAY_MS + RECONCILE_MAX_RETRIES * RECONCILE_RETRY_DELAY_MS) / 1000).toFixed(0)}s)!`,
      );
      await sendMessage(
        `⚠️ <b>[RECONCILE] #${coin}</b>\n` +
          `После ${operation}: позиция не найдена на бирже\n` +
          `после ${RECONCILE_MAX_RETRIES} попыток!\n` +
          `🔍 Проверь вручную.`,
        true,
      );
      return;
    }

    // Ожидали закрытие, но позиция ещё висит
    if (checks.expectPosition === false && state.hasPos) {
      logger.warn(
        `[Reconcile] ⚠️ ${operation} #${coin} — expected NO position but found szi=${state.szi} ` +
          `after ${RECONCILE_MAX_RETRIES} retries`,
      );
      await sendMessage(
        `⚠️ <b>[RECONCILE] #${coin}</b>\n` +
          `После ${operation}: позиция всё ещё открыта (szi=${state.szi})\n` +
          `после ${RECONCILE_MAX_RETRIES} попыток!\n` +
          `🔍 Возможно, частичный fill. Проверь вручную.`,
        true,
      );
      return;
    }

    // Проверка размера
    if (checks.expectPosition && checks.expectedSzUsd && state.hasPos) {
      const entryPx = parseFloat(state.posData.entryPx ?? "0");
      const actualUsd = Math.abs(state.szi) * entryPx;
      const diff = Math.abs(actualUsd - checks.expectedSzUsd);
      const diffPct =
        checks.expectedSzUsd > 0 ? (diff / checks.expectedSzUsd) * 100 : 0;

      if (diffPct > RECONCILIATION_TOLERANCE_PCT) {
        logger.warn(
          `[Reconcile] ⚠️ ${operation} #${coin} — size mismatch: ` +
            `expected ~$${checks.expectedSzUsd.toFixed(2)}, actual ~$${actualUsd.toFixed(2)} (Δ${diffPct.toFixed(1)}%)`,
        );
      } else {
        logger.info(
          `[Reconcile] ✅ ${operation} #${coin} — size OK: ~$${actualUsd.toFixed(2)} (Δ${diffPct.toFixed(1)}%)`,
        );
      }
    }

    if (checks.expectPosition === false && !state.hasPos) {
      logger.info(
        `[Reconcile] ✅ ${operation} #${coin} — no position confirmed`,
      );
    }
  } catch (err) {
    logger.warn(`[Reconcile] Failed for ${operation} #${coin}: ${err.message}`);
  }
}
