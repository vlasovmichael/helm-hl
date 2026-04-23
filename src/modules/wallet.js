import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { retryWithBackoff } from '../core/retry.js';

const HL_API = 'https://api.hyperliquid.xyz/info';

/**
 * Запрашивает реальный свободный USDC баланс аккаунта на Hyperliquid.
 *
 * API POST body: { "type": "clearinghouseState", "user": "0x..." }
 * Ответ содержит marginSummary.accountValue и withdrawable.
 *
 * Обернуто в retry: если API вернуло 0.00, мы пробуем еще раз (лаг индексатора).
 *
 * @returns {Promise<number>} — доступный баланс в USDC
 * @throws {Error} при сетевой ошибке или если баланс стабильно 0
 */
export async function getAvailableBalance() {
  return retryWithBackoff(async () => {
    let data;
    try {
      ({ data } = await axios.post(HL_API, {
        type: 'clearinghouseState',
        user: config.wallet.address,
      }, { timeout: 10000 }));
    } catch (err) {
      logger.error(`[Wallet] Failed to fetch balance: ${err.message}`);
      throw err;
    }

    const summary = data?.marginSummary;
    if (!summary) {
      const msg = `Unexpected clearinghouseState response: ${JSON.stringify(data).slice(0, 300)}`;
      logger.error(`[Wallet] ${msg}`);
      throw new Error(msg);
    }

    const withdrawable = parseFloat(data.withdrawable ?? '0');
    const accountValue = parseFloat(summary.accountValue ?? '0');

    if (isNaN(withdrawable) || isNaN(accountValue)) {
      const msg = 'Failed to parse balance values from Hyperliquid';
      logger.error(`[Wallet] ${msg}`);
      throw new Error(msg);
    }

    // Защита от лага индексатора: если на счету 0.00, пробуем еще раз.
    // Если деньги реально кончились — после 3 попыток вернем 0.
    if (accountValue === 0 && withdrawable === 0) {
      throw new Error('API returned $0.00 (possibly indexer lag)');
    }

    logger.info(
      `[Wallet] Account value: $${accountValue.toFixed(2)} | Withdrawable: $${withdrawable.toFixed(2)}`,
    );

    return withdrawable;
  }, { label: 'get-balance', maxRetries: 3, baseDelayMs: 2000 }).catch(err => {
    // Если после всех ретраев всё еще 0 — значит действительно 0
    if (err.message.includes('possibly indexer lag')) {
      return 0;
    }
    throw err;
  });
}
