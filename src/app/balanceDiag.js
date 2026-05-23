// ─────────────────────────────────────────────────
//  Balance Diagnostics — periodic snapshot (unified mode)
// ─────────────────────────────────────────────────
// Печатает компактный срез баланса каждые N минут.
// После миграции HL 2026-05-23 (см. memory/hl_unified_migration_2026_05_23.md):
//   - Source of truth = spot.USDC (total / hold)
//   - perp.clearinghouseState полезен только для unrealizedPnl и позиций
//   - "MANUAL SWAP REQUIRED" алерт удалён: свапа в unified mode не существует
//
// Вызывается из tick.js. PROD-only. Дросселируется через state.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getExchange } from '../modules/exchange.js';
import { saveEquitySnapshot } from '../core/database.js';

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
    const perpUnrealized = parseFloat(
      ms.totalUnrealizedPnl ?? ms.unrealizedPnl ?? '0',
    );
    const perpPositions = (perp?.assetPositions ?? []).filter(
      (ap) => parseFloat(ap?.position?.szi ?? '0') !== 0,
    ).length;

    const balances = spot?.balances ?? [];
    const isUsdc = (c) => {
      const u = (c ?? '').toUpperCase();
      return u === 'USDC' || u === 'USDC-SPOT';
    };
    const usdcEntry = balances.find((b) => isUsdc(b.coin));
    const spotTotal = usdcEntry ? parseFloat(usdcEntry.total ?? '0') : 0;
    const spotHold  = usdcEntry ? parseFloat(usdcEntry.hold ?? '0')  : 0;
    const free = Math.max(0, spotTotal - spotHold);
    const equity = spotTotal + (Number.isFinite(perpUnrealized) ? perpUnrealized : 0);

    const otherSpot = balances
      .filter((b) => !isUsdc(b.coin))
      .filter((b) => parseFloat(b.total ?? '0') > 0)
      .map((b) => `${b.coin}=${parseFloat(b.total).toFixed(4)}`);

    logger.info(
      `[BalanceDiag] equity=$${equity.toFixed(2)} ` +
        `free=$${free.toFixed(2)} hold=$${spotHold.toFixed(2)} ` +
        `uPnl=${perpUnrealized >= 0 ? '+' : ''}$${perpUnrealized.toFixed(2)} ` +
        `pos=${perpPositions}` +
        (otherSpot.length ? ` other=[${otherSpot.join(',')}]` : ''),
    );

    // Equity-снапшот для Performance-графика. Раньше использовали perp
    // accountValue; в unified mode источник = spot.total + perp.uPnl.
    if (equity > 0) {
      saveEquitySnapshot(equity);
    }
  } catch (err) {
    logger.warn(`[BalanceDiag] failed: ${err.message}`);
  }
}
