import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { analyze } from './strategist.js';
import { analyzeFade } from './strategistFade.js';
import { analyzeHunter } from './strategistSniper.js';

/**
 * Coordinator: единая точка входа для стратегий.
 *
 * Один слот — в любой момент открыта максимум одна позиция.
 * Если позиция есть, управление передаётся стратегии-владельцу (strategy_id).
 * Если позиции нет, стратегии опрашиваются по приоритету:
 *   1. Hunter (если HUNTER_ENABLED) — pump ≥ 5% за 2мин → short. Priority #1.
 *   2. Carry (дед) — стабильный фандинг.
 *   3. Fade — спайки с predicted drop.
 *
 * Iter A: без эвикшена. Если slot занят carry/fade — Hunter ждёт. Эвикшен в Iter B.
 *
 * @param {Array} scoutData
 * @param {Object|undefined} activePosition
 * @returns {{ action: string, strategy_id?: string, [key: string]: any }}
 */
export function coordinate(scoutData, activePosition) {
  if (activePosition) {
    const sid = activePosition.strategy_id || 'carry';

    if (sid === 'hunter') {
      // Hunter exit через SL/TP — analyzeHunter умеет оба пути (entry + exit).
      return analyzeHunter(scoutData, activePosition);
    }

    if (sid === 'fade') {
      return analyzeFade(scoutData, activePosition);
    }

    const signal = analyze(scoutData, activePosition);
    if (signal.action !== 'HOLD') {
      return { ...signal, strategy_id: 'carry' };
    }
    return signal;
  }

  // No position — query strategies in priority order.
  // Hunter первый: "прибыль Снайпера — приоритет №1" (hunter_plan.md).
  if (config.trading.hunterEnabled) {
    const hunterSignal = analyzeHunter(scoutData, undefined);
    if (hunterSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] hunter → ${hunterSignal.action} ${hunterSignal.coin}`);
      return hunterSignal;
    }
  }

  const carrySignal = analyze(scoutData, undefined);
  if (carrySignal.action !== 'HOLD') {
    logger.debug(`[Coordinator] carry → ${carrySignal.action} ${carrySignal.coin}`);
    return { ...carrySignal, strategy_id: 'carry' };
  }

  if (config.trading.fadeEnabled) {
    const fadeSignal = analyzeFade(scoutData, undefined);
    if (fadeSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] fade → ${fadeSignal.action} ${fadeSignal.coin}`);
      return fadeSignal;
    }
  }

  return { action: 'HOLD' };
}
