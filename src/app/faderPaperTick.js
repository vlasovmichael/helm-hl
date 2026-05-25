// ─────────────────────────────────────────────────
//  Fader (Strategy #5) — paper-only shadow tick
// ─────────────────────────────────────────────────
// Запускается ВСЕГДА (как ChillBoy paper), независимо от PROD/PAPER режима
// бота. FADER_ENABLED — единственный gate. Использует тот же single paper
// slot (getActivePaperPosition) что и ChillBoy: в БД сосуществуют, но в любой
// момент открыта максимум одна paper-позиция.
//
// Дополнительно публикует tier-map (GREEN/YELLOW/RED) в state.latestFader
// для Setup column в Hot Movers (dashboard).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePaperPositionByStrategy } from '../core/database.js';
import { analyzeFader } from '../modules/strategistFader.js';
import { execute } from '../modules/executor/index.js';
import { state } from './state.js';

export async function tickFaderPaper(hunterData) {
  if (!config.trading.faderEnabled) return;

  // Fader-only slot: смотрим строго на свои позиции. ChillBoy paper позиция
  // не блокирует Fader и наоборот — у каждой стратегии независимый paper slot.
  const paperPos = getActivePaperPositionByStrategy('fader');
  const signal   = await analyzeFader(hunterData, paperPos);

  // Публикуем tier-map для дашборда даже если действия нет.
  if (signal?.tiers instanceof Map) {
    state.latestFader   = signal.tiers;
    state.latestFaderAt = Date.now();
  }

  if (signal.action === 'OPEN' && !paperPos) {
    logger.debug(`[FaderPaper] OPEN ${signal.coin} ${signal.direction}`);
    await execute(signal, null);
  } else if (signal.action === 'CLOSE' && paperPos?.strategy_id === 'fader') {
    logger.debug(`[FaderPaper] CLOSE ${signal.coin} — ${signal.reason}`);
    await execute(signal, paperPos);
  }
}
