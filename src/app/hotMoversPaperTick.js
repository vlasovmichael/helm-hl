// ─────────────────────────────────────────────────
//  Hot Movers paper — shadow paper-слот
// ─────────────────────────────────────────────────
// Зеркало vaporPaperTick.js. Независимый paper-слот (strategy_id='hotmovers'),
// не занимает реальный single-slot. PROD-пути нет — всегда виртуально, гейт
// только HOT_MOVERS_PAPER_ENABLED. Сигнал/SL/TP считает analyzeHotMovers по
// тому же вердикту, что рисует карточка Hot Movers.
//
// analyzeHotMovers async (как ntfy-воркер: для fade-сетапов лениво тянет
// 1h-тренд из dashboard/routes/movers.js) — поэтому await.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeHotMovers } from '../modules/strategistHotMovers.js';
import { execute } from '../modules/executor/index.js';

export async function tickHotMoversPaper(hunterData) {
  if (!config.trading.hotMoversPaperEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('hotmovers');
  const signal = await analyzeHotMovers(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[HotMoversPaper] OPEN ${signal.coin} ${signal.direction}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'hotmovers') {
    logger.debug(`[HotMoversPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
