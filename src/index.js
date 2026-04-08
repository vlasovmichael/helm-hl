import { writeFile, readFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { initDB, getActivePosition, getHistory, getHistorySince } from './core/database.js';
import { scan } from './modules/scout.js';
import { analyze } from './modules/strategist.js';
import { execute } from './modules/executor.js';
import {
  sendMessage,
  sendAnomalyAlert,
  sendFomoAlert,
  sendDailySummary,
  sendPnlAlert,
  sendStartupNotification,
  setStatusCollector,
  startCallbackPolling,
  stopCallbackPolling,
} from './modules/reporter.js';
import { syncWithExchange } from './modules/sync.js';
import { initExchange, disconnectExchange, getBalance as getExchangeBalance, getAccountSummary, getMarkPrice } from './modules/exchange.js';
import { getAvailableBalance } from './modules/wallet.js';

const TICK_INTERVAL_MS    = 15_000;          // 15 секунд
const FOMO_COOLDOWN_MS    = 4 * 3_600_000;   // не чаще 1 раза в 4 часа
const ANOMALY_THRESHOLD   = 0.30;            // 30% падение APY за тик → аномалия
const FOMO_UPLIFT_MIN     = 1.50;            // лучший кандидат должен быть на 50% выше

// Daily Recap: отправляется в этот час (21:00 по серверу)
const DAILY_RECAP_HOUR    = 21;

// PnL Alert: порог unrealized PnL (±3% от equity)
const PNL_ALERT_PCT       = 3.0;
const PNL_ALERT_COOLDOWN_MS = 60 * 60_000;   // не чаще 1 раза в час

const BOT_STATE_PATH = 'data/bot_state.json';
const SHUTDOWN_TIMEOUT_MS = 15_000;           // максимум 15с на завершение

let db;
let tickTimer;
let tickRunning      = false;
let shuttingDown     = false;                 // защита от двойного SIGINT
let startedAt        = Date.now();
let dailyRecapSentDate = '';                 // "YYYY-MM-DD" — защита от повторной отправки
let lastFomoAlert    = 0;                    // UNIX ms последнего FOMO-алерта
let lastPnlAlert     = 0;                    // UNIX ms последнего PnL-алерта
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
      const ROUND_TRIP   = (0.0002 + 0.0001) * 2;
      const deltaHourly  = (best.smoothedApy - current.smoothedApy) / 100 / 365 / 24;
      const paybackHours = deltaHourly > 0 ? ROUND_TRIP / (0.5 * deltaHourly) : Infinity;

      if (paybackHours > 6) {
        await sendFomoAlert(currentCoin, best.coin, current.smoothedApy, best.smoothedApy, paybackHours);
        lastFomoAlert = now;
      }
    }
  }

  // ── 3. PnL Alert (unrealized PnL > ±3% от equity) ────────────────
  if (activePosition && now - lastPnlAlert >= PNL_ALERT_COOLDOWN_MS) {
    try {
      const markPrice = await getMarkPrice(activePosition.coin);
      if (markPrice != null) {
        const qty           = activePosition.size_usd / activePosition.entry_price;
        const unrealizedPnl = (activePosition.entry_price - markPrice) * qty;

        // Получаем equity для расчёта процента
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
          lastPnlAlert = now;
        }
      }
    } catch (err) {
      logger.debug(`[Tick] PnL alert check failed: ${err.message}`);
    }
  }

  // ── 4. Daily Recap (в 21:00 по серверу) ──────────────────────────
  await checkDailyRecap();
}

/**
 * Daily Recap — отправляется один раз в день в DAILY_RECAP_HOUR.
 * Только если за сутки была хотя бы одна закрытая сделка.
 */
async function checkDailyRecap() {
  const now  = new Date();
  const hour = now.getHours();

  // Только в нужный час
  if (hour !== DAILY_RECAP_HOUR) return;

  // Защита от повторной отправки в том же дне
  const today = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  if (dailyRecapSentDate === today) return;

  // Начало текущего дня (00:00:00 по серверу)
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const todayHistory = getHistorySince(dayStart);

  if (todayHistory.length === 0) {
    logger.info('[System] Daily Recap skipped — no trades today');
    dailyRecapSentDate = today;
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

  // Получаем текущий баланс для отчёта
  let equity = 0;
  try {
    if (config.isProduction) {
      const summary = await getAccountSummary();
      equity = summary.equity;
    } else {
      equity = await getAvailableBalance();
    }
  } catch { /* покажем $0 */ }

  await sendDailySummary({
    totalTrades, winTrades, totalPnl, totalFees,
    bestTrade, activePosition, equity,
  });

  dailyRecapSentDate = today;
  logger.info(`[System] Daily Recap sent for ${today}`);
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
    // critical=false: штатная остановка, тишина ночью
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

  // ── [1/6] Остановить тик-лупу + polling ──────
  logger.info('[System] [1/6] Stopping tick loop & polling…');
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  stopCallbackPolling();
  logger.info('[System] [1/6] ✅ Tick loop & polling stopped');

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

  // Отключаем SDK (если PRODUCTION)
  try {
    await disconnectExchange();
  } catch (err) {
    logger.error(`[System] ❌ Exchange disconnect error: ${err.message}`);
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

  // PRODUCTION: подключаемся к бирже через SDK
  await initExchange();

  // Синхронизация состояния до первого тика
  await syncWithExchange();

  // ── Startup notification ──────────────────────
  const activePos = getActivePosition();
  let startupBalance = 0;
  try {
    startupBalance = config.isProduction
      ? await getExchangeBalance()
      : await getAvailableBalance();
  } catch {
    // не критично — покажем $0
  }

  await sendStartupNotification({
    balance:        startupBalance,
    activePosition: activePos,
  });

  // ── Status collector (для кнопки "📊 Статус") ──
  setStatusCollector(async () => {
    const position = getActivePosition();
    const history  = getHistory(1000);

    // Баланс: equity + available
    let equity = 0, available = 0;
    try {
      if (config.isProduction) {
        const summary = await getAccountSummary();
        equity        = summary.equity;
        available     = summary.available;
      } else {
        available = await getAvailableBalance();
        equity    = available; // PAPER: equity = available
      }
    } catch {
      // покажем $0
    }

    // Динамический Unrealized PnL: запрашиваем Mark Price и считаем
    // Формула для шорта: (entry_price - mark_price) * qty
    let unrealizedPnl = 0;
    let markPrice = null;
    if (position) {
      try {
        markPrice = await getMarkPrice(position.coin);
        if (markPrice != null) {
          const qty = position.size_usd / position.entry_price;
          unrealizedPnl = (position.entry_price - markPrice) * qty;
        }
      } catch {
        // не критично — покажем 0
      }
    }

    const realizedPnl = history.reduce((s, t) => s + t.realized_pnl, 0);

    return {
      equity,
      available,
      unrealizedPnl,
      markPrice,
      activePosition:  position,
      uptimeMin:       Math.round((Date.now() - startedAt) / 60_000),
      closedTrades:    history.length,
      openTrades:      position ? 1 : 0,
      realizedPnl,
    };
  });

  // ── Запуск callback polling для inline-кнопок ──
  startCallbackPolling();

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

// ── Страховка: ловим всё, что проскочило мимо try/catch ──
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`[UnhandledRejection] ${msg}`);
  // НЕ крашим процесс — логируем и продолжаем работу
});

process.on('uncaughtException', (err) => {
  logger.error(`[UncaughtException] ${err.message}`, { stack: err.stack });
  // Тут ситуация серьёзнее — состояние процесса может быть повреждено.
  // Пытаемся graceful shutdown, если ещё не запущен.
  if (!shuttingDown) {
    shutdown('uncaughtException').catch(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

main().catch((err) => {
  logger.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
