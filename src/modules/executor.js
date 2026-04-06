import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { savePosition, closePosition as dbClosePosition } from '../core/database.js';

const PAPER_TRADE_SIZE = 11.0;

// Совпадают со Стратегом — единый источник правды о комиссиях
const FEE_RATE = 0.0002;   // 0.02% taker
const SLIPPAGE = 0.0001;   // 0.01%
const ONE_LEG  = FEE_RATE + SLIPPAGE; // 0.03% за одну сторону

/**
 * Исполняет сигнал от Стратега.
 *
 * @param {{ action: string, [key: string]: any }} signal
 * @param {Object|undefined} activePosition — текущая строка из БД (positions)
 * @returns {{ ok: boolean, positionId?: number, pnl?: number }}
 */
export function execute(signal, activePosition) {
  switch (signal.action) {
    case 'OPEN':
      return handleOpen(signal);
    case 'CLOSE':
      return handleClose(signal, activePosition);
    case 'ROTATE':
      return handleRotate(signal, activePosition);
    case 'HOLD':
      return { ok: true };
    default:
      logger.warn(`[Executor] Unknown action: ${signal.action}`);
      return { ok: false };
  }
}

// ─────────────────────────────────────────────────
//  PAPER helpers
// ─────────────────────────────────────────────────

function paperOpen(coin, price, apy) {
  const sizeUsd = PAPER_TRADE_SIZE;
  const fee     = sizeUsd * ONE_LEG;

  const id = savePosition({
    coin,
    size_usd:    sizeUsd,
    entry_price: price,
    entry_apy:   apy,
    entry_time:  Date.now(),
    mode:        'PAPER',
  });

  logger.info(
    `[Executor] 📝 PAPER OPEN #${coin} | $${sizeUsd.toFixed(2)} @ $${price} | APY: ${apy.toFixed(2)}% | fee: $${fee.toFixed(4)} | id: ${id}`,
  );

  return { ok: true, positionId: Number(id) };
}

function paperClose(signal, position) {
  const holdMs    = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;
  const closePrice = signal.price;

  // Funding PnL: шортовая нога (50%) × hourlyRate × hours
  const hourlyRate  = position.entry_apy / 100 / 365 / 24;
  const fundingPnl  = position.size_usd * 0.5 * hourlyRate * holdHours;

  // Комиссии: вход + выход
  const entryFee = position.size_usd * ONE_LEG;
  const exitFee  = position.size_usd * ONE_LEG;
  const totalFee = entryFee + exitFee;

  const realizedPnl = fundingPnl - totalFee;

  dbClosePosition(position.id, {
    close_price:  closePrice,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
  });

  const sign = realizedPnl >= 0 ? '+' : '';
  logger.info(
    `[Executor] 📝 PAPER CLOSE #${position.coin} | reason: ${signal.reason} ` +
    `| held: ${holdHours.toFixed(1)}h | PnL: ${sign}$${realizedPnl.toFixed(4)} | fees: $${totalFee.toFixed(4)}`,
  );

  return { ok: true, pnl: realizedPnl };
}

// ─────────────────────────────────────────────────
//  Handlers
// ─────────────────────────────────────────────────

function handleOpen(signal) {
  if (config.isProduction) {
    logger.warn(
      `[Executor] 🔴 PRODUCTION OPEN signal for ${signal.coin} — SDK integration pending. Skipped.`,
    );
    return { ok: false };
  }

  return paperOpen(signal.coin, signal.price, signal.apy);
}

function handleClose(signal, position) {
  if (!position) {
    logger.warn(`[Executor] CLOSE signal but no active position — nothing to do`);
    return { ok: false };
  }

  if (config.isProduction) {
    logger.warn(
      `[Executor] 🔴 PRODUCTION CLOSE signal for ${signal.coin} — SDK integration pending. Skipped.`,
    );
    return { ok: false };
  }

  return paperClose(signal, position);
}

function handleRotate(signal, position) {
  if (!position) {
    logger.warn(`[Executor] ROTATE signal but no active position — treating as OPEN`);
    return handleOpen({
      action: 'OPEN',
      coin:   signal.openCoin,
      price:  signal.openPrice,
      apy:    signal.openApy,
    });
  }

  if (config.isProduction) {
    logger.warn(
      `[Executor] 🔴 PRODUCTION ROTATE signal ${signal.closeCoin} → ${signal.openCoin} — SDK integration pending. Skipped.`,
    );
    return { ok: false };
  }

  // Атомарно: close + open
  const closeResult = paperClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
  );

  if (!closeResult.ok) return closeResult;

  const openResult = paperOpen(signal.openCoin, signal.openPrice, signal.openApy);

  logger.info(
    `[Executor] 🔄 PAPER ROTATE ${signal.closeCoin} → ${signal.openCoin} | payback: ${signal.paybackHours}h`,
  );

  return {
    ok: true,
    closePnl:   closeResult.pnl,
    positionId: openResult.positionId,
  };
}
