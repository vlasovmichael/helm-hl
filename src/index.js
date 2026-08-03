// ─────────────────────────────────────────────────
//  HL Trading Bot — entry point
// ─────────────────────────────────────────────────

import cron from 'node-cron';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { initDB, getActivePosition, runDbMaintenance, compactHistoryArchive } from './core/database.js';
import { initExchange, getAccountSummary } from './modules/exchange.js';
import { getAccountEquity } from './modules/wallet.js';
import { sendStartupNotification, setStatusCollector, startCallbackPolling, sendMessage } from './modules/reporter.js';
import { syncWithExchange } from './modules/sync.js';
import { startDashboard } from './modules/dashboard/server.js';
import { dailyJob as taxDailyJob } from './modules/taxCollector/index.js';
import { drainOutbox as taxDrainOutbox } from './modules/taxCollector/pusher.js';
import { state, TICK_INTERVAL_MS, INTEGRITY_GRACE_PERIOD_MS, SHUTDOWN_TIMEOUT_MS } from './app/state.js';
import { tick } from './app/tick.js';
import { restoreHunterTrailIfNeeded } from './app/hunterTrailArm.js';
import { startPriceFeed } from './core/priceFeed.js';
import { startWsExitLoop } from './app/wsExitTick.js';
import { startWsEntryLoop } from './app/wsEntryTick.js';
import { startTickWatchdog } from './app/tickWatchdog.js';
import { startMemWatch } from './app/memWatch.js';
import { startSetupSwingAlerts } from './modules/setupScannerAlerts.js';
import { startHotMoversAlerts } from './modules/hotMoversAlerts.js';
import { startFadeHotAlerts } from './modules/fadeHotAlerts.js';
import { startWatchlistAlerts } from './modules/watchlistAlerts.js';
import { sendDailyDigest } from './modules/mailDigest.js';
import { captureSnapshot, listSnapshots } from '../tools/leaderboardSnapshot.mjs';
import { shutdown } from './app/lifecycle.js';
import { createStatusCollector } from './app/status.js';
import { startToastBridge } from './app/toastBridge.js';
import { startEquityHeal } from './app/equityHeal.js';

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

  // ── Toast bridge: open/close/flush → тост на дашборде (без телефона) ──
  // Подписка на afterOpen/afterClose (PRODUCTION) + breadth-flush → колокольчик и
  // тост по WS через recordNotification. ntfy/почта не трогаются. Fail-soft.
  startToastBridge();

  // ── Equity heal: дотягивает провалы Performance-истории из HL (раз в 6ч) ──
  // Локальные 5-мин снапшоты остаются основными; HL лишь заполняет дыры, если
  // снапшоты когда-нибудь встанут. LOW-приоритет, fail-soft.
  startEquityHeal();

  // ── WS price feed (Stage 1: shadow) ────────────
  // Gated на HL_WS_FEED_ENABLED. Поднимает allMids-фид + сверяет с поллингом,
  // торговую логику не трогает. Fail-soft: ошибки WS не валят бота.
  startPriceFeed();

  // ── Setup Scanner Swing — entry/exit ntfy-алерты ──
  // Контекст-пуши для ручной торговли (вход в зону / контекст против позиции).
  // Не торгует. Gated на SETUP_SWING_ALERT_ENABLED (default on). Fail-soft.
  startSetupSwingAlerts();

  // Пуш «мувер стал enterable»: направленный Setup перешёл в чейз-зону 🎯
  // (улетел → откатился). Не торгует. Gated на HOT_MOVERS_ALERT_ENABLED. Fail-soft.
  startHotMoversAlerts();

  // Fade-high-ER feed: ВСЕ гейтованные fade-сетапы (выдохшийся хвост в горячем рынке)
  // в ntfy — премиум-сигналы, не сделки. Независим от paper-слота. FADEHOT_ALERT_FEED_ENABLED.
  startFadeHotAlerts();

  // Watchlist-будильник: «моя монета (BTC/HYPE/SOL) задвигалась + OI подтверждает».
  // Узкий пуш только по ALERT_WATCHLIST, не сделка. WATCHLIST_ALERT_ENABLED (default on). Fail-soft.
  startWatchlistAlerts();

  // ── Ежедневный почтовый дайджест — 21:05 (Europe/Warsaw), после Daily Recap ──
  // Отчёт за сутки (пуши + сводка стратегий) на self-hosted Listmonk. Fail-soft:
  // тихо no-op, если почта (LISTMONK_*/MAIL_TO) не настроена.
  cron.schedule(
    '5 21 * * *',
    () => {
      sendDailyDigest().catch((err) => {
        logger.warn(`[mailDigest] cron crashed: ${err.message}`);
      });
    },
    { timezone: 'Europe/Warsaw' },
  );
  logger.info('[System] Mail digest cron scheduled: 21:05 Europe/Warsaw daily');

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

  // ── DB maintenance — ежедневно 04:00 (перед borg-бэкапом 04:30) ──
  // checkpoint WAL + integrity + optimize + сжатие архива. VACUUM по воскресеньям
  // (возврат страниц от ретеншена setup_snapshots / архивации). integrity-фейл →
  // критический риск-алерт в TG (см. feedback: риск-алерты всегда звучат).
  cron.schedule(
    '0 4 * * *',
    () => {
      try {
        const isWeekly = new Date().getDay() === 0; // воскресенье → VACUUM
        const res = runDbMaintenance({ vacuum: isWeekly });
        compactHistoryArchive();
        if (!res.ok) {
          sendMessage(
            `🚨 DB integrity_check FAILED:\n<code>${res.integrity}</code>`,
            true,
          ).catch(() => {});
        }
      } catch (err) {
        logger.error(`[System] DB maintenance crashed: ${err.message}`);
        sendMessage(`🚨 DB maintenance crashed: ${err.message}`, true).catch(() => {});
      }
    },
    { timezone: 'Europe/Warsaw' },
  );
  logger.info('[System] DB maintenance cron scheduled: 04:00 Europe/Warsaw daily (VACUUM weekly Sun)');

  // ── Снимок лидерборда HL — понедельник 05:00 (Europe/Warsaw) ──
  // Обычный GET на stats-data, НЕ /info: весового бюджета HL-пула не трогает.
  // HL отдаёт только текущий срез — историю никак; копим сами, иначе форвардный
  // тест персистентности построить не из чего (2026-08-03).
  const captureLeaderboard = async (why) => {
    try {
      const r = await captureSnapshot();
      if (r.ok) logger.info(`[Leaderboard] ${why}: ${r.rows} rows → ${r.file} (${(r.bytes / 1e6).toFixed(2)} MB)`);
      else logger.warn(`[Leaderboard] ${why} failed: ${r.reason}`);
    } catch (err) {
      logger.warn(`[Leaderboard] ${why} crashed: ${err.message}`);
    }
  };
  cron.schedule('0 5 * * 1', () => captureLeaderboard('weekly'), { timezone: 'Europe/Warsaw' });
  logger.info('[System] Leaderboard snapshot cron scheduled: 05:00 Europe/Warsaw, Mondays');

  // Самолечение: если свежего снимка нет (первый деплой / контейнер лежал в
  // понедельник) — доснять на старте. Иначе в архиве молча образуется дыра.
  try {
    const snaps = listSnapshots();
    const lastMs = snaps.length ? Date.parse(snaps[snaps.length - 1].date) : 0;
    if (Date.now() - lastMs > 6 * 864e5) captureLeaderboard('startup backfill');
  } catch (err) {
    logger.warn(`[Leaderboard] startup check failed: ${err.message}`);
  }

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

  // ── WS-tick exits (Stage 2) ────────────────────
  // Считает выходы активной hunter/hunter_long позиции на живых WS-ценах между
  // 15-сек тиками. Gated на HL_WS_EXITS_ENABLED, делит mutex с tick().
  startWsExitLoop();

  // ── WS-tick entries (Stage 3) ──────────────────
  // Открывает hunter/hunter_long быстрее 15-сек скана. Gated на
  // HL_WS_ENTRIES_ENABLED (default OFF, меняет частоту входов), mutex с tick().
  startWsEntryLoop();

  // ── Сторож тика ────────────────────────────────
  // Тик может встать тихо (затор весового бюджета 2026-07-31) — тогда всё, что
  // живёт внутри него, замирает без единого сигнала. Это его рот.
  startTickWatchdog();

  // ── Наблюдение за памятью ──────────────────────
  // OOM-kill по лимиту cgroup убивал процесс молча (02.08, дважды за двое
  // суток). Даёт кривую RSS для «утечка или кэш» и пуш до потолка, а не после.
  startMemWatch();

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
