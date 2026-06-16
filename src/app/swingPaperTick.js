// ─────────────────────────────────────────────────
//  Setup Swing paper — shadow paper-слот
// ─────────────────────────────────────────────────
// Зеркало vaporPaperTick.js. Независимый paper-слот (strategy_id='swing'), не
// занимает реальный single-slot. PROD-пути нет — всегда виртуально, гейт только
// SWING_PAPER_ENABLED. Сигнал/SL/TP считает analyzeSwing по тому же вердикту +
// плану входа, что рисует карточка Setup Scanner · Swing.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeSwing } from '../modules/strategistSwing.js';
import { execute } from '../modules/executor/index.js';

export async function tickSwingPaper(hunterData) {
  if (!config.trading.swingPaperEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('swing');
  const signal = analyzeSwing(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[SwingPaper] OPEN ${signal.coin} ${signal.direction}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'swing') {
    logger.debug(`[SwingPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
