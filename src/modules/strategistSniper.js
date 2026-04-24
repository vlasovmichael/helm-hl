// ─────────────────────────────────────────────────
//  Strategy #3: Sniper-Hunter — Volatility Spike Mean-Reversion
// ─────────────────────────────────────────────────
// Directional short-only скальп: ловим резкий pump (≥5% за 2мин) и шортим
// в противоход, рассчитывая на mean-reversion. SL/TP ставятся сразу.
//
// ВАЖНО про имя: см. memory/naming_sniper_vs_hunter.md.
// Этот модуль — НЕ executor-sniper (maker-exit improvement). Это стратегия
// уровня strategist.js / strategistFade.js. Single-slot, strategy_id='hunter'.
//
// Iter A.1: только analyzeHunter (чистая функция). В coordinator НЕ подключён.
// Наполнение priceHistory — в Iter A.3 через scout.js.

import { getPriceNMinAgo } from '../core/priceHistory.js';

// ── Конфигурация Iter A (захардкожена; в env переедет при необходимости) ──
export const HUNTER_SPIKE_PCT        = 5.0;           // pump ≥ 5%
export const HUNTER_SPIKE_WINDOW_MIN = 2;             // окно 2 мин
export const HUNTER_SL_PCT           = 2.0;           // SL +2% от entry (для short = stop вверх)
export const HUNTER_TP_PCT           = 3.0;           // TP -3% от entry (для short = profit вниз)
export const HUNTER_COOLDOWN_MS      = 2 * 60_000;    // 2 мин re-detect cooldown per coin

// Per-coin cooldown state. Модульный — в A.3 переедет в executor/state.js,
// чтобы переживать рестарт/сохранение в bot_state.json (если понадобится).
const hunterCooldownMap = new Map();  // coin → last-signal timestamp

/** Тестовый helper — сброс cooldown'ов. */
export function resetHunterCooldowns() {
  hunterCooldownMap.clear();
}

/**
 * Главный анализ Hunter'а.
 *
 * Логика:
 *  - Если активна hunter-позиция → проверяем SL/TP cross → возможный CLOSE.
 *  - Если активна позиция ДРУГОЙ стратегии → HOLD (эвикшена в Iter A нет).
 *  - Если slot свободен → ищем pump ≥ HUNTER_SPIKE_PCT за HUNTER_SPIKE_WINDOW_MIN
 *    среди scoutData (с учётом cooldown per-coin). Берём САМЫЙ крупный спайк.
 *  - Dump (цена упала на ≥5%) → игнорируем (short-only, см. hunter_plan.md).
 *
 * @param {Array<{coin: string, price: number}>} scoutData
 * @param {Object|null} activePosition — строка из БД (с coin, strategy_id, sl_price, tp_price)
 * @param {number} [now=Date.now()]
 * @returns {Object} action
 *   { action: 'HOLD' }
 *   { action: 'OPEN',  strategy_id: 'hunter', coin, price, direction: 'SHORT', sl, tp, spikePct }
 *   { action: 'CLOSE', coin, price, reason: 'hunter_sl' | 'hunter_tp' }
 */
export function analyzeHunter(scoutData, activePosition, now = Date.now()) {
  // ── Выход: hunter-позиция → проверяем SL/TP ──
  if (activePosition?.strategy_id === 'hunter') {
    return checkHunterExit(activePosition, scoutData);
  }

  // ── Вход невозможен если slot занят другой стратегией (Iter A без эвикшена) ──
  if (activePosition) return { action: 'HOLD' };

  // ── Детекция спайка: выбираем максимум среди qualifying ──
  let best = null;  // { coin, price, past, pct }
  for (const item of scoutData ?? []) {
    const past = getPriceNMinAgo(item.coin, HUNTER_SPIKE_WINDOW_MIN, now);
    if (past === null) continue;  // недостаточно истории

    const pct = ((item.price - past) / past) * 100;
    if (pct < HUNTER_SPIKE_PCT) continue;  // pump слабый или dump (short-only → игнор)

    const lastFired = hunterCooldownMap.get(item.coin) ?? 0;
    if (now - lastFired < HUNTER_COOLDOWN_MS) continue;  // per-coin cooldown

    if (!best || pct > best.pct) {
      best = { coin: item.coin, price: item.price, past, pct };
    }
  }

  if (!best) return { action: 'HOLD' };

  hunterCooldownMap.set(best.coin, now);

  // SHORT: SL выше цены входа (loss при росте), TP ниже (profit при падении).
  const sl = best.price * (1 + HUNTER_SL_PCT / 100);
  const tp = best.price * (1 - HUNTER_TP_PCT / 100);

  return {
    action:      'OPEN',
    strategy_id: 'hunter',
    coin:        best.coin,
    price:       best.price,
    direction:   'SHORT',
    sl, tp,
    spikePct:    best.pct,
  };
}

/**
 * Проверка пересечения SL/TP для открытой hunter-позиции.
 * SHORT:
 *   - SL срабатывает если current price ≥ sl_price (цена пошла против шорта)
 *   - TP срабатывает если current price ≤ tp_price (цена ушла в профит)
 * Если оба пересекаются в одном тике — SL приоритет (консервативно).
 * Цена закрытия — уровень триггера (оптимистичная симуляция в paper).
 */
function checkHunterExit(position, scoutData) {
  const item = scoutData?.find((x) => x.coin === position.coin);
  if (!item) return { action: 'HOLD' };  // нет свежей цены — ждём следующий тик

  if (position.sl_price != null && item.price >= position.sl_price) {
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  position.sl_price,
      reason: 'hunter_sl',
    };
  }
  if (position.tp_price != null && item.price <= position.tp_price) {
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  position.tp_price,
      reason: 'hunter_tp',
    };
  }

  return { action: 'HOLD' };
}
