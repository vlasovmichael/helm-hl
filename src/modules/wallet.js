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
 * @returns {Promise<number>} — доступный баланс в USDC
 */
export async function getAvailableBalance() {
  try {
    const { data } = await axios.post(HL_API, {
      type: 'clearinghouseState',
      user: config.wallet.address,
    });

    // marginSummary содержит: accountValue, totalNtlPos, totalRawUsd, totalMarginUsed
    const summary = data?.marginSummary;

    if (!summary) {
      throw new Error(
        `Unexpected clearinghouseState response: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }

    // withdrawable — сумма, которую можно вывести (баланс минус маржа).
    // accountValue — полная стоимость аккаунта (включая нереализованный PnL).
    // Для размера позиции используем withdrawable — это «свободные» деньги.
    const withdrawable = parseFloat(data.withdrawable ?? '0');
    const accountValue = parseFloat(summary.accountValue ?? '0');

    if (isNaN(withdrawable) || isNaN(accountValue)) {
      throw new Error('Failed to parse balance values from Hyperliquid');
    }

    logger.info(
      `[Wallet] Account value: $${accountValue.toFixed(2)} | Withdrawable: $${withdrawable.toFixed(2)}`,
    );

    return withdrawable;
  } catch (err) {
    logger.error(`[Wallet] Failed to fetch balance: ${err.message}`);
    return 0;
  }
}
