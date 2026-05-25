import { config } from '../core/config.js';
import { getCachedBalance } from '../core/balanceCache.js';
import { hlInfo } from '../core/hlClient.js';

// HL 2026-05-23 migration: unified account стал default'ом. Source of truth
// баланса — spotClearinghouseState. clearinghouseState (perp) теперь by
// design $0 без открытых позиций. Полная история — memory/hl_unified_migration_2026_05_23.md
//
// Контракт balanceCache не меняем — те же поля {accountValue, withdrawable,
// unrealizedPnl}, просто считаем их из новых источников:
//   accountValue  = spot.USDC.total + perp.unrealizedPnl
//   withdrawable  = spot.USDC.total - spot.USDC.hold
//   unrealizedPnl = perp.marginSummary.totalUnrealizedPnl
async function fetchUnifiedBalance() {
  const [perp, spot] = await Promise.all([
    hlInfo(
      { type: 'clearinghouseState', user: config.wallet.address },
      { label: 'wallet/perp', timeoutMs: 10_000 },
    ),
    hlInfo(
      { type: 'spotClearinghouseState', user: config.wallet.address },
      { label: 'wallet/spot', timeoutMs: 10_000 },
    ),
  ]);

  const ms = perp?.marginSummary ?? {};
  const perpUnrealized = parseFloat(
    ms.totalUnrealizedPnl ?? ms.unrealizedPnl ?? '0',
  );

  const balances = spot?.balances ?? [];
  const usdc = balances.find((b) => {
    const c = (b?.coin ?? '').toUpperCase();
    return c === 'USDC' || c === 'USDC-SPOT';
  });
  const spotTotal = usdc ? parseFloat(usdc.total ?? '0') : 0;
  const spotHold  = usdc ? parseFloat(usdc.hold ?? '0')  : 0;

  if (!Number.isFinite(spotTotal) || !Number.isFinite(spotHold)) {
    throw new Error('Failed to parse spot USDC balance from Hyperliquid');
  }

  const accountValue = spotTotal + (Number.isFinite(perpUnrealized) ? perpUnrealized : 0);
  const withdrawable = Math.max(0, spotTotal - spotHold);

  return {
    accountValue,
    withdrawable,
    unrealizedPnl: Number.isFinite(perpUnrealized) ? perpUnrealized : 0,
  };
}

/**
 * Свободный USDC-баланс (доступный под новые позиции).
 * В unified mode = spot.USDC.total - spot.USDC.hold.
 *
 * @returns {Promise<number>}
 */
export async function getAvailableBalance() {
  const snap = await getCachedBalance(fetchUnifiedBalance);
  return snap.withdrawable;
}

/**
 * Полный equity аккаунта (для drawdown-гарда и P&L отчётов).
 * В unified mode = spot.USDC.total + perp.unrealizedPnl.
 *
 * @returns {Promise<number>}
 */
export async function getAccountEquity() {
  const snap = await getCachedBalance(fetchUnifiedBalance);
  return snap.accountValue;
}
