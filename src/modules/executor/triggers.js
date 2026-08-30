// ─────────────────────────────────────────────────
//  Triggers — стоп/цель на бирже для открытой позиции
// ─────────────────────────────────────────────────
// Единственный путь, которым нянька (adopt) вешает защиту на мою ручную позу:
// reduce-only trigger против стороны позиции. Цену округляем явно — HL отклоняет
// >5 значащих цифр / >(6−szDecimals) десятичных ("Order has invalid price").

import { retryWithBackoff } from '../../core/retry.js';
import { placeTrigger } from '../exchange.js';
import { formatHlPrice } from './math.js';

/**
 * @param {string} coin
 * @param {number} sz — фактический размер позиции
 * @param {number} triggerPx — цена срабатывания
 * @param {'sl'|'tp'} tpsl
 * @param {number} szDecimals
 * @param {'long'|'short'} side — сторона ЗАКРЫВАЕМОЙ позиции
 * @returns {Promise<number>} oid выставленного ордера
 */
export async function placeExitTrigger(coin, sz, triggerPx, tpsl, szDecimals, side = 'short') {
  const isBuy = side === 'short';  // закрытие SHORT → BUY, LONG → SELL
  const px = formatHlPrice(triggerPx, szDecimals);
  const result = await retryWithBackoff(
    () => placeTrigger({ coin, isBuy, sz, px, tpsl }),
    { label: `exit-${tpsl}-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
  );

  const status = result?.response?.data?.statuses?.[0];
  if (!status) throw new Error(`empty statuses: ${JSON.stringify(result).slice(0, 200)}`);
  if (typeof status === 'string') throw new Error(status);
  if (status.error) throw new Error(status.error);
  // Trigger не должен исполниться сразу — HL возвращает resting.
  if (status.resting?.oid) return status.resting.oid;
  throw new Error(`unexpected status: ${JSON.stringify(status).slice(0, 200)}`);
}
