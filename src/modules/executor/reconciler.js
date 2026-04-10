// ─────────────────────────────────────────────────
//  Reconciler — фоновая проверка позиций на бирже
// ─────────────────────────────────────────────────

import { logger } from '../../core/logger.js';
import { getPositions, getClearinghouseStateFull } from '../exchange.js';
import { sendMessage } from '../reporter.js';
import {
  RECONCILIATION_TOLERANCE_PCT,
  RECONCILE_INITIAL_DELAY_MS,
  RECONCILE_MAX_RETRIES,
  RECONCILE_BACKOFF_BASE_MS,
  RECONCILE_BACKOFF_CAP_MS,
} from './math.js';

/**
 * Exponential backoff с потолком.
 * attempt=1 → BASE, 2 → 2×BASE, 3 → 4×BASE, ... (но не больше CAP).
 */
function backoffMs(attempt) {
  const exp = RECONCILE_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(exp, RECONCILE_BACKOFF_CAP_MS);
}

/**
 * Утилита для надёжного сравнения тикеров.
 * Игнорирует регистр и суффиксы типа -PERP.
 */
function isSameCoin(apiCoin, targetCoin) {
  if (!apiCoin || !targetCoin) return false;
  const a = apiCoin.toLowerCase();
  const t = targetCoin.toLowerCase();
  return a === t || a === `${t}-perp` || a === `@${t}` || a.replace("-perp", "") === t;
}

/**
 * "Тяжёлый" final check: тащит ПОЛНЫЙ clearinghouseState и ищет монету.
 * Используется ТОЛЬКО когда обычный polling не нашёл позицию после всех retry —
 * прежде чем поднимать тревогу, делаем последний срез на всякий случай
 * (вдруг indexer лагал именно на лёгком эндпоинте).
 *
 * @param {string} coin
 * @returns {Promise<{ hasPos: boolean, szi: number, posData: Object|null, equity: number, posCount: number }>}
 */
async function fetchPositionStateHeavy(coin) {
  const fullState = await getClearinghouseStateFull();
  const assetPositions = fullState?.assetPositions ?? [];
  const equity = parseFloat(fullState?.marginSummary?.accountValue ?? '0');
  const posCount = assetPositions.length;

  const pos = assetPositions.find((ap) => {
    const p = ap?.position ?? ap;
    return isSameCoin(p?.coin, coin);
  });
  const posData = pos?.position ?? pos ?? null;
  const szi = posData ? parseFloat(posData.szi ?? '0') : 0;

  return { hasPos: szi !== 0, szi, posData, equity, posCount, fullState };
}

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
    return isSameCoin(p?.coin, coin);
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

    // ── Polling с экспоненциальной задержкой ──
    // attempt=1 → попытка → backoff(1)=1s → attempt=2 → backoff(2)=2s → ...
    // 10 попыток, суммарное ожидание ~95с (cap 16s).
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
        let wait = backoffMs(attempt);
        // Перед последними 3 попытками даём бирже больше времени продышаться (5-10с)
        if (attempt >= RECONCILE_MAX_RETRIES - 3) {
          wait = Math.max(wait, 10_000);
        }

        logger.info(
          `[Reconcile] ${operation} #${coin} — ` +
            `waiting for position to index… (attempt ${attempt}/${RECONCILE_MAX_RETRIES}, next in ${wait}ms)`,
        );
        await sleep(wait);
      }
    }

    // ── Final Check: тяжёлый запрос полного среза ──
    // Если polling не сошёлся — перед алертом делаем один "правдивый" срез
    // через clearinghouseState. Возможно, лёгкий эндпоинт лагал, а полный
    // покажет реальное состояние. Это спасёт от ложных тревог.
    if (!matched) {
      logger.warn(
        `[Reconcile] ${operation} #${coin} — polling exhausted, running heavy final check via clearinghouseState…`,
      );

      let heavy;
      try {
        heavy = await fetchPositionStateHeavy(coin);
        logger.info(
          `[Reconcile] ${operation} #${coin} — final check: ` +
            `equity=$${heavy.equity.toFixed(2)} | total positions=${heavy.posCount} | ` +
            `#${coin} szi=${heavy.szi} hasPos=${heavy.hasPos}`,
        );

        // Если даже тяжелый запрос не нашел — дампим состояние для дебага
        if ((checks.expectPosition && !heavy.hasPos) || (!checks.expectPosition && heavy.hasPos)) {
          logger.error(
            `[Reconcile] DEBUG DUMP for #${coin}:\n` +
            JSON.stringify(heavy.fullState, null, 2)
          );
        }
      } catch (err) {
        logger.error(
          `[Reconcile] ${operation} #${coin} — final check FAILED: ${err.message}. ` +
            `Proceeding with last polling result.`,
        );
        heavy = null;
      }


      // Если final check вернул другой результат — используем его как истину
      const finalState = heavy ?? state;

      if (checks.expectPosition === true && finalState.hasPos) {
        logger.info(
          `[Reconcile] ✅ ${operation} #${coin} — position FOUND via final check (was lagging on light endpoint)`,
        );
        state = finalState;
        matched = true;
      } else if (checks.expectPosition === false && !finalState.hasPos) {
        logger.info(
          `[Reconcile] ✅ ${operation} #${coin} — position absent confirmed via final check`,
        );
        state = finalState;
        matched = true;
      } else {
        // Final check подтвердил расхождение → шлём алерт
        state = finalState;
      }
    }

    // Ожидали позицию, но не нашли (даже final check не помог)
    if (checks.expectPosition === true && !state.hasPos) {
      logger.error(
        `[Reconcile] ❌ ${operation} #${coin} — expected position but found NONE ` +
          `after ${RECONCILE_MAX_RETRIES} retries + final clearinghouseState check!`,
      );
      await sendMessage(
        `⚠️ <b>[RECONCILE] #${coin}</b>\n` +
          `После ${operation}: позиция не найдена на бирже\n` +
          `после ${RECONCILE_MAX_RETRIES} попыток + final check!\n` +
          `🔍 Проверь вручную.`,
        true,
      );
      return;
    }

    // Ожидали закрытие, но позиция ещё висит (даже final check показал)
    if (checks.expectPosition === false && state.hasPos) {
      logger.warn(
        `[Reconcile] ⚠️ ${operation} #${coin} — expected NO position but found szi=${state.szi} ` +
          `after ${RECONCILE_MAX_RETRIES} retries + final check`,
      );
      await sendMessage(
        `⚠️ <b>[RECONCILE] #${coin}</b>\n` +
          `После ${operation}: позиция всё ещё открыта (szi=${state.szi})\n` +
          `после ${RECONCILE_MAX_RETRIES} попыток + final check!\n` +
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
