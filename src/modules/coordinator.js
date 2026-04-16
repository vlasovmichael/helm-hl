import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { analyze } from './strategist.js';
import { analyzeFade } from './strategistFade.js';

/**
 * Coordinator: единая точка входа для стратегий.
 *
 * Один слот — в любой момент открыта максимум одна позиция.
 * Если позиция есть, управление передаётся стратегии-владельцу (strategy_id).
 * Если позиции нет, стратегии опрашиваются по приоритету:
 *   1. Carry (дед) — стабильный фандинг
 *   2. Fade — спайки с predicted drop
 *
 * @param {Array} scoutData
 * @param {Object|undefined} activePosition
 * @returns {{ action: string, strategy_id?: string, [key: string]: any }}
 */
export function coordinate(scoutData, activePosition) {
  if (activePosition) {
    const sid = activePosition.strategy_id || 'carry';

    if (sid === 'fade') {
      return analyzeFade(scoutData, activePosition);
    }

    const signal = analyze(scoutData, activePosition);
    if (signal.action !== 'HOLD') {
      return { ...signal, strategy_id: 'carry' };
    }
    return signal;
  }

  // No position — query strategies in priority order
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
