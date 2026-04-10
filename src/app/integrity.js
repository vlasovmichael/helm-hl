// ─────────────────────────────────────────────────
//  Integrity Check — детектор внешнего закрытия позиций
// ─────────────────────────────────────────────────
// Каждые 60с проверяет: если в БД есть OPEN-позиция, но на бирже
// по этому тикеру позиция отсутствует, значит она была закрыта
// внешне (ADL, ликвидация, ручное действие).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, closePosition as dbClosePosition } from '../core/database.js';
import { getPositions, getAccountSummary } from '../modules/exchange.js';
import { sendMessage } from '../modules/reporter.js';
import {
  state,
  INTEGRITY_CHECK_INTERVAL_MS,
  INTEGRITY_GRACE_PERIOD_MS,
} from './state.js';

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
 * @returns {Promise<boolean>} true если позиция была закрыта внешне
 */
export async function integrityCheck() {
  if (!config.isProduction) return false;

  const now = Date.now();

  // 1. Grace period после старта бота
  if (state.botStartedAt > 0 && now - state.botStartedAt < INTEGRITY_GRACE_PERIOD_MS) {
    return false;
  }

  if (now - state.lastIntegrityCheck < INTEGRITY_CHECK_INTERVAL_MS) return false;
  state.lastIntegrityCheck = now;

  const dbPosition = getActivePosition();
  if (!dbPosition) return false;

  // 2. Grace period после ОТКРЫТИЯ позиции (даем 10с на индексацию API)
  // Это уберет ложные алерты сразу после покупки
  if (now - dbPosition.entry_time < 10_000) {
    return false;
  }

  try {
    const exchangePositions = await getPositions();

    const found = exchangePositions.find((ap) => {
      const pos = ap?.position ?? ap;
      const apiCoin = pos?.coin;
      const szi  = parseFloat(pos?.szi ?? '0');
      return isSameCoin(apiCoin, dbPosition.coin) && szi !== 0;
    });


    if (found) return false; // позиция на месте

    // ── Позиция исчезла — проверяем margin guard ──
    let equity = 0;
    let withdrawable = 0;
    let estimatedPnl = 0;
    try {
      const summary = await getAccountSummary();
      equity       = summary.equity;
      withdrawable = summary.available;
      estimatedPnl = equity - dbPosition.size_usd;
    } catch {
      // PnL неизвестен
    }

    // Margin Guard: если маржа заблокирована → скорее всего лаг API
    if (equity > 10 && withdrawable < equity * 0.5) {
      logger.warn(
        `[Integrity] ⚡ #${dbPosition.coin} not found in getPositions() but ` +
          `margin is locked: withdrawable=$${withdrawable.toFixed(2)} vs equity=$${equity.toFixed(2)} ` +
          `(${((withdrawable / equity) * 100).toFixed(1)}%). ` +
          `Likely API lag — skipping external close detection.`,
      );
      return false;
    }

    // ── Позиция действительно закрыта ──────────────
    logger.error(
      `[Integrity] ⚠️ EXTERNAL CLOSE detected: #${dbPosition.coin} is OPEN in DB ` +
        `but ABSENT on exchange! withdrawable=$${withdrawable.toFixed(2)}, equity=$${equity.toFixed(2)} ` +
        `(margin freed → position is genuinely gone)`,
    );

    const holdMs    = Date.now() - dbPosition.entry_time;
    const holdHours = holdMs / 3_600_000;

    dbClosePosition(dbPosition.id, {
      close_price:  0,
      realized_pnl: estimatedPnl,
      fee_paid:     0,
      reason:       'external_close',
    });

    logger.info(
      `[Integrity] DB position #${dbPosition.coin} (id=${dbPosition.id}) closed | ` +
        `held: ${holdHours.toFixed(1)}h | estimated PnL: $${estimatedPnl.toFixed(4)}`,
    );

    const pnlSign  = estimatedPnl >= 0 ? '+' : '';
    const pnlEmoji = estimatedPnl >= 0 ? '📈' : '📉';

    await sendMessage(
      `⚠️ <b>ВНЕШНЕЕ ЗАКРЫТИЕ ПОЗИЦИИ</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🔍 Обнаружено расхождение:\n` +
        `<b>#${dbPosition.coin}</b> закрыт на стороне биржи\n` +
        `<i>(ADL, ликвидация или ручное действие)</i>\n` +
        `<code>─────────────────────</code>\n` +
        `💰 Размер: <b>$${dbPosition.size_usd.toFixed(2)}</b>\n` +
        `💵 Entry: <b>$${dbPosition.entry_price}</b>\n` +
        `⏳ Удержание: <b>${holdHours.toFixed(1)}ч</b>\n` +
        `${pnlEmoji} PnL (оценка): <b>${pnlSign}$${estimatedPnl.toFixed(4)}</b>\n` +
        `💰 Equity: <b>$${equity.toFixed(2)}</b> | Withdrawable: <b>$${withdrawable.toFixed(2)}</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🤖 Бот переведён в режим <b>IDLE</b>.\n` +
        `Следующий вход — в ближайшем тике.`,
      true,
    );

    return true;
  } catch (err) {
    logger.debug(`[Integrity] Check failed (non-critical): ${err.message}`);
    return false;
  }
}
