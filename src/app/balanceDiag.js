// ─────────────────────────────────────────────────
//  Balance Diagnostics — periodic perp/spot snapshot
// ─────────────────────────────────────────────────
// Печатает компактный срез баланса (perp + spot) каждые N минут.
// Цель — поймать момент когда USDC уезжает в spot wallet (Unified
// Account Mode или подобное), и связать это с конкретным торговым
// событием (close, funding, ADL). Симптом-фикс уже сделан в
// fetchBalanceFromSdk (авто-трансфер), это для диагностики первопричины.
//
// Вызывается из tick.js. PROD-only. Дросселируется через state.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getExchange } from '../modules/exchange.js';

const DIAG_INTERVAL_MS = 5 * 60_000; // каждые 5 мин
let lastDiagAt = 0;

export async function runBalanceDiag() {
  if (!config.isProduction) return;
  const now = Date.now();
  if (now - lastDiagAt < DIAG_INTERVAL_MS) return;
  lastDiagAt = now;

  try {
    const sdk = getExchange();

    const [perp, spot] = await Promise.all([
      sdk.info.perpetuals.getClearinghouseState(config.wallet.address),
      sdk.info.spot.getSpotClearinghouseState(config.wallet.address),
    ]);

    const ms = perp?.marginSummary ?? {};
    const cms = perp?.crossMarginSummary ?? {};
    const perpAcct = parseFloat(ms.accountValue ?? '0');
    const perpWithdrawable = parseFloat(perp?.withdrawable ?? '0');
    const perpUnrealized = parseFloat(
      ms.totalUnrealizedPnl ?? ms.unrealizedPnl ?? '0',
    );
    const perpPositions = (perp?.assetPositions ?? []).filter(
      (ap) => parseFloat(ap?.position?.szi ?? '0') !== 0,
    ).length;

    const balances = spot?.balances ?? [];
    const usdcEntry = balances.find(
      (b) => (b.coin ?? '').toUpperCase() === 'USDC',
    );
    const spotUsdc = usdcEntry ? parseFloat(usdcEntry.total ?? '0') : 0;
    const spotUsdcHold = usdcEntry ? parseFloat(usdcEntry.hold ?? '0') : 0;
    const otherSpot = balances
      .filter((b) => (b.coin ?? '').toUpperCase() !== 'USDC')
      .filter((b) => parseFloat(b.total ?? '0') > 0)
      .map((b) => `${b.coin}=${parseFloat(b.total).toFixed(4)}`);

    // Indicators which могут намекать на Unified Mode / cross-margin.
    // Точная семантика этих полей не задокументирована универсально —
    // логируем как есть, потом сопоставим с UI-настройкой.
    const indicators = [
      `crossAcct=$${parseFloat(cms.accountValue ?? '0').toFixed(2)}`,
      `crossLev=${cms.accountLeverage ?? 'n/a'}`,
      `marginUsed=$${parseFloat(ms.totalMarginUsed ?? '0').toFixed(2)}`,
    ];

    logger.info(
      `[BalanceDiag] perp.acct=$${perpAcct.toFixed(2)} ` +
        `withdraw=$${perpWithdrawable.toFixed(2)} ` +
        `uPnl=${perpUnrealized >= 0 ? '+' : ''}$${perpUnrealized.toFixed(2)} ` +
        `pos=${perpPositions} | ` +
        `spot.USDC=$${spotUsdc.toFixed(2)}` +
        (spotUsdcHold > 0 ? ` (hold $${spotUsdcHold.toFixed(2)})` : '') +
        (otherSpot.length ? ` other=[${otherSpot.join(',')}]` : '') +
        ` | ${indicators.join(' ')}`,
    );

    // Алерт когда есть существенный split — это та самая ситуация
    // Unified Mode, для которой работает авто-трансфер.
    if (spotUsdc > 0.5 && perpAcct > 0) {
      logger.warn(
        `[BalanceDiag] ⚠️  Funds split: perp=$${perpAcct.toFixed(2)} ` +
          `+ spot=$${spotUsdc.toFixed(2)}. Auto-transfer activates only when ` +
          `perp=$0; current state has both — possibly Unified Mode partial.`,
      );
    }
  } catch (err) {
    logger.warn(`[BalanceDiag] failed: ${err.message}`);
  }
}
