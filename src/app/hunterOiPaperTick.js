// ─────────────────────────────────────────────────
//  Hunter SHORT +OI — A/B paper-двойник боевого Hunter
// ─────────────────────────────────────────────────
// Точная копия Hunter SHORT, отличие РОВНО одно: OI-divergence ворота на входе
// (шортим памп только если рост OI за 15м ≤ HUNTER_OI_DIV_MAX_PCT — большой рост
// OI = свежие лонги = пробой, не выдох). Независимый paper-слот
// strategy_id='hunter_oi', не занимает реальный single-slot.
//
// КРИТИЧНО: cooldown-состояние двойника — СВОИ мапы (ниже). analyzeHunter с
// opts.persistPostSl=false / crossCooldown=false НЕ пишет в боевые cooldown'ы
// Hunter → бумажный стоп двойника не блокирует реальные входы живого Hunter.
// Дефолтная вселенная snapshot/heartbeat остаётся за боевым Hunter
// (updateSnapshot=false здесь).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeHunter } from '../modules/strategistHunter.js';
import { execute } from '../modules/executor/index.js';

// Изолированное cooldown-состояние двойника (своё, не общее с боевым Hunter).
const oiCooldownMap = new Map(); // coin → last-signal ts (re-detect debounce)
const oiPostSlMap   = new Map(); // coin → SL ts (post-SL cooldown)

const HUNTER_OI_OPTS = {
  strategyId:     'hunter_oi',
  oiDivMaxPct:    config.trading.hunterOiDivMaxPct,
  cooldownMap:    oiCooldownMap,
  postSlMap:      oiPostSlMap,
  persistPostSl:  false, // не пишем на диск (боевой cooldown-стор не трогаем)
  crossCooldown:  false, // не бьём cross-cooldown vs hunter_long
  updateSnapshot: false, // карточку/heartbeat ведёт боевой Hunter
};

export async function tickHunterOiPaper(hunterData) {
  if (!config.trading.hunterOiPaperEnabled) return;

  const paperPos = getActivePaperPositionByStrategy('hunter_oi');
  const signal = analyzeHunter(hunterData, paperPos, Date.now(), HUNTER_OI_OPTS);

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[HunterOiPaper] OPEN ${signal.coin}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'hunter_oi') {
    logger.debug(`[HunterOiPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
