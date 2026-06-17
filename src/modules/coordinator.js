import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { isPaused, isEnabled } from '../core/runtimeFlags.js';
import { analyzeHunter } from './strategistSniper.js';
import { analyzeHunterLong } from './strategistHunterLong.js';

/**
 * Coordinator: единая точка входа для стратегий.
 *
 * Один слот — в любой момент открыта максимум одна позиция.
 * Если позиция есть, управление передаётся стратегии-владельцу (strategy_id).
 * Если позиции нет, стратегии опрашиваются по приоритету:
 *   1. Hunter (если HUNTER_ENABLED) — pump ≥ 5% за 2мин → short. Priority #1.
 *   2. Hunter Long (если HUNTER_LONG_ENABLED) — dump ≥ X% за 2мин → long. Iter E.1 (PAPER).
 *   3. Carry (дед, снят 2026-06-15, по умолчанию выключен) — стабильный фандинг.
 *
 * Iter A: без эвикшена. Если slot занят — Hunter ждёт.
 * (Fade удалён 2026-06-15 — 0 сделок за трек, deprecated с 12 мая.)
 *
 * @param {Array} scoutData — carry scope (узкая ликвидная вселенная)
 * @param {Object|undefined} activePosition
 * @param {Array} [hunterData] — Hunter scope (шире, low-liq monеты тоже). Default: scoutData.
 * @param {Set<string>} [excludeCoins] — монеты, в которых оператор уже сидит (adopt/
 *   ручные). Бот-стратегиям запрещено ОТКРЫВАТЬ на них вторую позу — иначе на
 *   одном кошельке HL встречный ордер неттит твою позу, а одинаковый — двоит
 *   риск (incident WLD 2026-06-16: Hunter зашортил WLD поверх живого adopt-шорта).
 *   Применяется ТОЛЬКО в ветке открытия; сопровождение активной позы не трогаем.
 * @returns {{ action: string, strategy_id?: string, [key: string]: any }}
 */
export async function coordinate(scoutData, activePosition, hunterData = scoutData, excludeCoins = new Set()) {
  if (activePosition) {
    const sid = activePosition.strategy_id || 'carry';

    if (sid === 'hunter') {
      return analyzeHunter(hunterData, activePosition);
    }

    if (sid === 'hunter_long') {
      return analyzeHunterLong(hunterData, activePosition);
    }

    // Adopt Mode (multi-slot): подхваченные ручные позы ведёт НЕ coordinator, а
    // superviseAdoptPositions() (app/adoptSupervise.js) — он проходит по ВСЕМ
    // adopt-позам и навешивает мягкий выход (BE-храповик + трейл) на каждую,
    // чтобы оператор мог держать несколько ручных входов параллельно. Жёсткий стоп
    // держит биржа (resting SL). Здесь просто HOLD, не проваливаясь в carry.
    // plans/adopt-mode-plan.md.
    if (sid === 'adopt') {
      return { action: 'HOLD', strategy_id: 'adopt' };
    }

    // Carry удалён (2026-06-17). Легаси-позы без распознанного strategy_id больше
    // не ведём из coordinator — биржевой SL держит риск, мягкий выход не навешиваем.
    return { action: 'HOLD', strategy_id: sid };
  }

  // No position — query strategies in priority order.
  if (isPaused()) return { action: 'HOLD' };

  // Выкидываем монеты, в которых оператор уже держит позу (adopt/ручные), из набора
  // кандидатов — чтобы НИ ОДНА бот-стратегия не открыла на них вторую позицию
  // (неттинг при встречной стороне / двойной риск при одинаковой). Фильтруем
  // только здесь, в ветке открытия: сопровождение активной позы выше работает
  // на полном наборе данных. См. WLD 2026-06-16.
  const notOwned = (d) => !excludeCoins.has((d.coin || '').toUpperCase());
  const hunterOpen = excludeCoins.size ? hunterData.filter(notOwned) : hunterData;

  if (isEnabled('hunter', config.trading.hunterEnabled) && (!config.isProduction || config.trading.hunterProdEnabled)) {
    const hunterSignal = analyzeHunter(hunterOpen, undefined);
    if (hunterSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] hunter → ${hunterSignal.action} ${hunterSignal.coin}`);
      return hunterSignal;
    }
  }

  if (isEnabled('hunterLong', config.trading.hunterLongEnabled) && (!config.isProduction || config.trading.hunterLongProdEnabled)) {
    const hunterLongSignal = analyzeHunterLong(hunterOpen, undefined);
    if (hunterLongSignal.action !== 'HOLD') {
      logger.debug(`[Coordinator] hunter_long → ${hunterLongSignal.action} ${hunterLongSignal.coin}`);
      return hunterLongSignal;
    }
  }


  // Carry удалён (2026-06-17). Был последним в приоритете после Hunter/ChillBoy.

  return { action: 'HOLD' };
}
