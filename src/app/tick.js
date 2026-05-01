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
import { state } from './state.js';

export async function tick() {
  if (state.tickRunning || state.shuttingDown) return;
  state.tickRunning = true;

  try {
    // ── Integrity Check: детекция внешнего закрытия ──
    const externalClose = await integrityCheck();
    if (externalClose) {
      logger.info('[Tick] Skipping after external close detection');
      return;
    }

    // ── Manual Position Check: hands-off режим если оператор торгует вручную ──
    const manualState = await orphanCheck();
    if (manualState === 'paused') {
      logger.debug('[Tick] HANDS-OFF: manual position active, skipping tick');
      return;
    }

    const { scoutData, hunterData } = await scan();

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

    const signal = coordinate(scoutData, activePosition, hunterData);

    if (signal.action !== 'HOLD') {
      await execute(signal, activePosition);
    }

    await runSmartAlerts(scoutData, signal, activePosition);

  } catch (err) {
    logger.error(`[Tick] ${err.message}`);
  } finally {
    state.tickRunning = false;
  }
}
