import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { savePosition, closePosition as dbClosePosition } from '../core/database.js';
import { getAvailableBalance } from './wallet.js';
import { sendMessage } from './reporter.js';

// Совпадают со Стратегом — единый источник правды о комиссиях
const FEE_RATE = 0.0002;   // 0.02% taker
const SLIPPAGE = 0.0001;   // 0.01%
const ONE_LEG  = FEE_RATE + SLIPPAGE; // 0.03% за одну сторону

const BALANCE_UTILIZATION = 0.95; // 95% от баланса — 5% остаётся на комиссии/маржу

/**
 * Исполняет сигнал от Стратега.
 *
 * @param {{ action: string, [key: string]: any }} signal
 * @param {Object|undefined} activePosition — текущая строка из БД (positions)
 * @returns {Promise<{ ok: boolean, positionId?: number, pnl?: number }>}
 */
export async function execute(signal, activePosition) {
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

/**
 * Определяет баланс для расчёта размера позиции.
 *
 * PAPER + FAKE_BALANCE: используем виртуальный баланс (для тестов без реальных денег).
 * PAPER без FAKE_BALANCE: реальный withdrawable с биржи.
 *
 * @returns {Promise<number>}
 */
async function getPaperBalance() {
  const fake = config.trading.fakeBalance;

  if (fake != null && fake > 0) {
    logger.info(`[Executor] Using FAKE_BALANCE: $${fake.toFixed(2)}`);
    return fake;
  }

  return getAvailableBalance();
}

/**
 * Открывает виртуальную позицию.
 *
 * @param {string}  coin
 * @param {number}  price
 * @param {number}  apy
 * @param {boolean} [silent=false] — подавить Telegram (при ротации шлём одно общее)
 * @returns {Promise<{ ok: boolean, positionId?: number, sizeUsd?: number }>}
 */
async function paperOpen(coin, price, apy, silent = false) {
  const balance = await getPaperBalance();

  if (balance <= 0) {
    logger.warn(`[Executor] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  const sizeUsd = balance * BALANCE_UTILIZATION;
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
    `[Executor] PAPER OPEN #${coin} | $${sizeUsd.toFixed(2)} (of $${balance.toFixed(2)}) @ $${price} | APY: ${apy.toFixed(2)}% | fee: $${fee.toFixed(4)} | id: ${id}`,
  );

  if (!silent) {
    const fire = apy > 100 ? '🔥🔥🔥 ' : '';
    await sendMessage(
      `${fire}🟢 <b>[OPEN] #${coin}</b>\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (${(BALANCE_UTILIZATION * 100).toFixed(0)}% от $${balance.toFixed(2)})\n` +
      `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
      `💵 Цена: $${price}\n` +
      `🏷 Fee: $${fee.toFixed(4)}`,
    );
  }

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Закрывает виртуальную позицию.
 *
 * @param {{ price: number, reason: string }} signal
 * @param {Object} position — строка из БД
 * @param {boolean} [silent=false] — подавить Telegram (при ротации шлём одно общее)
 * @returns {{ ok: boolean, pnl: number, holdHours: number }}
 */
function paperClose(signal, position, silent = false) {
  const holdMs    = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;
  const closePrice = signal.price;

  // Funding PnL: шортовая нога (50%) × hourlyRate × hours
  const hourlyRate  = position.entry_apy / 100 / 365 / 24;
  const fundingPnl  = position.size_usd * 0.5 * hourlyRate * holdHours;

  // Комиссии: вход + выход
  const totalFee = position.size_usd * ONE_LEG * 2;
  const realizedPnl = fundingPnl - totalFee;

  dbClosePosition(position.id, {
    close_price:  closePrice,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
  });

  const sign = realizedPnl >= 0 ? '+' : '';
  logger.info(
    `[Executor] PAPER CLOSE #${position.coin} | reason: ${signal.reason} ` +
    `| held: ${holdHours.toFixed(1)}h | PnL: ${sign}$${realizedPnl.toFixed(4)} | fees: $${totalFee.toFixed(4)}`,
  );

  if (!silent) {
    // Убыток по позиции — критично, будим даже ночью
    const isCriticalClose = realizedPnl < 0;

    sendMessage(
      `🔴 <b>[CLOSE] #${position.coin}</b>\n` +
        `📈 Причина: <b>${signal.reason}</b>\n` +
        `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
        `💰 PnL: <b>${sign}$${realizedPnl.toFixed(4)}</b>\n` +
        `🏷 Fee: $${totalFee.toFixed(4)}`,
      isCriticalClose,
    );
  }

  return { ok: true, pnl: realizedPnl, holdHours };
}

// ─────────────────────────────────────────────────
//  Handlers
// ─────────────────────────────────────────────────

async function handleOpen(signal) {
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

async function handleRotate(signal, position) {
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

  // ── Ротация: close + open, одно консолидированное уведомление ──

  // Шаг 1: close (silent — не шлём отдельный пуш)
  const closeResult = paperClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
    true, // silent
  );

  if (!closeResult.ok) return closeResult;

  // Шаг 2: open с актуальным балансом (silent)
  const openResult = await paperOpen(signal.openCoin, signal.openPrice, signal.openApy, true);

  if (!openResult.ok) {
    // Open не прошёл — отправляем алерт о неудачной ротации
    await sendMessage(
      `⚠️ <b>[ROTATE FAILED]</b> ${signal.closeCoin} закрыт, но ${signal.openCoin} не открылся!\n` +
      `💰 Close PnL: ${closeResult.pnl >= 0 ? '+' : ''}$${closeResult.pnl.toFixed(4)}\n` +
      `🔍 Причина: баланс $0 или ошибка. Бот остаётся без позиции.`,
      true, // critical
    );
    return { ok: false, closePnl: closeResult.pnl };
  }

  // Шаг 3: одно консолидированное уведомление
  const closePnlSign = closeResult.pnl >= 0 ? '+' : '';

  await sendMessage(
    `🔄 <b>[ROTATE]</b> ${signal.closeCoin} → <b>${signal.openCoin}</b>\n` +
    `<code>─────────────────────</code>\n` +
    `🔴 Закрыл: #${signal.closeCoin} (${closeResult.holdHours.toFixed(1)}ч)\n` +
    `💰 PnL: <b>${closePnlSign}$${closeResult.pnl.toFixed(4)}</b>\n` +
    `<code>─────────────────────</code>\n` +
    `🟢 Открыл: #${signal.openCoin} @ $${signal.openPrice}\n` +
    `📊 APY: <b>${signal.openApy.toFixed(2)}%</b>\n` +
    `💰 Размер: <b>$${openResult.sizeUsd.toFixed(2)}</b>\n` +
    `⏱ Payback: ${signal.paybackHours}h`,
  );

  return {
    ok: true,
    closePnl:   closeResult.pnl,
    positionId: openResult.positionId,
  };
}
