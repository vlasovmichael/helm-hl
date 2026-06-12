import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { isPaused, isEnabled } from '../core/runtimeFlags.js';
import { analyze } from './strategist.js';
import { analyzeFade } from './strategistFade.js';
import { analyzeHunter } from './strategistSniper.js';
import { analyzeHunterLong } from './strategistHunterLong.js';
import { analyzeTrendFollow } from './strategistTrendFollow.js';

/**
 * Coordinator: единая точка входа для стратегий.
 *
 * Один слот — в любой момент открыта максимум одна позиция.
 * Если позиция есть, управление передаётся стратегии-владельцу (strategy_id).
 * Если позиции нет, стратегии опрашиваются по приоритету:
 *   1. Hunter (если HUNTER_ENABLED) — pump ≥ 5% за 2мин → short. Priority #1.
 *   2. Hunter Long (если HUNTER_LONG_ENABLED) — dump ≥ X% за 2мин → long. Iter E.1 (PAPER).
 *   3. Carry (дед) — стабильный фандинг.
 *   4. Fade (deprecated, по умолчанию выключен) — спайки с predicted drop.
 *
 * Iter A: без эвикшена. Если slot занят carry/fade — Hunter ждёт.
 *
 * @param {Array} scoutData — carry/fade scope (узкая ликвидная вселенная)
 * @param {Object|undefined} activePosition
 * @param {Array} [hunterData] — Hunter scope (шире, low-liq monеты тоже). Default: scoutData.
 * @returns {{ action: string, strategy_id?: string, [key: string]: any }}
 */
export async function coordinate(scoutData, activePosition, hunterData = scoutData) {
  if (activePosition) {
    const sid = activePosition.strategy_id || 'carry';

    if (sid === 'hunter') {
      return analyzeHunter(hunterData, activePosition);
    }

    if (sid === 'hunter_long') {
      return analyzeHunterLong(hunterData, activePosition);
    }

    if (sid === 'trend_follow') {
      return analyzeTrendFollow(hunterData, activePosition);
    }

    if (sid === 'fade') {
      return analyzeFade(scoutData, activePosition);
    }

    // Adopt Mode: подхваченная ручная поза. Жёсткий стоп УЖЕ стоит на бирже
    // (reduce-only SL trigger выставлен при подхвате, plans/adopt-mode-plan.md) —
    // его держит биржа, бот per-tick ничего не делает → HOLD (и НЕ проваливаемся
    // в carry-fallback). Выход: стоп / ручное закрытие (ловит integrityCheck).
    // Следующий шаг — храповик+трейл (потребует analyzeAdopt вместо HOLD).
    if (sid === 'adopt') {
      return { action: 'HOLD', strategy_id: 'adopt' };
    }

    const signal = analyze(scoutData, activePosition);
    if (signal.action !== 'HOLD') {
      return { ...signal, strategy_id: 'carry' };
    }
    return signal;
  }

  // No position — query strategies in priority order.
  if (isPaused()) return { action: 'HOLD' };

  if (isEnabled('hunter', config.trading.hunterEnabled) && (!config.isProduction || config.trading.hunterProdEnabled)) {
    const hunterSignal = analyzeHunter(hunterData, undefined);
    if (hunterSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] hunter → ${hunterSignal.action} ${hunterSignal.coin}`);
      return hunterSignal;
    }
  }

  if (isEnabled('hunterLong', config.trading.hunterLongEnabled) && (!config.isProduction || config.trading.hunterLongProdEnabled)) {
    const hunterLongSignal = analyzeHunterLong(hunterData, undefined);
    if (hunterLongSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] hunter_long → ${hunterLongSignal.action} ${hunterLongSignal.coin}`);
      return hunterLongSignal;
    }
  }

  // Strategy #4: trend_follow (Chill Boy). Async — 1h candle fetch с кэшем.
  // Приоритет после Hunter (Hunter ловит быстрые спайки за секунды), до Carry.
  // В PROD-боте при CHILL_BOY_PROD_ENABLED=false стратегия торгует в отдельном
  // shadow-слоте (см. tickTrendFollowPaper) и сюда не лезет, иначе бумажная поза
  // заняла бы реальный single-slot.
  if (isEnabled('chillBoy', config.trading.chillBoyEnabled) && (!config.isProduction || config.trading.chillBoyProdEnabled)) {
    const tfSignal = await analyzeTrendFollow(hunterData, undefined);
    if (tfSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] trend_follow → ${tfSignal.action} ${tfSignal.coin}`);
      return tfSignal;
    }
  }

  if (isEnabled('carry', config.trading.carryEnabled !== false)) {
    const carrySignal = analyze(scoutData, undefined);
    if (carrySignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] carry → ${carrySignal.action} ${carrySignal.coin}`);
      return { ...carrySignal, strategy_id: 'carry' };
    }
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
