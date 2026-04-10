// ─────────────────────────────────────────────────
//  Smart Alerts — аномалии, FOMO, PnL, Daily Recap
// ─────────────────────────────────────────────────

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, getHistory, getHistorySince, archiveAndClearHistory } from '../core/database.js';
import { getAccountSummary, getMarkPrice } from '../modules/exchange.js';
import { getAvailableBalance } from '../modules/wallet.js';
import {
  sendMessage,
  sendAnomalyAlert,
  sendFomoAlert,
  sendDailySummary,
  sendPnlAlert,
} from '../modules/reporter.js';
import {
  state,
  FOMO_COOLDOWN_MS,
  ANOMALY_THRESHOLD,
  FOMO_UPLIFT_MIN,
  DAILY_RECAP_HOUR,
  PNL_ALERT_PCT,
  PNL_ALERT_COOLDOWN_MS,
} from './state.js';

/**
 * Запускает все Smart Alerts за один тик.
 */
export async function runSmartAlerts(scoutData, signal, activePosition) {
  const now = Date.now();
  const uptimeMs = now - state.botStartedAt;
  const skipNoisy = uptimeMs < 60_000; // Пропускаем Recap/FOMO в первые 60с

  // ── 1. Аномалия APY (только при открытой позиции) ─────────────────
  if (activePosition) {
    const coin    = activePosition.coin;
    const current = scoutData.find((m) => m.coin === coin);
    const prevApy = state.prevApyMap.get(coin);

    if (current && prevApy != null && prevApy > 0) {
      const drop = (prevApy - current.smoothedApy) / prevApy;
      if (drop >= ANOMALY_THRESHOLD) {
        await sendAnomalyAlert(coin, prevApy, current.smoothedApy);
      }
    }
  }

  // Обновляем карту APY для следующего тика (важно даже в первые 60с)
  for (const m of scoutData) {
    state.prevApyMap.set(m.coin, m.smoothedApy);
  }

  // ── 2. FOMO-алерт (позиция открыта, ротация невыгодна) ───────────
  if (
    !skipNoisy &&
    activePosition &&
    signal.action === 'HOLD' &&
    now - state.lastFomoAlert >= FOMO_COOLDOWN_MS
  ) {
    const currentCoin = activePosition.coin;
    const current     = scoutData.find((m) => m.coin === currentCoin);
    const best        = scoutData.find((m) => m.coin !== currentCoin);

    if (current && best && best.smoothedApy >= current.smoothedApy * FOMO_UPLIFT_MIN) {
      const ROUND_TRIP   = (0.0002 + 0.0001) * 2;
      const deltaHourly  = (best.smoothedApy - current.smoothedApy) / 100 / 365 / 24;
      const paybackHours = deltaHourly > 0 ? ROUND_TRIP / (0.5 * deltaHourly) : Infinity;

      if (paybackHours > 6) {
        await sendFomoAlert(currentCoin, best.coin, current.smoothedApy, best.smoothedApy, paybackHours);
        state.lastFomoAlert = now;
      }
    }
  }

  // ── 3. PnL Alert (unrealized PnL > ±3% от equity) ────────────────
  if (activePosition && now - state.lastPnlAlert >= PNL_ALERT_COOLDOWN_MS) {
    try {
      const markPrice = await getMarkPrice(activePosition.coin);
      if (markPrice != null) {
        const qty           = activePosition.size_usd / activePosition.entry_price;
        const unrealizedPnl = (activePosition.entry_price - markPrice) * qty;

        let equity = activePosition.size_usd; // fallback
        try {
          if (config.isProduction) {
            const summary = await getAccountSummary();
            equity = summary.equity;
          } else {
            equity = await getAvailableBalance();
          }
        } catch { /* fallback to size_usd */ }

        const pnlPct = equity > 0 ? (Math.abs(unrealizedPnl) / equity) * 100 : 0;

        if (pnlPct >= PNL_ALERT_PCT) {
          await sendPnlAlert({
            coin:          activePosition.coin,
            markPrice,
            entryPrice:    activePosition.entry_price,
            unrealizedPnl,
            pnlPct:        unrealizedPnl >= 0 ? pnlPct : -pnlPct,
            equity,
          });
          state.lastPnlAlert = now;
        }
      }
    } catch (err) {
      logger.debug(`[Tick] PnL alert check failed: ${err.message}`);
    }
  }

  // ── 4. Daily Recap ───────────────────────────────────────────────
  if (!skipNoisy) {
    await checkDailyRecap();
  }
}

/**
 * Daily Recap — один раз в день в DAILY_RECAP_HOUR.
 */
async function checkDailyRecap() {
  const now  = new Date();
  const hour = now.getHours();

  if (hour !== DAILY_RECAP_HOUR) return;

  const today = now.toISOString().slice(0, 10);
  if (state.dailyRecapSentDate === today) return;

  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayHistory = getHistorySince(dayStart);

  let equity = 0;
  try {
    if (config.isProduction) {
      const summary = await getAccountSummary();
      equity = summary.equity;
    } else {
      equity = await getAvailableBalance();
    }
  } catch { /* покажем $0 */ }

  const sessionProfit = state.sessionStartEquity > 0 ? equity - state.sessionStartEquity : 0;

  if (todayHistory.length === 0) {
    logger.info('[System] Daily Recap skipped — no trades today');
    state.dailyRecapSentDate = today;
    await maybeAutoCleanup(equity);
    return;
  }

  const totalTrades = todayHistory.length;
  const winTrades   = todayHistory.filter((t) => t.realized_pnl > 0).length;
  const totalPnl    = todayHistory.reduce((s, t) => s + t.realized_pnl, 0);
  const totalFees   = todayHistory.reduce((s, t) => s + t.fee_paid, 0);
  const bestTrade   = todayHistory.reduce(
    (best, t) => (!best || t.realized_pnl > best.realized_pnl ? t : best),
    null,
  );

  const activePosition = getActivePosition();

  await sendDailySummary({
    totalTrades, winTrades, totalPnl, totalFees,
    bestTrade, activePosition, equity,
    sessionProfit, sessionStartEquity: state.sessionStartEquity,
  });

  state.dailyRecapSentDate = today;
  logger.info(`[System] Daily Recap sent for ${today}`);

  await maybeAutoCleanup(equity);
}

/**
 * Auto-Cleanup: если бот в IDLE >1 часа, архивируем историю
 * и сбрасываем session baseline equity.
 */
async function maybeAutoCleanup(currentEquity) {
  const activePosition = getActivePosition();
  if (activePosition) return;

  const IDLE_THRESHOLD_MS = 60 * 60_000; // 1 час
  if (state.lastIdleAt === 0 || Date.now() - state.lastIdleAt < IDLE_THRESHOLD_MS) return;

  const allHistory = getHistory(10_000);
  if (allHistory.length === 0) return;

  logger.info(
    `[System] Auto-Cleanup: IDLE for ${((Date.now() - state.lastIdleAt) / 60_000).toFixed(0)}min, ` +
      `archiving ${allHistory.length} trades…`,
  );

  try {
    const archived = archiveAndClearHistory();

    const oldBaseline = state.sessionStartEquity;
    state.sessionStartEquity = currentEquity;

    logger.info(
      `[System] ✅ Auto-Cleanup complete: ${archived} trades archived | ` +
        `baseline equity reset: $${oldBaseline.toFixed(2)} → $${state.sessionStartEquity.toFixed(2)}`,
    );

    await sendMessage(
      `🧹 <b>Auto-Cleanup</b>\n` +
        `<code>─────────────────────</code>\n` +
        `📦 Заархивировано: <b>${archived} сделок</b>\n` +
        `💰 Новый baseline: <b>$${state.sessionStartEquity.toFixed(2)}</b>\n` +
        `<i>Предыдущий: $${oldBaseline.toFixed(2)}</i>\n` +
        `<code>─────────────────────</code>\n` +
        `🤖 Новый цикл учёта начат.`,
    );
  } catch (err) {
    logger.error(`[System] Auto-Cleanup failed: ${err.message}`);
  }
}
