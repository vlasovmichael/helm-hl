import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const HL_API = 'https://api.hyperliquid.xyz/info';

/**
 * Запрашивает реальный свободный USDC баланс аккаунта на Hyperliquid.
 *
 * API POST body: { "type": "clearinghouseState", "user": "0x..." }
 * Ответ содержит marginSummary.accountValue и withdrawable.
 *
 * Бросает исключение при ошибке (вместо тихого возврата 0). Тихий 0 опасен:
 * вызывающий код мог принять решение «нет средств — ничего не делаем»,
 * хотя в реальности средства есть, просто API недоступен.
 *
 * @returns {Promise<number>} — доступный баланс в USDC
 * @throws {Error} при сетевой ошибке или некорректном ответе
 */
export async function getAvailableBalance() {
  let data;
  try {
    ({ data } = await axios.post(HL_API, {
      type: 'clearinghouseState',
      user: config.wallet.address,
    }));
  } catch (err) {
    logger.error(`[Wallet] Failed to fetch balance: ${err.message}`);
    throw new Error(`Wallet balance fetch failed: ${err.message}`);
  }

  // marginSummary содержит: accountValue, totalNtlPos, totalRawUsd, totalMarginUsed
  const summary = data?.marginSummary;

  if (!summary) {
    const msg = `Unexpected clearinghouseState response: ${JSON.stringify(data).slice(0, 300)}`;
    logger.error(`[Wallet] ${msg}`);
    throw new Error(msg);
  }

  // withdrawable — сумма, которую можно вывести (баланс минус маржа).
  // accountValue — полная стоимость аккаунта (включая нереализованный PnL).
  // Для размера позиции используем withdrawable — это «свободные» деньги.
  const withdrawable = parseFloat(data.withdrawable ?? '0');
  const accountValue = parseFloat(summary.accountValue ?? '0');

  if (isNaN(withdrawable) || isNaN(accountValue)) {
    const msg = 'Failed to parse balance values from Hyperliquid';
    logger.error(`[Wallet] ${msg}`);
    throw new Error(msg);
  }

  logger.info(
    `[Wallet] Account value: $${accountValue.toFixed(2)} | Withdrawable: $${withdrawable.toFixed(2)}`,
  );

  return withdrawable;
}
