// ─────────────────────────────────────────────────
//  Hunter SHORT — shadow paper-слот PROD-бота
// ─────────────────────────────────────────────────
// Зеркало trendFollowPaperTick.js. Пока HUNTER_PROD_ENABLED=false, Hunter SHORT
// торгует виртуально, собирая статистику в независимом paper-слоте
// (strategy_id='hunter'), отдельно от реального. SL/TP симулирует analyzeHunter
// по цене (resting-триггеров на бирже нет — это paper). paperClose считает
// pricePnl по уровню fill'а.
//
// Не работает, когда:
//   • бот в PAPER-режиме — там Hunter идёт через обычный coordinator;
//   • HUNTER_PROD_ENABLED=true — Hunter LIVE, конкурирует за реальный слот
//     (его данные = PRODUCTION history, paper-дубль не нужен).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeHunter } from '../modules/strategistSniper.js';
import { execute } from '../modules/executor/index.js';

export async function tickHunterPaper(hunterData) {
  if (!config.isProduction) return;
  if (!config.trading.hunterEnabled || config.trading.hunterProdEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('hunter');
  const signal = analyzeHunter(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[HunterPaper] OPEN ${signal.coin}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'hunter') {
    logger.debug(`[HunterPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
