// ─────────────────────────────────────────────────
//  Tick — главный цикл бота
// ─────────────────────────────────────────────────

import { logger } from '../core/logger.js';
import { getActivePosition } from '../core/database.js';
import { scan } from '../modules/scout.js';
import { config } from '../core/config.js';
import { runDailyMaintenance } from './alerts.js';
import { integrityCheck, orphanCheck } from './integrity.js';
import { superviseAdoptPositions } from './adoptSupervise.js';
import { superviseManualPaperPositions } from './manualPaperSupervise.js';
import { runBalanceDiag } from './balanceDiag.js';
import { flushBotStatePeriodic } from './lifecycle.js';
import { state } from './state.js';
import { refreshDailyRisk } from '../modules/dailyRisk.js';
import { fireAdoptNtfy } from './adoptReconcile.js';
import { sweepCandleCaches } from '../modules/candleCache.js';
import { probeAlloc } from './allocProbe.js';

export async function tick() {
  if (state.tickRunning || state.shuttingDown) return;
  // Замер кучи за тик — после гардов, иначе холостые вызовы из WS-петель
  // забили бы кольцевой буфер пустыми записями. См. src/app/allocProbe.js.
  return probeAlloc('tick', tickBody);
}

async function tickBody() {
  state.tickRunning = true;
  state.tickRunningSince = Date.now();

  try {
    // ── Дневной стоп-лосс (rail, не замок): net дня по fills ≤ −лимит →
    // urgent-алерт (1/день) + ниже гейтим новые авто-входы (OPEN → HOLD).
    // Выходы/сопровождение/нянька работают как обычно. Fail-soft внутри.
    const dailyRisk = config.isProduction
      ? await refreshDailyRisk()
      : { halted: false, crossedNow: false };
    if (dailyRisk.crossedNow) {
      await fireAdoptNtfy(
        `🛑 Дневной стоп-лосс: ${dailyRisk.netUsd.toFixed(2)}$`,
        `День ушёл ниже −$${dailyRisk.limitUsd} (net по fills, fees $${dailyRisk.feesUsd.toFixed(2)}).\n` +
        `Новые авто-входы закрыты до полуночи. Открытые позы ведутся как обычно.\n` +
        `Лучшая сделка сейчас — закрыть терминал.`,
        ['octagonal_sign'],
        { urgent: true },
      );
    }

    // ── Integrity Check: детекция внешнего закрытия ──
    const externalClose = await integrityCheck();
    if (externalClose) {
      logger.info('[Tick] Skipping after external close detection');
      return;
    }

    // ── Manual Position Check: hands-off режим если оператор торгует вручную ──
    // (внутри orphanCheck при ADOPT_ENABLED подхватываются свежие ручные позы.)
    const manualState = await orphanCheck();

    // ── Adopt сопровождение (multi-slot) ──
    // Ведём ВСЕ подхваченные ручные позы (BE-храповик + трейл) каждый тик,
    // независимо от hands-off: даже если рядом висит неусыновлённая ручная поза
    // (→ manualState='paused'), уже усыновлённые должны продолжать вестись.
    await superviseAdoptPositions();

    // «Бумажный adopt»: ведём выход личных бумажных поз (manual_paper) той же
    // механикой. Независимо от hands-off и режима бота. Fail-soft внутри.
    await superviseManualPaperPositions();

    if (manualState === 'paused') {
      logger.debug('[Tick] HANDS-OFF: manual position active, scan-only refresh');
      // Витрины дашборда (Screen / OI) должны продолжать обновляться даже
      // когда бот в HANDS-OFF — делаем чистый scan.
      try {
        const { hunterData: handsOffHunter } = await scan();
        state.latestHunter   = handsOffHunter;
        state.latestHunterAt = Date.now();
        // Equity-снапшот для Performance-графика. Ручная торговля — основной
        // режим оператора (часами держит монету руками), и тик тут делает return
        // ДО runBalanceDiag() в конце. Без этого Performance молчит весь
        // HANDS-OFF и схлопывается в одну «живую» точку (2026-06-09).
        await runBalanceDiag();
      } catch (err) {
        logger.debug(`[Tick] HANDS-OFF scan failed: ${err.message}`);
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

    const activePosition = getActivePosition();

    // Трекинг IDLE-состояния (для auto-cleanup)
    if (!activePosition && state.lastIdleAt === 0) {
      state.lastIdleAt = Date.now();
    } else if (activePosition) {
      state.lastIdleAt = 0;
    }

    await runDailyMaintenance();

    // Балансовая диагностика (PROD-only, дросселирована до раз в 5 мин)
    await runBalanceDiag();

  } catch (err) {
    logger.error(`[Tick] ${err.message}`);
  } finally {
    state.tickRunning = false;
    state.lastTickAt = Date.now();
    // Вытеснение кэшей свечей — они росли без потолка и уронили процесс по
    // heap-limit 09.08 (см. шапку candleCache.js). Сама себя троттлит до раза в
    // 5 мин, поэтому живёт в finally: подметём даже если тик упал с ошибкой.
    try { sweepCandleCaches(); } catch (err) { logger.debug(`[CandleCache] sweep: ${err.message}`); }
    await flushBotStatePeriodic();
  }
}
