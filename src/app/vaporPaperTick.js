// ─────────────────────────────────────────────────
//  Vapor (Exhaustion Short, Трек A) — shadow paper-слот
// ─────────────────────────────────────────────────
// Зеркало hunterPaperTick.js. Независимый paper-слот (strategy_id='vapor'), не
// занимает реальный single-slot. PROD-пути нет — всегда виртуально, гейт только
// VAPOR_ENABLED. Сигнал/SL/TP считает analyzeVapor по hunterData.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeVapor } from '../modules/strategistVapor.js';
import { execute } from '../modules/executor/index.js';

export async function tickVaporPaper(hunterData) {
  if (!config.trading.vaporEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('vapor');
  const signal = analyzeVapor(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[VaporPaper] OPEN ${signal.coin}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'vapor') {
    logger.debug(`[VaporPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
