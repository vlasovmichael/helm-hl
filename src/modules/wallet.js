import axios from 'axios';
import { config } from '../core/config.js';
import { retryWithBackoff } from '../core/retry.js';
import { getCachedBalance } from '../core/balanceCache.js';

const HL_API = 'https://api.hyperliquid.xyz/info';

/**
 * Низкоуровневый fetch clearinghouseState через raw axios (PAPER path).
 * Retry — только на сетевые ошибки. Валидность и $0-логика — в balanceCache.
 *
 * @returns {Promise<{ accountValue: number, withdrawable: number, unrealizedPnl: number }>}
 */
async function fetchClearinghouse() {
  return retryWithBackoff(
    async () => {
      const { data } = await axios.post(
        HL_API,
        { type: 'clearinghouseState', user: config.wallet.address },
        { timeout: 10_000 },
      );

      const summary = data?.marginSummary;
      if (!summary) {
        throw new Error(
          `Unexpected clearinghouseState response: ${JSON.stringify(data).slice(0, 300)}`,
        );
      }

      const accountValue  = parseFloat(summary.accountValue ?? '0');
      const withdrawable  = parseFloat(data.withdrawable ?? '0');
      const unrealizedPnl = parseFloat(summary.totalUnrealizedPnl ?? summary.unrealizedPnl ?? '0');

      if (isNaN(accountValue) || isNaN(withdrawable)) {
        throw new Error('Failed to parse balance values from Hyperliquid');
      }

      return { accountValue, withdrawable, unrealizedPnl };
    },
    { label: 'wallet-get-balance', maxRetries: 3, baseDelayMs: 2000 },
  );
}

/**
 * Свободный USDC-баланс (withdrawable) — для расчёта размера позиции.
 * Защищён stale-cache'ом от API-глитчей.
 *
 * @returns {Promise<number>}
 * @throws {Error} при сетевой ошибке без свежего кэша
 */
export async function getAvailableBalance() {
  const snap = await getCachedBalance(fetchClearinghouse);
  return snap.withdrawable;
}

/**
 * Полный equity аккаунта (accountValue) — для drawdown-гарда.
 * В отличие от withdrawable, не проседает из-за занятой маржи.
 *
 * @returns {Promise<number>}
 * @throws {Error} при сетевой ошибке без свежего кэша
 */
export async function getAccountEquity() {
  const snap = await getCachedBalance(fetchClearinghouse);
  return snap.accountValue;
}
