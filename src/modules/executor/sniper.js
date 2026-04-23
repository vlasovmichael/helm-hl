// ─────────────────────────────────────────────────
//  Sniper Mode — maker-only exits на soft-причинах (PAPER симуляция)
// ─────────────────────────────────────────────────
// Iter 2: PAPER-путь. При soft-close (apy_below_threshold / fade_time_stop)
// вместо немедленного market-exit'а бот "армит" Sniper: фиксирует armPrice
// = текущий mark. Каждый тик проверяет:
//   • Позиция исчезла → clearSniper, ничего не делаем.
//   • Окно SNIPER_WINDOW_MS истекло → fallback market-close.
//   • Current price ≤ armPrice → симулированный maker-fill по armPrice,
//     комиссии по MAKER_FEE_RATE (только выход, вход taker как обычно).
//
// Prod-путь (реальный post-only Alo-ордер) приедет в Iter 3.

import { logger } from '../../core/logger.js';
import { getActivePosition } from '../../core/database.js';
import { paperClose } from './paper.js';
import { getSniper, clearSniper } from './state.js';
import { SNIPER_WINDOW_MS, MAKER_FEE_RATE, ONE_LEG } from './math.js';
import { notifySniperFilled, notifySniperTimeout } from './notifications.js';

/**
 * Чистая функция решения: что делает снайпер в текущем состоянии.
 * Возвращает один из:
 *   { kind: 'idle' }             — слота нет, делать нечего
 *   { kind: 'no-position' }       — позиция пропала, снять слот
 *   { kind: 'timeout', price }    — окно истекло, делать market fallback по price
 *   { kind: 'fill', price }       — симулированный maker-fill по armPrice
 *   { kind: 'wait' }              — продолжаем ждать
 *
 * @param {Object|null} slot — результат getSniper()
 * @param {Object|null} position — результат getActivePosition()
 * @param {Array<{coin:string,price:number}>|null} scoutData
 * @param {number} now
 */
export function decideSniperAction(slot, position, scoutData, now) {
  if (!slot) return { kind: 'idle' };
  if (!position || position.coin !== slot.coin) return { kind: 'no-position' };

  const elapsed = now - slot.armedAt;
  const scoutItem = scoutData?.find((x) => x.coin === slot.coin) ?? null;

  if (elapsed >= SNIPER_WINDOW_MS) {
    // На таймауте — берём свежую цену из scoutData, fallback на armPrice
    const price = scoutItem?.price ?? slot.armPrice;
    return { kind: 'timeout', price, elapsed };
  }

  if (!scoutItem) {
    // Нет свежей цены — ждём следующего тика
    return { kind: 'wait', elapsed };
  }

  // Buy-to-close short: fill когда mark опустился до нашего limit'а или ниже
  if (scoutItem.price <= slot.armPrice) {
    return { kind: 'fill', price: slot.armPrice, elapsed };
  }

  return { kind: 'wait', elapsed };
}

/**
 * Опрос Sniper-слота. Вызывается из app/tick.js между scan() и coordinate().
 * Тонкая обёртка над decideSniperAction — выполняет побочные эффекты.
 * @param {Array<{coin:string, price:number}>} scoutData — данные Scout'а этого тика
 * @returns {Promise<{ kind: string } | null>}
 */
export async function tickSniper(scoutData) {
  const slot = getSniper();
  const position = slot ? getActivePosition() : null;
  const action = decideSniperAction(slot, position, scoutData, Date.now());

  switch (action.kind) {
    case 'idle':
      return null;

    case 'no-position':
      logger.warn(
        `[Sniper] Position #${slot.coin} gone (external close?) — clearing armed slot`,
      );
      clearSniper();
      return action;

    case 'timeout': {
      logger.warn(
        `[Sniper] ⏰ TIMEOUT #${slot.coin} after ${Math.round(action.elapsed / 60_000)}min — ` +
          `fallback market close @ $${action.price}`,
      );
      clearSniper();  // снимаем слот ДО close, чтобы handleClose не армился заново
      const result = await paperClose(
        { price: action.price, reason: `${slot.reason}_sniper_timeout` },
        position,
        true,  // silent — пошлём собственное уведомление ниже
        // market fallback: default fees (ONE_LEG на обе ноги)
      );
      if (result.ok) {
        await notifySniperTimeout({
          coin:          slot.coin,
          armPrice:      slot.armPrice,
          fallbackPrice: action.price,
          reason:        slot.reason,
          pnl:           result.pnl,
          fee:           result.fee,
        });
      }
      return action;
    }

    case 'fill': {
      logger.info(
        `[Sniper] ✅ FILL #${slot.coin} @ $${slot.armPrice} ` +
          `(waited ${Math.round(action.elapsed / 60_000)}min, reason: ${slot.reason})`,
      );
      clearSniper();
      const result = await paperClose(
        { price: slot.armPrice, reason: slot.reason },
        position,
        true,  // silent — пошлём собственное уведомление ниже
        { closePrice: slot.armPrice, exitFeeRate: MAKER_FEE_RATE },
      );
      if (result.ok) {
        // Сколько сэкономили vs market: size × (ONE_LEG − MAKER_FEE_RATE)
        const feeSavedVsMarket = position.size_usd * (ONE_LEG - MAKER_FEE_RATE);
        await notifySniperFilled({
          coin:        slot.coin,
          armPrice:    slot.armPrice,
          waitMinutes: Math.round(action.elapsed / 60_000),
          reason:      slot.reason,
          pnl:         result.pnl,
          fee:         result.fee,
          feeSavedVsMarket,
        });
      }
      return action;
    }

    case 'wait':
      return action;

    default:
      logger.error(`[Sniper] unknown action kind: ${action.kind}`);
      return null;
  }
}
