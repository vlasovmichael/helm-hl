// ─────────────────────────────────────────────────
//  Tick — главный цикл бота
// ─────────────────────────────────────────────────

import { logger } from '../core/logger.js';
import { getActivePosition } from '../core/database.js';
import { scan } from '../modules/scout.js';
import { coordinate } from '../modules/coordinator.js';
import { execute } from '../modules/executor/index.js';
import { tickSniper } from '../modules/executor/sniper.js';
import { runSmartAlerts } from './alerts.js';
import { integrityCheck, orphanCheck } from './integrity.js';
import { hunterReconcile } from './hunterReconcile.js';
import { hunterLongReconcile } from './hunterLongReconcile.js';
import { processHunterTrailArm } from './hunterTrailArm.js';
import { tickTrendFollowPaper } from './trendFollowPaperTick.js';
import { runBalanceDiag } from './balanceDiag.js';
import { flushBotStatePeriodic } from './lifecycle.js';
import { state } from './state.js';

export async function tick() {
  if (state.tickRunning || state.shuttingDown) return;
  state.tickRunning = true;

  try {
    // ── Hunter Reconcile: SL/TP trigger fired on exchange? (Iter C) ──
    // Запускается ДО integrityCheck, чтобы штатно закрыть hunter-позицию с
    // правильным reason ('hunter_sl_external' / 'hunter_tp_external'),
    // не отдавая её на откуп generic 'external_close'.
    const hunterFired = await hunterReconcile();
    if (hunterFired) {
      logger.info('[Tick] Skipping after Hunter trigger fill detection');
      return;
    }

    // ── Hunter LONG Reconcile (Iter E.3): зеркало для hunter_long PROD-позиций ──
    const hunterLongFired = await hunterLongReconcile();
    if (hunterLongFired) {
      logger.info('[Tick] Skipping after Hunter LONG trigger fill detection');
      return;
    }

    // ── Integrity Check: детекция внешнего закрытия ──
    const externalClose = await integrityCheck();
    if (externalClose) {
      logger.info('[Tick] Skipping after external close detection');
      return;
    }

    // ── Manual Position Check: hands-off режим если оператор торгует вручную ──
    const manualState = await orphanCheck();
    if (manualState === 'paused') {
      logger.debug('[Tick] HANDS-OFF: manual position active, scan-only refresh');
      // Дашборд (Hot Movers / Hunter signals) должен продолжать обновляться,
      // даже когда бот в HANDS-OFF. Делаем чистый scan без coordinate/execute.
      try {
        const { hunterData: handsOffHunter } = await scan();
        state.latestHunter   = handsOffHunter;
        state.latestHunterAt = Date.now();
        // ChillBoy paper shadow-слот независим от реального слота — должен тикать
        // даже в HANDS-OFF, иначе зависшая ручная PROD-поза подвешивает paper
        // позицию навсегда (инцидент BTC id=90 + PURR HANDS-OFF, 2026-05-22/23).
        await tickTrendFollowPaper(handsOffHunter);
      } catch (err) {
        logger.debug(`[Tick] HANDS-OFF scan/chillboy failed: ${err.message}`);
      }
      return;
    }

    const { scoutData, hunterData } = await scan();

    state.latestHunter   = hunterData;
    state.latestHunterAt = Date.now();

    if (scoutData.length === 0 && hunterData.length === 0) {
      logger.info('[Tick] Scout returned empty data — skipping');
      return;
    }

    // Sniper (PAPER): попытка maker-fill / fallback-таймаут ДО coordinator'а,
    // чтобы если снайпер закрыл позицию этим тиком — координатор увидел IDLE
    // и мог сразу открыть новую сделку, не теряя тик.
    await tickSniper(scoutData);

    const activePosition = getActivePosition();

    // Трекинг IDLE-состояния (для auto-cleanup)
    if (!activePosition && state.lastIdleAt === 0) {
      state.lastIdleAt = Date.now();
    } else if (activePosition) {
      state.lastIdleAt = 0;
    }

    const signal = await coordinate(scoutData, activePosition, hunterData);

    // Iter D2: если checkHunterExit (внутри coordinate→analyzeHunter) выставил
    // ARM request — выполняем cancel TP-trigger ДО execute(). Это гарантирует,
    // что к моменту close (если signal=hunter_trail_tp) executor не будет
    // дважды дёргать cancel.
    await processHunterTrailArm(activePosition);

    if (signal.action !== 'HOLD') {
      await execute(signal, activePosition);
    }

    // ChillBoy (trend_follow) бумажный слот — независим от реального.
    await tickTrendFollowPaper(hunterData);

    await runSmartAlerts(scoutData, signal, activePosition);

    // Балансовая диагностика (PROD-only, дросселирована до раз в 5 мин)
    await runBalanceDiag();

  } catch (err) {
    logger.error(`[Tick] ${err.message}`);
  } finally {
    state.tickRunning = false;
    state.lastTickAt = Date.now();
    await flushBotStatePeriodic();
  }
}
