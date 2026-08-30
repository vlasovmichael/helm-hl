// ─────────────────────────────────────────────────
//  Paper Mode — виртуальные позиции
// ─────────────────────────────────────────────────

import { logger } from '../../core/logger.js';
import { closePosition as dbClosePosition } from '../../core/database.js';
import {
  calcPaperClose, ONE_LEG,
} from './math.js';
import {
  setCooldown, REENTRY_COOLDOWN_MS,
  recordLoss, CB_PAUSE_MS,
} from './state.js';
import { notify } from './hooks.js';
import {
  notifyPaperClose, notifyCircuitBreaker,
} from './notifications.js';

/**
 * Закрывает виртуальную позицию.
 *
 * Paper PnL = fundingPnl − fees (без pricePnl, т.к. нет реального fill).
 * Fee по умолчанию = size_usd × ONE_LEG × 2 (taker+slippage на обе ноги).
 *
 * opts позволяет переопределить close_price / ставку выходной комиссии
 * (напр. maker-fill по MAKER_FEE_RATE без slippage).
 *
 * @param {{ price: number, reason: string }} signal
 * @param {Object} position — строка из БД
 * @param {boolean} [silent=false]
 * @param {Object} [opts]
 * @param {number} [opts.closePrice] — override signal.price
 * @param {number} [opts.exitFeeRate] — override ставки комиссии выхода (default: ONE_LEG)
 * @returns {Promise<{ ok: boolean, pnl: number, holdHours: number }>}
 */
export async function paperClose(signal, position, silent = false, opts = {}) {
  const holdMs    = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;
  const closePrice = opts.closePrice ?? signal.price;
  const exitFeeRate = opts.exitFeeRate ?? ONE_LEG;

  const { totalFee, realizedPnl: baseRealized } = calcPaperClose(
    position, holdHours, exitFeeRate,
  );

  // Закрытие бумажной позы идёт по реальному уровню (стоп/цель или текущая цена
  // на time-stop) — значит pricePnl имеет смысл fill'а, а не условной отметки.
  const isLong = (position.side || '').toLowerCase() === 'long';
  const pricePnl = isLong
    ? (position.size_usd * (closePrice - position.entry_price)) / position.entry_price
    : (position.size_usd * (position.entry_price - closePrice)) / position.entry_price;
  const realizedPnl = baseRealized + pricePnl;

  // hold_seconds полезен для разбора выходов; MFE/MAE по тикам для бумажных поз
  // не трекаем (это делал tick-трекер снятых стратегий).
  const exitFeatures = { hold_seconds: Math.round(holdMs / 1000) };

  dbClosePosition(position.id, {
    close_price:  closePrice,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
    exitFeatures,
  });

  // Re-entry cooldown (paper mode тоже)
  setCooldown(position.coin);
  logger.info(
    `[Executor] ⏳ Re-entry cooldown set: #${position.coin} → ${REENTRY_COOLDOWN_MS / 60_000}min`,
  );

  const sign = realizedPnl >= 0 ? "+" : "";
  logger.info(
    `[Executor] PAPER CLOSE #${position.coin} | reason: ${signal.reason} ` +
      `| held: ${holdHours.toFixed(1)}h | PnL: ${sign}$${realizedPnl.toFixed(4)} | fees: $${totalFee.toFixed(4)}`,
  );

  if (!silent) {
    await notifyPaperClose({
      coin: position.coin, holdHours,
      reason: signal.reason,
      pnl: realizedPnl, fee: totalFee,
      side: position.side || 'short',
    });
  }

  // Circuit breaker: фиксируем убыток для реальных стратегий.
  if (realizedPnl < 0) {
    const tripped = recordLoss(position.coin, realizedPnl);
    if (tripped) {
      logger.error(
        `[Executor] 🛑 CIRCUIT BREAKER TRIPPED after PAPER loss #${position.coin} ($${realizedPnl.toFixed(4)})`,
      );
      await notifyCircuitBreaker({
        losses: 3,
        pauseMinutes: CB_PAUSE_MS / 60_000,
        lastCoin: position.coin,
        lastPnl: realizedPnl,
      });
    }
  }

  notify('afterClose', {
    coin: position.coin, pnl: realizedPnl, holdHours,
    reason: signal.reason, mode: 'PAPER',
  });

  return { ok: true, pnl: realizedPnl, fee: totalFee, holdHours };
}
