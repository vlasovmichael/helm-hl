// ─────────────────────────────────────────────────
//  Fade-high-ER paper — shadow paper-слот
// ─────────────────────────────────────────────────
// Зеркало hotMoversPaperTick.js. Независимый paper-слот (strategy_id='fadehot'),
// не занимает реальный single-slot. PROD-пути нет — всегда виртуально, гейт только
// FADEHOT_PAPER_ENABLED. Сигнал/SL/time-stop считает analyzeFadeHot по правилу
// fade выдохшегося хвоста (fadeHotSignal.js).
//
// analyzeFadeHot async (тянет 15m-свечи из candleCache для кандидатов) → await.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeFadeHot } from '../modules/strategistFadeHot.js';
import { execute } from '../modules/executor/index.js';

// ntfy-пуши fade-сигналов шлёт отдельный alert-feed (modules/fadeHotAlerts.js) —
// он пушит ВСЕ гейтованные сетапы, включая взятый этим слотом. Поэтому сам paper-слот
// остаётся тихим (без дубля пуша), как и прочие сделки ([[feedback_quiet_tg]]).
export async function tickFadeHotPaper(hunterData) {
  if (!config.trading.fadehotPaperEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('fadehot');
  const signal = await analyzeFadeHot(hunterData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[FadeHotPaper] OPEN ${signal.coin} ${signal.direction}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'fadehot') {
    logger.debug(`[FadeHotPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
