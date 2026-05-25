// ─────────────────────────────────────────────────
//  ChillBoy (trend_follow) — shadow-слот PROD-бота
// ─────────────────────────────────────────────────
// В PROD-боте, пока CHILL_BOY_PROD_ENABLED=false, стратегия торгует виртуально,
// собирая shadow-данные перед PROD-активацией. Свой single-slot, независимый от
// реального: paper-поза не занимает реальный слот и не видна integrity/
// reconcile (иначе integrityCheck принимал бы её за внешнее закрытие).
//
// Не работает, когда:
//   • бот в PAPER-режиме — там ChillBoy идёт через обычный coordinator;
//   • CHILL_BOY_PROD_ENABLED=true — стратегия конкурирует за реальный слот.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeTrendFollow } from '../modules/strategistTrendFollow.js';
import { execute } from '../modules/executor/index.js';

export async function tickTrendFollowPaper(hunterData) {
  if (!config.isProduction) return;  // в PAPER-боте ChillBoy идёт через coordinator
  if (!config.trading.chillBoyEnabled || config.trading.chillBoyProdEnabled) return;

  // ChillBoy-only slot: смотрим строго на свои trend_follow позиции. Fader
  // paper-позиция теперь живёт в отдельном слоте, не блокирует ChillBoy.
  const paperPos = getActivePaperPositionByStrategy('trend_follow');
  const signal = await analyzeTrendFollow(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[ChillBoyPaper] OPEN ${signal.coin}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos) {
    logger.debug(`[ChillBoyPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
