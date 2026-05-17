// ─────────────────────────────────────────────────
//  HL Trading Bot — entry point
// ─────────────────────────────────────────────────

import cron from 'node-cron';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { initDB, getActivePosition } from './core/database.js';
import { initExchange, getAccountSummary } from './modules/exchange.js';
import { getAccountEquity } from './modules/wallet.js';
import { sendStartupNotification, setStatusCollector, startCallbackPolling } from './modules/reporter.js';
import { syncWithExchange } from './modules/sync.js';
import { startDashboard } from './modules/dashboard/server.js';
import { dailyJob as taxDailyJob } from './modules/taxCollector/index.js';
import { drainOutbox as taxDrainOutbox } from './modules/taxCollector/pusher.js';
import { state, TICK_INTERVAL_MS, INTEGRITY_GRACE_PERIOD_MS, SHUTDOWN_TIMEOUT_MS } from './app/state.js';
import { tick } from './app/tick.js';
import { restoreHunterTrailIfNeeded } from './app/hunterTrailArm.js';
import { shutdown } from './app/lifecycle.js';
import { createStatusCollector } from './app/status.js';

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(`  HL Trading Bot v2.0`);
  logger.info(`  Mode:   ${config.mode}`);
  logger.info(`  Wallet: ${config.wallet.address}`);
  logger.info(`  Entry:  ≥ ${config.trading.entryApy}% APY`);
  logger.info(`  Exit:   < ${config.trading.minApy}% APY`);
  logger.info('═══════════════════════════════════════════════');

  state.db = initDB();

  // PRODUCTION: подключаемся к бирже через SDK
  await initExchange();

  // Синхронизация состояния до первого тика
  await syncWithExchange();

  // ── Baseline: session_start_equity ────────────
  const activePos = getActivePosition();
  let startupBalance = 0;
  try {
    if (config.isProduction) {
      const summary = await getAccountSummary();
      startupBalance = summary.equity;
    } else {
      startupBalance = await getAccountEquity();
    }
  } catch {
    // не критично — покажем $0
  }

  state.sessionStartEquity = startupBalance;
  if (!activePos) state.lastIdleAt = Date.now();
  logger.info(
    `[System] Session baseline equity: $${state.sessionStartEquity.toFixed(2)}`,
  );

  await sendStartupNotification({
    balance:        startupBalance,
    activePosition: activePos,
  });

  // ── Status collector (для кнопки "📊 Статус") ──
  setStatusCollector(createStatusCollector());

  // ── Запуск callback polling для inline-кнопок ──
  startCallbackPolling();

  // ── Web Dashboard (localhost:3000) ─────────────
  startDashboard();

  // ── Tax Collector — ежедневный сбор PIT-38 в 03:00 (Europe/Warsaw) ──
  // Fail-soft: модуль сам отключается, если BINANCE_API_KEY не задан.
  cron.schedule(
    '0 3 * * *',
    () => {
      taxDailyJob().catch((err) => {
        logger.error(`[Tax] Cron job crashed: ${err.message}`);
      });
    },
    { timezone: 'Europe/Warsaw' },
  );
  logger.info('[System] Tax collector cron scheduled: 03:00 Europe/Warsaw daily');

  // Разовый прогон при старте: после деплоя налоговые данные подтягиваются
  // сразу, не дожидаясь 03:00. Non-blocking + fail-soft.
  taxDailyJob().catch((err) => {
    logger.error(`[Tax] Startup run crashed: ${err.message}`);
  });

  // ── Tax Outbox pusher — каждые 15 минут ──
  // Драйнит tax_outbox в tax-manager. Fail-soft: если env не задан — skip.
  cron.schedule('*/15 * * * *', () => {
    taxDrainOutbox().catch((err) => {
      logger.error(`[TaxPusher] Cron crashed: ${err.message}`);
    });
  });
  logger.info('[System] Tax outbox pusher scheduled: every 15 min');

  // Grace period для integrityCheck
  state.botStartedAt = Date.now();
  logger.info(
    `[System] Integrity check grace period: ${INTEGRITY_GRACE_PERIOD_MS / 1000}s`,
  );

  // Hunter trail restore: если armed-at-shutdown — вернуть exchange TP-trigger.
  try {
    await restoreHunterTrailIfNeeded();
  } catch (err) {
    logger.warn(`[System] Hunter trail restore failed (non-fatal): ${err.message}`);
  }

  await tick();

  state.tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  const handleSignal = (signal) => {
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
});

process.on('uncaughtException', (err) => {
  logger.error(`[UncaughtException] ${err.message}`, { stack: err.stack });
  if (!state.shuttingDown) {
    shutdown('uncaughtException').catch(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

main().catch((err) => {
  logger.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
