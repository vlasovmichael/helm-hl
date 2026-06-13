// ─────────────────────────────────────────────────
//  Hunter LONG — shadow paper-слот PROD-бота
// ─────────────────────────────────────────────────
// Зеркало hunterPaperTick.js / trendFollowPaperTick.js. Пока
// HUNTER_LONG_PROD_ENABLED=false, Hunter Long торгует виртуально в независимом
// paper-слоте (strategy_id='hunter_long'), собирая статистику отдельно от
// реального слота. SL/TP симулирует analyzeHunterLong по цене.
//
// Не работает в PAPER-боте (там идёт через coordinator) и при
// HUNTER_LONG_PROD_ENABLED=true (тогда конкурирует за реальный слот).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeHunterLong } from '../modules/strategistHunterLong.js';
import { execute } from '../modules/executor/index.js';

export async function tickHunterLongPaper(hunterData) {
  if (!config.isProduction) return;
  if (!config.trading.hunterLongEnabled || config.trading.hunterLongProdEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('hunter_long');
  const signal = analyzeHunterLong(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[HunterLongPaper] OPEN ${signal.coin}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'hunter_long') {
    logger.debug(`[HunterLongPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
