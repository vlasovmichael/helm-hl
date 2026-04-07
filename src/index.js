import { writeFile, readFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { initDB, getActivePosition, getHistory } from './core/database.js';
import { scan } from './modules/scout.js';
import { analyze } from './modules/strategist.js';
import { execute } from './modules/executor.js';
import { sendMessage, sendAnomalyAlert, sendFomoAlert, sendDailySummary } from './modules/reporter.js';
import { syncWithExchange } from './modules/sync.js';

const TICK_INTERVAL_MS    = 15_000;          // 15 секунд
const DAILY_INTERVAL_MS   = 24 * 3_600_000;  // 24 часа
const FOMO_COOLDOWN_MS    = 4 * 3_600_000;   // не чаще 1 раза в 4 часа
const ANOMALY_THRESHOLD   = 0.30;            // 30% падение APY за тик → аномалия
const FOMO_UPLIFT_MIN     = 1.50;            // лучший кандидат должен быть на 50% выше

const BOT_STATE_PATH = 'data/bot_state.json';
const SHUTDOWN_TIMEOUT_MS = 15_000;           // максимум 15с на завершение

let db;
let tickTimer;
let tickRunning      = false;
let shuttingDown     = false;                 // защита от двойного SIGINT
let startedAt        = Date.now();
let lastDailySummary = Date.now();           // первая сводка через 24ч
let lastFomoAlert    = 0;                    // UNIX ms последнего FOMO-алерта
let prevApyMap       = new Map();            // coin → smoothedApy прошлого тика

async function runSmartAlerts(scoutData, signal, activePosition) {
  const now = Date.now();

  // ── 1. Аномалия APY (только при открытой позиции) ─────────────────
  if (activePosition) {
    const coin    = activePosition.coin;
    const current = scoutData.find((m) => m.coin === coin);
    const prevApy = prevApyMap.get(coin);

    if (current && prevApy != null && prevApy > 0) {
      const drop = (prevApy - current.smoothedApy) / prevApy;
      if (drop >= ANOMALY_THRESHOLD) {
        await sendAnomalyAlert(coin, prevApy, current.smoothedApy);
      }
    }
  }

  // Обновляем карту APY для следующего тика
  for (const m of scoutData) {
    prevApyMap.set(m.coin, m.smoothedApy);
  }

  // ── 2. FOMO-алерт (позиция открыта, ротация невыгодна) ───────────
  if (
    activePosition &&
    signal.action === 'HOLD' &&
    now - lastFomoAlert >= FOMO_COOLDOWN_MS
  ) {
    const currentCoin = activePosition.coin;
    const current     = scoutData.find((m) => m.coin === currentCoin);
    const best        = scoutData.find((m) => m.coin !== currentCoin);

    if (current && best && best.smoothedApy >= current.smoothedApy * FOMO_UPLIFT_MIN) {
      // Стратег уже посчитал paybackHours — вычислим здесь по той же формуле
      const ROUND_TRIP   = (0.0002 + 0.0001) * 2;
      const deltaHourly  = (best.smoothedApy - current.smoothedApy) / 100 / 365 / 24;
      const paybackHours = deltaHourly > 0 ? ROUND_TRIP / (0.5 * deltaHourly) : Infinity;

      if (paybackHours > 6) { // только если ротация невыгодна (иначе Стратег бы уже переключил)
        await sendFomoAlert(currentCoin, best.coin, current.smoothedApy, best.smoothedApy, paybackHours);
        lastFomoAlert = now;
      }
    }
  }

  // ── 3. Дневная сводка ─────────────────────────────────────────────
  if (now - lastDailySummary >= DAILY_INTERVAL_MS) {
    await runDailySummary();
    lastDailySummary = now;
  }
}

async function runDailySummary() {
  const history       = getHistory(1000); // всё за последние 1000 сделок
  const activePosition = getActivePosition();

  const totalTrades = history.length;
  const winTrades   = history.filter((t) => t.realized_pnl > 0).length;
  const totalPnl    = history.reduce((s, t) => s + t.realized_pnl, 0);
  const totalFees   = history.reduce((s, t) => s + t.fee_paid, 0);
  const bestTrade   = history.reduce(
    (best, t) => (!best || t.realized_pnl > best.realized_pnl ? t : best),
    null,
  );

  await sendDailySummary({ totalTrades, winTrades, totalPnl, totalFees, bestTrade, activePosition });
}

async function tick() {
  if (tickRunning || shuttingDown) return;
  tickRunning = true;

  try {
    const scoutData = await scan();

    if (scoutData.length === 0) {
      logger.info('[Tick] Scout returned empty data — skipping');
      return;
    }

    const activePosition = getActivePosition();
    const signal         = analyze(scoutData, activePosition);

    if (signal.action !== 'HOLD') {
      await execute(signal, activePosition);
    }

    await runSmartAlerts(scoutData, signal, activePosition);

  } catch (err) {
    logger.error(`[Tick] ${err.message}`);
  } finally {
    tickRunning = false;
  }
}

/**
 * Сохраняет контекст бота в data/bot_state.json (атомарная запись через tmp + rename).
 *
 * Последовательность:
 *   1. Формируем JSON-объект стейта
 *   2. Создаём data/ если нет
 *   3. Пишем во временный файл .bot_state_<pid>.tmp
 *   4. rename() — атомарна на POSIX (оба файла на одном разделе)
 *   5. Read-back: перечитываем и парсим — гарантия, что диск принял данные
 */
async function saveBotState(activePosition, reason) {
  logger.info('[System] Saving bot state…');

  const state = {
    saved_at:   Date.now(),
    reason,
    mode:       config.mode,
    uptime_min: parseFloat(((Date.now() - startedAt) / 60_000).toFixed(1)),
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

  const json    = JSON.stringify(state, null, 2);
  const tmpPath = join('data', `.bot_state_${process.pid}.tmp`);

  // Шаг 1: убедиться, что директория существует
  await mkdir('data', { recursive: true });
  logger.debug(`[System] State dir ready`);

  // Шаг 2: записать во временный файл
  await writeFile(tmpPath, json, 'utf-8');
  logger.debug(`[System] Wrote ${json.length} bytes to tmp: ${tmpPath}`);

  // Шаг 3: атомарно переименовать tmp → финальный файл
  await rename(tmpPath, BOT_STATE_PATH);
  logger.debug(`[System] Renamed tmp → ${BOT_STATE_PATH}`);

  // Шаг 4: read-back верификация — убеждаемся, что ФС приняла данные
  const readBack = await readFile(BOT_STATE_PATH, 'utf-8');
  JSON.parse(readBack); // бросит SyntaxError если файл повреждён

  const posLabel = activePosition ? `#${activePosition.coin}` : 'no position';
  logger.info(
    `[System] ✅ State saved — ${BOT_STATE_PATH} | ${json.length} bytes | ${posLabel} | reason: ${reason}`,
  );

  return state;
}

/**
 * PRODUCTION: убедиться, что на бирже выставлены защитные ордера.
 * Пока что — заглушка для будущей интеграции с Hyperliquid SDK.
 */
async function ensureExchangeProtection(activePosition) {
  if (!config.isProduction || !activePosition) return;

  // TODO: интеграция с Hyperliquid SDK
  //   1. Выставить Hard Stop-Loss на entry_price * 0.90 (10% просадка)
  //   2. Проверить, что ордер принят
  //   3. Логировать order_id
  logger.warn(
    `[System] ⚠️ PRODUCTION shutdown with open position #${activePosition.coin} — ` +
    `ensure hard SL/TP orders exist on exchange (SDK integration pending)`,
  );
}

/**
 * Ожидает завершения текущего тика (если запущен).
 * Возвращает true если дождались, false по таймауту.
 */
function waitForTick(timeoutMs = 10_000) {
  if (!tickRunning) return Promise.resolve(true);

  logger.info('[System] Waiting for current tick to finish…');

  return new Promise((resolve) => {
    const start   = Date.now();
    const check   = setInterval(() => {
      if (!tickRunning) {
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
 * Отправляет Telegram-уведомление о завершении работы.
 */
async function sendShutdownNotification(activePosition, reason) {
  const uptimeMin = ((Date.now() - startedAt) / 60_000).toFixed(0);

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
    `⏱ Uptime: ${uptimeMin} мин\n` +
    `<code>─────────────────────</code>\n` +
    `${status}\n` +
    `<code>─────────────────────</code>\n` +
    `✅ Параметры сохранены.`,
    true, // critical — всегда со звуком
  );
}

async function shutdown(signal) {
  // ── Защита от двойного вызова ─────────────────
  if (shuttingDown) {
    logger.warn(`[System] ${signal} received again — shutdown already in progress`);
    return;
  }
  shuttingDown = true;
  const t0 = Date.now();

  logger.info('───────────────────────────────────────────────');
  logger.info(`[System] ${signal} — graceful shutdown BEGIN`);
  logger.info('───────────────────────────────────────────────');

  // ── [1/6] Остановить тик-лупу ────────────────
  logger.info('[System] [1/6] Stopping tick loop…');
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  logger.info('[System] [1/6] ✅ Tick loop stopped');

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

  if (db) {
    try {
      db.close();
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

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(`  HL Paper Scanner v2.0`);
  logger.info(`  Mode:   ${config.mode}`);
  logger.info(`  Wallet: ${config.wallet.address}`);
  logger.info(`  Entry:  ≥ ${config.trading.entryApy}% APY`);
  logger.info(`  Exit:   < ${config.trading.minApy}% APY`);
  logger.info('═══════════════════════════════════════════════');

  db = initDB();

  // Синхронизация состояния до первого тика
  await syncWithExchange();

  await tick();

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  const handleSignal = (signal) => {
    // Жёсткий таймаут — если graceful shutdown завис, убиваем процесс
    setTimeout(() => {
      logger.error('[System] Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    shutdown(signal).catch((err) => {
      logger.error(`[System] Shutdown error: ${err.message}`);
      process.exit(1);
    });
  };

  process.on('SIGINT',  () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

main().catch((err) => {
  logger.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
