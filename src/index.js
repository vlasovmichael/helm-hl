// ─────────────────────────────────────────────────
//  HL Trading Bot — entry point
// ─────────────────────────────────────────────────

import cron from 'node-cron';
import { config } from './core/config.js';
import { fireNtfy } from './core/ntfy.js';
import { logger } from './core/logger.js';
import { probeAlloc, recordAlloc } from './app/allocProbe.js';
import { initDB, getActivePosition, runDbMaintenance, compactHistoryArchive } from './core/database.js';
import { initExchange, getAccountSummary } from './modules/exchange.js';
import { getAccountEquity } from './modules/wallet.js';
import { syncWithExchange } from './modules/sync.js';
import { startDashboard } from './modules/dashboard/server.js';
import { dailyJob as taxDailyJob } from './modules/taxCollector/index.js';
import { drainOutbox as taxDrainOutbox } from './modules/taxCollector/pusher.js';
import { state, TICK_INTERVAL_MS, INTEGRITY_GRACE_PERIOD_MS, SHUTDOWN_TIMEOUT_MS } from './app/state.js';
import { tick } from './app/tick.js';
import { reportRestartIfUnclean } from './app/restartWatch.js';
import { startPriceFeed } from './core/priceFeed.js';
import { startHealthWatch } from './app/healthWatch.js';
import { startFillFeed } from './core/fillFeed.js';
import { startWsExitLoop } from './app/wsExitTick.js';
import { startTickWatchdog } from './app/tickWatchdog.js';
import { startMemWatch } from './app/memWatch.js';
import { startWatchlistAlerts } from './modules/watchlistAlerts.js';
import { startWinnersWatch } from './modules/winnersWatch.js';
import { sendDailyDigest } from './modules/mailDigest.js';
import { shutdown } from './app/lifecycle.js';
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

  // ── Наблюдатель здоровья данных ────────────────
  // Плашка в шапке дашборда молчалива по природе: она видна, только пока на неё
  // смотрят. Этот наблюдатель звонит в ntfy, когда состояние держится плохим
  // несколько минут подряд. Ничего не считает сам — читает healthRegistry.
  startHealthWatch();

  // ── WS-фид собственных филлов ──────────────────
  // Бот узнаёт о своей сделке в момент исполнения, а не следующим опросом:
  // сбрасываем интервальный гард Integrity (иначе сверка ждала бы до 60с) и
  // будим тик. tick() сам защищён флагом state.tickRunning, поэтому гонки с
  // обычным циклом нет. Опрос остаётся страховкой на случай обрыва WS.
  // Fail-soft: ошибки фида не валят бота.
  startFillFeed({
    onFill: () => {
      state.lastIntegrityCheck = 0;
      tick().catch((err) => logger.warn(`[FillFeed] тик после филла упал: ${err.message}`));
    },
  });

  // Watchlist-будильник: «моя монета (BTC/HYPE/SOL) задвигалась + OI подтверждает».
  // Узкий пуш только по ALERT_WATCHLIST, не сделка. WATCHLIST_ALERT_ENABLED (default on). Fail-soft.
  startWatchlistAlerts();

  // «Гении Уолл-стрит» открыли/закрыли позу → холодный пуш + колокольчик.
  // Наблюдение за замороженным списком, вердикт теста 10.11 не трогает.
  // WINNERS_WATCH_ENABLED (default on). Fail-soft.
  startWinnersWatch();

  // ── Ежедневный почтовый дайджест — 21:05 (Europe/Warsaw), после Daily Recap ──
  // Отчёт за сутки (пуши + сводка стратегий) на self-hosted Listmonk. Fail-soft:
  // тихо no-op, если почта (LISTMONK_*/MAIL_TO) не настроена.
  cron.schedule(
    '5 21 * * *',
    () => {
      probeAlloc('cron:mailDigest', sendDailyDigest).catch((err) => {
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
      probeAlloc('cron:tax', taxDailyJob).catch((err) => {
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
    probeAlloc('cron:taxOutbox', taxDrainOutbox).catch((err) => {
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
      const dbT0 = Date.now();
      const dbH0 = process.memoryUsage().heapUsed;
      try {
        const isWeekly = new Date().getDay() === 0; // воскресенье → VACUUM
        const res = runDbMaintenance({ vacuum: isWeekly });
        compactHistoryArchive();
        recordAlloc('cron:dbMaintenance', {
          ms: Date.now() - dbT0,
          heapDelta: process.memoryUsage().heapUsed - dbH0,
        });
        if (!res.ok) {
          // Риск-алерт: битая БД — это потерянные позиции и неверный учёт.
          fireNtfy({
            title: '🚨 DB integrity_check FAILED',
            message: String(res.integrity),
            tags: ['rotating_light'],
            urgent: true,
          }).catch(() => {});
        }
      } catch (err) {
        logger.error(`[System] DB maintenance crashed: ${err.message}`);
        fireNtfy({
          title: '🚨 DB maintenance crashed',
          message: err.message,
          tags: ['rotating_light'],
          urgent: true,
        }).catch(() => {});
      }
    },
    { timezone: 'Europe/Warsaw' },
  );
  logger.info('[System] DB maintenance cron scheduled: 04:00 Europe/Warsaw daily (VACUUM weekly Sun)');

  // Grace period для integrityCheck
  state.botStartedAt = Date.now();
  logger.info(
    `[System] Integrity check grace period: ${INTEGRITY_GRACE_PERIOD_MS / 1000}s`,
  );

  await tick();

  state.tickTimer = setInterval(tick, TICK_INTERVAL_MS);

  // ── WS-tick exits ──────────────────────────────
  // Ведёт adopt/manual_paper позы на живых WS-ценах между 15-сек тиками:
  // сопровождение ручной позы не должно зависеть от здоровья сканера.
  startWsExitLoop();

  // ── Сторож тика ────────────────────────────────
  // Тик может встать тихо (затор весового бюджета) — тогда всё, что живёт
  // внутри него, замирает без единого сигнала. Это его рот.
  startTickWatchdog();

  // ── Наблюдение за памятью ──────────────────────
  // OOM-kill по лимиту cgroup убивал процесс молча (02.08, дважды за двое
  // суток). Даёт кривую RSS для «утечка или кэш» и пуш до потолка, а не после.
  startMemWatch();

  // ── Голос у самого рестарта ────────────────────
  // [Mem] предупреждает до упора, сторож ловит замерший тик — но мгновенная
  // смерть с подъёмом за 25мс не даёт ни того, ни другого. Это сигнал по факту.
  try {
    await reportRestartIfUnclean();
  } catch (err) {
    logger.warn(`[RestartWatch] старт-проверка не прошла (non-fatal): ${err.message}`);
  }

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
