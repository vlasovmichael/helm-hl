// ─────────────────────────────────────────────────
//  Суточное обслуживание
// ─────────────────────────────────────────────────
// 🚨 maybeAutoCleanup ДЕЙСТВУЕТ (архивирует историю, сдвигает baseline equity),
// а не уведомляет — единственная причина, по которой файл жив.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  getActivePosition,
  getHistory,
  archiveAndClearHistory,
} from '../core/database.js';
import { getAccountSummary } from '../modules/exchange.js';
import { getAccountEquity } from '../modules/wallet.js';
import { state, DAILY_RECAP_HOUR } from './state.js';

/**
 * Суточный хук, вызывается каждый тик из tick.js. Внутри — гейт по часу, так
 * что тело отрабатывает раз в день.
 */
export async function runDailyMaintenance() {
  const now = new Date();
  if (now.getHours() !== DAILY_RECAP_HOUR) return;

  const today = now.toISOString().slice(0, 10);
  if (state.dailyRecapSentDate === today) return;
  state.dailyRecapSentDate = today;

  let equity = 0;
  try {
    equity = config.isProduction
      ? (await getAccountSummary()).equity
      : await getAccountEquity();
  } catch {
    // Ниже есть guard на equity<=0 — с нулём автоочистка просто не тронет baseline.
  }

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

  // Guard: если API вернул подозрительный $0 или equity схлопнулся (>50% падения),
  // не трогаем baseline — это почти наверняка глитч индексатора, а не реальный убыток.
  // Сделок всё равно нет (IDLE), так что Auto-Cleanup подождёт до следующих суток.
  const baseline = state.sessionStartEquity;
  if (currentEquity <= 0 || (baseline > 0 && currentEquity < baseline * 0.5)) {
    logger.warn(
      `[System] Auto-Cleanup skipped: equity looks suspicious ` +
        `($${currentEquity.toFixed(2)} vs baseline $${baseline.toFixed(2)}). ` +
        `Не сбрасываю baseline — возможно API-глитч.`,
    );
    return;
  }

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
  } catch (err) {
    logger.error(`[System] Auto-Cleanup failed: ${err.message}`);
  }
}
