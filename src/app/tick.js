// ─────────────────────────────────────────────────
//  Tick — главный цикл бота
// ─────────────────────────────────────────────────

import { logger } from '../core/logger.js';
import { getActivePosition, getActiveAdoptPositions } from '../core/database.js';
import { scan } from '../modules/scout.js';
import { coordinate } from '../modules/coordinator.js';
import { config } from '../core/config.js';
import { scanCandyGirlRadar } from '../modules/strategistCandyGirl.js';
import { execute } from '../modules/executor/index.js';
import { runSmartAlerts } from './alerts.js';
import { integrityCheck, orphanCheck } from './integrity.js';
import { superviseAdoptPositions } from './adoptSupervise.js';
import { superviseManualPaperPositions } from './manualPaperSupervise.js';
import { hunterReconcile } from './hunterReconcile.js';
import { hunterLongReconcile } from './hunterLongReconcile.js';
import { processHunterTrailArm } from './hunterTrailArm.js';
import { tickHunterPaper } from './hunterPaperTick.js';
import { tickHunterOiPaper } from './hunterOiPaperTick.js';
import { tickVaporPaper } from './vaporPaperTick.js';
import { tickHotMoversPaper } from './hotMoversPaperTick.js';
import { tickSwingPaper } from './swingPaperTick.js';
import { tickFadeHotPaper } from './fadeHotPaperTick.js';
import { tickHunterLongPaper } from './hunterLongPaperTick.js';
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
      // Дашборд (Hot Movers / Hunter signals) должен продолжать обновляться,
      // даже когда бот в HANDS-OFF. Делаем чистый scan без coordinate/execute.
      try {
        const { hunterData: handsOffHunter } = await scan();
        state.latestHunter   = handsOffHunter;
        state.latestHunterAt = Date.now();
        // Candy Girl радар (signal-only, см. candy_girl_idea.md). Расцеплен от
        // слота — никогда не торгует, только лента + TG-алерты. Default OFF.
        if (config.trading.candyGirlEnabled) {
          // Candy Girl = radar-only (5m-сигналы кормят Setup Scanner · Swing).
          // Paper-стратегия удалена 2026-06-15 (−$26 на 121 сделке, см. ledger).
          await scanCandyGirlRadar(handsOffHunter);
        }
        // Paper shadow-слоты независимы от реального слота — должны тикать даже
        // в HANDS-OFF, иначе зависшая ручная PROD-поза подвешивает paper-позицию
        // навсегда (инцидент BTC id=90 + PURR HANDS-OFF, 2026-05-22/23).
        // Hunter SHORT/Long shadow paper-слоты (Этап 2): независимы от
        // реального слота, копят статистику даже в HANDS-OFF.
        await tickHunterPaper(handsOffHunter);
        await tickHunterOiPaper(handsOffHunter);
        await tickHunterLongPaper(handsOffHunter);
        await tickVaporPaper(handsOffHunter);
        await tickHotMoversPaper(handsOffHunter);
        await tickSwingPaper(handsOffHunter);
        await tickFadeHotPaper(handsOffHunter);
        // Equity-снапшот для Performance-графика. Ручная торговля — основной
        // режим оператора (часами держит монету руками), и тик тут делает return
        // ДО runBalanceDiag() в конце. Без этого Performance молчит весь
        // HANDS-OFF и схлопывается в одну «живую» точку (2026-06-09).
        await runBalanceDiag();
      } catch (err) {
        logger.debug(`[Tick] HANDS-OFF scan/paper failed: ${err.message}`);
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

    // Candy Girl радар (signal-only). У него нет coordinator-пути (он не торгует),
    // поэтому сканируем здесь напрямую. Никогда не открывает позицию. Default OFF.
    if (config.trading.candyGirlEnabled) {
      try {
        // Candy Girl = radar-only (5m-сигналы для Setup Scanner · Swing).
        // Paper-стратегия удалена 2026-06-15 (убыточная, см. ledger).
        await scanCandyGirlRadar(scoutData);
      } catch (err) {
        logger.debug(`[Tick] Candy Girl radar failed: ${err.message}`);
      }
    }

    const activePosition = getActivePosition();

    // Трекинг IDLE-состояния (для auto-cleanup)
    if (!activePosition && state.lastIdleAt === 0) {
      state.lastIdleAt = Date.now();
    } else if (activePosition) {
      state.lastIdleAt = 0;
    }

    // Монеты, в которых оператор уже сидит руками (усыновлённые adopt-позы) — бот не
    // должен открывать на них вторую позу: на одном кошельке HL встречный ордер
    // неттит твою позу, одинаковый — двоит риск (incident WLD 2026-06-16, Hunter
    // зашортил поверх живого adopt-шорта). Неусыновлённые ручные позы и так пускают
    // бот в HANDS-OFF (return выше), так что здесь достаточно adopt-коинов.
    const ownedCoins = new Set(
      getActiveAdoptPositions()
        .map((p) => (p.coin || '').toUpperCase())
        .filter(Boolean),
    );

    const signal = await coordinate(scoutData, activePosition, hunterData, ownedCoins);

    // Iter D2: если checkHunterExit (внутри coordinate→analyzeHunter) выставил
    // ARM request — выполняем cancel TP-trigger ДО execute(). Это гарантирует,
    // что к моменту close (если signal=hunter_trail_tp) executor не будет
    // дважды дёргать cancel.
    await processHunterTrailArm(activePosition);

    if (signal.action !== 'HOLD') {
      await execute(signal, activePosition);
    }

    // Hunter SHORT/Long + Carry shadow paper-слоты (Этап 2): каждая копит
    // статистику в своём независимом paper-слоте, пока её PROD-гейт выключен.
    // Hunter SHORT live (HUNTER_PROD_ENABLED=true) → tickHunterPaper сам no-op.
    await tickHunterPaper(hunterData);
    await tickHunterOiPaper(hunterData);
    await tickHunterLongPaper(hunterData);
    await tickVaporPaper(hunterData);
    await tickHotMoversPaper(hunterData);
    await tickSwingPaper(hunterData);
    await tickFadeHotPaper(hunterData);

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
