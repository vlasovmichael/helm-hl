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
import { sendMessage } from '../modules/reporter.js';

const DIAG_INTERVAL_MS = 5 * 60_000; // каждые 5 мин
let lastDiagAt = 0;
let manualSwapAlerted = false; // одноразовый TG-алерт "сделай свап руками"

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
    const isUsdc = (c) => {
      const u = (c ?? '').toUpperCase();
      return u === 'USDC' || u === 'USDC-SPOT';
    };
    const usdcEntry = balances.find((b) => isUsdc(b.coin));
    const spotUsdc = usdcEntry ? parseFloat(usdcEntry.total ?? '0') : 0;
    const spotUsdcHold = usdcEntry ? parseFloat(usdcEntry.hold ?? '0') : 0;
    const otherSpot = balances
      .filter((b) => !isUsdc(b.coin))
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

    // Алерт когда perp=$0 а в споте есть деньги — нужен РУЧНОЙ свап
    // на HL UI. Авто-фикс не делаем: HL не разрешает usdClassTransfer
    // от agent wallet ("Must deposit before performing actions").
    if (perpAcct <= 0 && spotUsdc > 0.5) {
      logger.error(
        `[BalanceDiag] ⚠️  perp=$0, spot=$${spotUsdc.toFixed(2)} USDC — ` +
          `MANUAL SWAP REQUIRED on app.hyperliquid.xyz (Spot → Transfer to Perp).`,
      );
      if (!manualSwapAlerted) {
        manualSwapAlerted = true;
        sendMessage(
          `⚠️ <b>Funds в spot wallet — нужен ручной свап</b>\n` +
            `<code>─────────────────────</code>\n` +
            `Perp account: $0.00\n` +
            `Spot USDC: <b>$${spotUsdc.toFixed(2)}</b>\n\n` +
            `Auto-transfer невозможен (HL не разрешает agent ключу). ` +
            `Зайди на app.hyperliquid.xyz → Spot → Transfer to Perp.`,
        ).catch(() => { /* TG недоступен — ок */ });
      }
    } else if (perpAcct > 0 && manualSwapAlerted) {
      // Свап сделан вручную, сбрасываем флаг чтобы алерт сработал в следующий раз
      manualSwapAlerted = false;
    }
  } catch (err) {
    logger.warn(`[BalanceDiag] failed: ${err.message}`);
  }
}
