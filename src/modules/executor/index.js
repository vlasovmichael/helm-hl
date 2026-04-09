// ─────────────────────────────────────────────────
//  Executor — публичный фасад
// ─────────────────────────────────────────────────
// Единственная точка входа. Контракт с index.js не меняется.

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { paperOpen, paperClose } from './paper.js';
import { productionOpen, productionClose, productionRotate } from './production.js';
import { notifyRotate, notifyRotateFailed } from './notifications.js';
import { notify } from './hooks.js';

// Re-exports для внешних модулей
export { getRuntimeBlacklist, getStateSnapshot } from './state.js';
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
      return handleOpen(signal);
    case "CLOSE":
      return handleClose(signal, activePosition);
    case "ROTATE":
      return handleRotate(signal, activePosition);
    case "HOLD":
      return { ok: true };
    default:
      logger.warn(`[Executor] Unknown action: ${signal.action}`);
      return { ok: false };
  }
}

// ── Роутинг paper ↔ production ─────────────────

async function handleOpen(signal) {
  if (config.isProduction) {
    return productionOpen(signal.coin, signal.price, signal.apy);
  }
  return paperOpen(signal.coin, signal.price, signal.apy);
}

async function handleClose(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] CLOSE signal but no active position — nothing to do`,
    );
    return { ok: false };
  }
  if (config.isProduction) {
    return productionClose(signal, position);
  }
  return paperClose(signal, position);
}

async function handleRotate(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] ROTATE signal but no active position — treating as OPEN`,
    );
    return handleOpen({
      action: "OPEN",
      coin: signal.openCoin,
      price: signal.openPrice,
      apy: signal.openApy,
    });
  }
  if (config.isProduction) {
    return productionRotate(signal, position);
  }
  return paperRotate(signal, position);
}

// ── Paper rotate (inline) ──────────────────────

async function paperRotate(signal, position) {
  const closeResult = await paperClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
    true, // silent
  );

  if (!closeResult.ok) return closeResult;

  const openResult = await paperOpen(
    signal.openCoin,
    signal.openPrice,
    signal.openApy,
    true, // silent
  );

  if (!openResult.ok) {
    await notifyRotateFailed({
      closeCoin: signal.closeCoin, openCoin: signal.openCoin,
      closePnl: closeResult.pnl, phase: 'open',
    });
    return { ok: false, closePnl: closeResult.pnl };
  }

  await notifyRotate({
    closeCoin: signal.closeCoin, openCoin: signal.openCoin,
    holdHours: closeResult.holdHours, closePnl: closeResult.pnl,
    openSizeUsd: openResult.sizeUsd, openApy: signal.openApy,
    paybackHours: signal.paybackHours, isProd: false,
  });

  notify('afterRotate', {
    closeCoin: signal.closeCoin, openCoin: signal.openCoin,
    closePnl: closeResult.pnl, positionId: openResult.positionId,
  });

  return {
    ok: true,
    closePnl: closeResult.pnl,
    positionId: openResult.positionId,
  };
}
