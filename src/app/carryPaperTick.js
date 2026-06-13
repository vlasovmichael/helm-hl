// ─────────────────────────────────────────────────
//  Carry (дед) — shadow paper-слот PROD-бота
// ─────────────────────────────────────────────────
// Зеркало trendFollowPaperTick.js. Пока CARRY_PROD_ENABLED=false, carry торгует
// виртуально в независимом paper-слоте (strategy_id='carry'), собирая статистику
// отдельно от реального слота. Выходы (funding-decay / apy-below / stale / max-hold
// / trailing-TP / BE-храповик) симулирует analyze() по scoutData.
//
// Coordinator при CARRY_PROD_ENABLED=false НЕ открывает реальные carry-входы
// (см. coordinator.js) — так carry уходит в чистое накопление, не занимая
// реальный слот (его держит Hunter SHORT). analyze() не проставляет strategy_id —
// добавляем 'carry' вручную перед execute (как делает coordinator).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyze } from '../modules/strategist.js';
import { execute } from '../modules/executor/index.js';

export async function tickCarryPaper(scoutData) {
  if (!config.isProduction) return;
  if (config.trading.carryEnabled === false || config.trading.carryProdEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('carry');
  const signal = analyze(scoutData, paperPos);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[CarryPaper] OPEN ${signal.coin}`);
    await execute({ ...signal, strategy_id: 'carry' }, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'carry') {
    logger.debug(`[CarryPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute({ ...signal, strategy_id: 'carry' }, paperPos);
  }
  // ROTATE (carry-specific «закрыть текущую → открыть лучшую») в paper-накоплении
  // не обрабатываем: rotate-путь executor'а сложнее, а для shadow-данных достаточно
  // OPEN/CLOSE. Позиция дождётся штатного CLOSE-сигнала.
}
