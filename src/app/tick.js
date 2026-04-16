// ─────────────────────────────────────────────────
//  Tick — главный цикл бота
// ─────────────────────────────────────────────────

import { logger } from '../core/logger.js';
import { getActivePosition } from '../core/database.js';
import { scan } from '../modules/scout.js';
import { coordinate } from '../modules/coordinator.js';
import { execute } from '../modules/executor/index.js';
import { runSmartAlerts } from './alerts.js';
import { integrityCheck } from './integrity.js';
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

    const scoutData = await scan();

    if (scoutData.length === 0) {
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

    const signal = coordinate(scoutData, activePosition);

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
