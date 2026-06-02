// ─────────────────────────────────────────────────
//  Candy Girl (candy_girl) — shadow paper-слот PROD-бота (Iter 2)
// ─────────────────────────────────────────────────
// Зеркало trendFollowPaperTick.js. Пока CANDY_GIRL_PROD_ENABLED=false, Candy Girl
// торгует виртуально, собирая P&L с комиссиями перед PROD-гейтом. Свой single-slot
// (strategy_id='candy_girl'), независимый от реального и от ChillBoy paper-слота.
//
// analyzeCandyGirl НЕ сканирует — переиспользует ранжированные хиты последнего
// scanCandyGirlRadar (его надо вызвать ДО tickCandyGirlPaper в тике). scoutData
// нужен только для exit-цены held-позиции.
//
// Не работает, когда бот в PAPER-режиме (у Candy Girl нет coordinator-пути —
// радар-only) или когда CANDY_GIRL_PROD_ENABLED=true.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeCandyGirl } from '../modules/strategistCandyGirl.js';
import { execute } from '../modules/executor/index.js';

export async function tickCandyGirlPaper(scoutData) {
  if (!config.isProduction) return;  // в PAPER-боте Candy Girl только радар
  if (!config.trading.candyGirlEnabled || config.trading.candyGirlProdEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('candy_girl');
  const signal = analyzeCandyGirl(scoutData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[CandyGirlPaper] OPEN ${signal.coin}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos) {
    logger.debug(`[CandyGirlPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
