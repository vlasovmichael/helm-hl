// ─────────────────────────────────────────────────
//  Lifecycle — shutdown, state persistence, protection
// ─────────────────────────────────────────────────

import { writeFile, readFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition } from '../core/database.js';
import { disconnectExchange } from '../modules/exchange.js';
import { sendMessage, stopCallbackPolling, formatUptime } from '../modules/reporter.js';
import { serializeCircuitBreaker, serializeSniper } from '../modules/executor/state.js';
import { stopDashboard } from '../modules/dashboard/server.js';
import { state, BOT_STATE_PATH } from './state.js';

/**
 * Ожидает завершения текущего тика.
 * @returns {Promise<boolean>} true если дождались, false по таймауту.
 */
export function waitForTick(timeoutMs = 10_000) {
  if (!state.tickRunning) return Promise.resolve(true);

  logger.info('[System] Waiting for current tick to finish…');

  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (!state.tickRunning) {
        clearInterval(check);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        logger.warn('[System] Tick did not finish in time — proceeding with shutdown');
        resolve(false);
      }
    }, 200);
  });
}

/**
 * Сохраняет контекст бота в data/bot_state.json (атомарная запись через tmp + rename).
 */
export async function saveBotState(activePosition, reason) {
  logger.info('[System] Saving bot state…');

  const botState = {
    saved_at:   Date.now(),
    reason,
    mode:       config.mode,
    uptime_min: parseFloat(((Date.now() - state.startedAt) / 60_000).toFixed(1)),
    session_start_equity: state.sessionStartEquity,
    daily_recap_sent_date: state.dailyRecapSentDate,
    last_fomo_alert: state.lastFomoAlert,
    circuit_breaker: serializeCircuitBreaker(),
    sniper: serializeSniper(),
    active_position: activePosition
      ? {
          id:           activePosition.id,
          coin:         activePosition.coin,
          size_usd:     activePosition.size_usd,
          entry_price:  activePosition.entry_price,
          entry_apy:    activePosition.entry_apy,
          entry_time:   activePosition.entry_time,
          held_minutes: parseFloat(((Date.now() - activePosition.entry_time) / 60_000).toFixed(1)),
        }
      : null,
  };

  const json    = JSON.stringify(botState, null, 2);
  const tmpPath = join('data', `.bot_state_${process.pid}.tmp`);

  await mkdir('data', { recursive: true });
  logger.debug(`[System] State dir ready`);

  await writeFile(tmpPath, json, 'utf-8');
  logger.debug(`[System] Wrote ${json.length} bytes to tmp: ${tmpPath}`);

  await rename(tmpPath, BOT_STATE_PATH);
  logger.debug(`[System] Renamed tmp → ${BOT_STATE_PATH}`);

  // Read-back верификация
  const readBack = await readFile(BOT_STATE_PATH, 'utf-8');
  JSON.parse(readBack);

  const posLabel = activePosition ? `#${activePosition.coin}` : 'no position';
  logger.info(
    `[System] ✅ State saved — ${BOT_STATE_PATH} | ${json.length} bytes | ${posLabel} | reason: ${reason}`,
  );

  return botState;
}

/**
 * PRODUCTION: защитные ордера на бирже (заглушка).
 */
export async function ensureExchangeProtection(activePosition) {
  if (!config.isProduction || !activePosition) return;

  logger.warn(
    `[System] ⚠️ PRODUCTION shutdown with open position #${activePosition.coin} — ` +
      `ensure hard SL/TP orders exist on exchange (SDK integration pending)`,
  );
}

/**
 * Отправляет Telegram-уведомление о завершении работы.
 */
async function sendShutdownNotification(activePosition, reason) {
  const uptimeMin = (Date.now() - state.startedAt) / 60_000;

  let status = '💤 Нет открытых позиций';
  if (activePosition) {
    const heldH = ((Date.now() - activePosition.entry_time) / 3_600_000).toFixed(1);
    status =
      `📌 Открыта: <b>#${activePosition.coin}</b>\n` +
      `💰 $${activePosition.size_usd.toFixed(2)} @ $${activePosition.entry_price}\n` +
      `📊 APY: ${activePosition.entry_apy.toFixed(2)}%\n` +
      `⏳ Удержание: ${heldH}ч`;
  }

  await sendMessage(
    `🛑 <b>[SYSTEM] Бот остановлен</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📡 Сигнал: <b>${reason}</b>\n` +
      `⏱ Uptime: ${formatUptime(uptimeMin)}\n` +
      `<code>─────────────────────</code>\n` +
      `${status}\n` +
      `<code>─────────────────────</code>\n` +
      `✅ Параметры сохранены.`,
  );
}

/**
 * Graceful shutdown — 6 шагов.
 */
export async function shutdown(signal) {
  if (state.shuttingDown) {
    logger.warn(`[System] ${signal} received again — shutdown already in progress`);
    return;
  }
  state.shuttingDown = true;
  const t0 = Date.now();

  logger.info('───────────────────────────────────────────────');
  logger.info(`[System] ${signal} — graceful shutdown BEGIN`);
  logger.info('───────────────────────────────────────────────');

  // ── [1/6] Остановить тик-лупу + polling + dashboard ──
  logger.info('[System] [1/6] Stopping tick loop & polling & dashboard…');
  if (state.tickTimer) {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
  stopCallbackPolling();
  try {
    await stopDashboard();
  } catch (err) {
    logger.warn(`[System] Dashboard stop error: ${err.message}`);
  }
  logger.info('[System] [1/6] ✅ Tick loop & polling & dashboard stopped');

  // ── [2/6] Дождаться завершения текущего тика ─
  logger.info('[System] [2/6] Waiting for active tick to finish…');
  const tickDone = await waitForTick(10_000);
  logger.info(
    tickDone
      ? '[System] [2/6] ✅ Tick finished cleanly'
      : '[System] [2/6] ⚠️  Tick timed out — proceeding anyway',
  );

  // ── [3/6] Собрать информацию об активной позиции
  logger.info('[System] [3/6] Reading active position from DB…');
  let activePosition = null;
  try {
    activePosition = getActivePosition();
    logger.info(
      activePosition
        ? `[System] [3/6] ✅ Active position: #${activePosition.coin} ($${activePosition.size_usd.toFixed(2)}, entry APY ${activePosition.entry_apy.toFixed(2)}%)`
        : '[System] [3/6] ✅ No active position',
    );
  } catch (err) {
    logger.error(`[System] [3/6] ❌ Failed to read active position: ${err.message}`);
  }

  // ── [4/6] Сохранить стейт ────────────────────
  logger.info('[System] [4/6] Persisting bot state…');
  try {
    await saveBotState(activePosition, signal);
    logger.info('[System] [4/6] ✅ State persisted');
  } catch (err) {
    logger.error(`[System] [4/6] ❌ State save failed: ${err.message}`);
  }

  // ── [5/6] PRODUCTION: защитные ордера ────────
  logger.info('[System] [5/6] Checking exchange protection…');
  try {
    await ensureExchangeProtection(activePosition);
    logger.info('[System] [5/6] ✅ Exchange protection checked');
  } catch (err) {
    logger.error(`[System] [5/6] ❌ Exchange protection check failed: ${err.message}`);
  }

  // ── [6/6] Telegram + закрыть БД ──────────────
  logger.info('[System] [6/6] Sending Telegram notification…');
  try {
    await sendShutdownNotification(activePosition, signal);
    logger.info('[System] [6/6] ✅ Telegram notification sent');
  } catch (err) {
    logger.error(`[System] [6/6] ❌ Telegram notification failed: ${err.message}`);
  }

  try {
    await disconnectExchange();
  } catch (err) {
    logger.error(`[System] ❌ Exchange disconnect error: ${err.message}`);
  }

  if (state.db) {
    try {
      state.db.close();
      logger.info('[System] ✅ Database closed');
    } catch (err) {
      logger.error(`[System] ❌ DB close error: ${err.message}`);
    }
  }

  const elapsed = Date.now() - t0;
  logger.info('───────────────────────────────────────────────');
  logger.info(`[System] Shutdown complete in ${elapsed}ms. Goodbye.`);
  logger.info('───────────────────────────────────────────────');
  process.exit(0);
}
