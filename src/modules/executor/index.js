// ─────────────────────────────────────────────────
//  Executor — публичный фасад
// ─────────────────────────────────────────────────
// Единственная точка входа. Контракт с index.js не меняется.

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { invalidateAccountState } from '../../core/accountState.js';
import { paperClose } from './paper.js';
import { productionClose } from './close.js';
import { cancelOrderFor } from '../exchange.js';

// Re-exports для внешних модулей
export { getRuntimeBlacklist, getStateSnapshot, getOiCapBans } from './state.js';
export { on } from './hooks.js';


/**
 * Исполняет сигнал от Стратега.
 *
 * @param {{ action: string, [key: string]: any }} signal
 * @param {Object|undefined} activePosition — текущая строка из БД (positions)
 * @returns {Promise<{ ok: boolean, positionId?: number, pnl?: number }>}
 */
export async function execute(signal, activePosition) {
  switch (signal.action) {
    case "OPEN":
      return afterMutation(handleOpen(signal));
    case "CLOSE":
      return afterMutation(handleClose(signal, activePosition));
    case "HOLD":
      return { ok: true };
    default:
      logger.warn(`[Executor] Unknown action: ${signal.action}`);
      return { ok: false };
  }
}

// После любой сделки бота сбрасываем коалесцированный срез аккаунта: cold-
// читатели (дашборд/integrity) тут же видят новые позиции/equity, а не висят
// на дотрейдовом снапшоте до истечения TTL. Сбрасываем независимо от исхода —
// частичный успех/ошибка тоже могли изменить состояние на бирже.
async function afterMutation(resultPromise) {
  try {
    return await resultPromise;
  } finally {
    invalidateAccountState("positions", "balance");
  }
}

// ── Роутинг paper ↔ production ─────────────────

// Бот не открывает позиции сам: все автоматические стратегии сняты,
// вход всегда ручной. Executor остаётся путём ВЫХОДА — им нянька ведёт мои сделки.
async function handleOpen(signal) {
  logger.warn(
    `[Executor] OPEN #${signal.coin} проигнорирован: автоматических входов нет.`,
  );
  return { ok: false };
}

async function handleClose(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] CLOSE signal but no active position — nothing to do`,
    );
    return { ok: false };
  }

  // Shadow-paper позиция в PROD-боте (напр. shadow-стратегия до PROD-активации)
  // закрывается строго виртуально и не отправляет реальный market-ордер.
  if (config.isProduction && position.mode === 'PAPER') {
    return paperClose(signal, position);
  }

  // Hunter PROD: перед market-close снимаем висящие SL/TP триггеры, чтобы они не остались
  // на бирже после закрытия позиции (reduce_only их защищает от двойного fill'а, но это всё
  // равно мусор и потенциальный риск на следующей позиции).
  if (
    config.isProduction &&
    (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long' || position.strategy_id === 'adopt') &&
    position.mode === 'PRODUCTION' &&
    (position.hunter_sl_oid || position.hunter_tp_oid)
  ) {
    const triggerOids = [position.hunter_sl_oid, position.hunter_tp_oid].filter(Boolean);
    for (const oid of triggerOids) {
      try {
        await cancelOrderFor(position.coin, oid);
        logger.info(`[Executor] HUNTER pre-close cancel #${position.coin} trigger oid=${oid}`);
      } catch (err) {
        // Триггер мог уже сработать / быть отменённым reconciler'ом — это OK.
        logger.debug(`[Executor] HUNTER pre-close cancel oid=${oid} failed (likely gone): ${err.message}`);
      }
    }
  }

  // Маршрут по mode позиции, а не по config.isProduction: бумажная позиция
  // (shadow-стратегия в проде) должна закрываться виртуально, иначе productionClose
  // отправит реальный market-ордер на монету, которой бот не владеет.
  if (position.mode === 'PRODUCTION') {
    return productionClose(signal, position);
  }
  return paperClose(signal, position);
}
