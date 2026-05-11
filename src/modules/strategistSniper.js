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

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getPriceNMinAgo, getBufferLength } from '../core/priceHistory.js';

// ── Конфигурация Iter A (захардкожена; в env переедет при необходимости) ──
// HUNTER_SPIKE_PCT: env-overrideable. Дефолт снижен с 5.0 → 3.0 (2026-05-11):
// за 36ч PAPER при 5% не было НИ ОДНОГО сигнала (best за период = +2.62%),
// 3% даёт ~несколько сигналов/сутки и нормальное R:R с SL=2%/TP=3%.
export const HUNTER_SPIKE_PCT        = parseFloat(process.env.HUNTER_SPIKE_PCT || '3.0');
export const HUNTER_SPIKE_WINDOW_MIN = 2;             // окно 2 мин
export const HUNTER_SL_PCT           = 2.0;           // SL +2% от entry (для short = stop вверх)
export const HUNTER_TP_PCT           = 3.0;           // TP -3% от entry (для short = profit вниз)
export const HUNTER_COOLDOWN_MS      = 2 * 60_000;    // 2 мин re-detect cooldown per coin
export const HUNTER_HEARTBEAT_MS     = 5 * 60_000;    // heartbeat в лог раз в 5 мин

// Анти-тренд + post-SL cooldown + time-stop берутся из config (env-overrideable).
const HUNTER_TREND_LOOKBACK_MIN  = config.trading.hunterTrendLookbackMin;
const HUNTER_TREND_MAX_RISE_PCT  = config.trading.hunterTrendMaxRisePct;
const HUNTER_POST_SL_COOLDOWN_MS = config.trading.hunterPostSlCooldownMin * 60_000;
const HUNTER_TIME_STOP_MS        = config.trading.hunterTimeStopMin * 60_000;

// Per-coin cooldown state. Модульный — в A.3 переедет в executor/state.js,
// чтобы переживать рестарт/сохранение в bot_state.json (если понадобится).
const hunterCooldownMap   = new Map();  // coin → last-signal timestamp (re-detect debounce)
const hunterPostSlCooldown = new Map(); // coin → SL timestamp (длинный cooldown после SL)
let lastHeartbeatAt = 0;

// MFE/MAE per open hunter position. Обновляется на каждом тике в checkHunterExit,
// читается paperClose/hunterReconcile при закрытии. Очищается через
// clearHunterMfeMae(positionId) после INSERT в history.
// Структура: positionId → { mfeUsd, maeUsd, mfePct, maePct }
const hunterMfeMaeMap = new Map();

const HUNTER_TREND_1H_MIN = 60;  // окно для entry_trend_1h_pct (логирование, не фильтр)

/** Тестовый helper — сброс cooldown'ов + heartbeat timer. */
export function resetHunterCooldowns() {
  hunterCooldownMap.clear();
  hunterPostSlCooldown.clear();
  hunterMfeMaeMap.clear();
  lastHeartbeatAt = 0;
}

/**
 * Возвращает накопленные MFE/MAE для hunter-позиции и удаляет запись.
 * Вызывается из paperClose / hunterReconcile в момент закрытия.
 *
 * @param {number} positionId
 * @returns {{mfeUsd, maeUsd, mfePct, maePct} | null}
 */
export function consumeHunterMfeMae(positionId) {
  const v = hunterMfeMaeMap.get(positionId);
  if (!v) return null;
  hunterMfeMaeMap.delete(positionId);
  return v;
}

/**
 * Обновляет MFE/MAE для hunter-позиции по текущей цене.
 * Hunter — short-only: profit при падении цены, loss при росте.
 * @param {Object} position — строка БД с id, entry_price, size_usd, side
 * @param {number} currentPrice
 */
function updateMfeMae(position, currentPrice) {
  if (!position?.id || !position.entry_price || !position.size_usd) return;
  const entry = position.entry_price;
  // Hunter SHORT: pnlPct > 0 при падении цены ниже entry.
  const pnlPct = ((entry - currentPrice) / entry) * 100;
  const pnlUsd = (position.size_usd * (entry - currentPrice)) / entry;

  let v = hunterMfeMaeMap.get(position.id);
  if (!v) {
    v = { mfeUsd: pnlUsd, maeUsd: pnlUsd, mfePct: pnlPct, maePct: pnlPct };
    hunterMfeMaeMap.set(position.id, v);
    return;
  }
  if (pnlUsd > v.mfeUsd) { v.mfeUsd = pnlUsd; v.mfePct = pnlPct; }
  if (pnlUsd < v.maeUsd) { v.maeUsd = pnlUsd; v.maePct = pnlPct; }
}

/**
 * Отметить SL-хит из внешнего пути (Iter C: SL trigger сработал на бирже).
 * Применяет тот же post-SL cooldown что и tick-driven analyzeHunter.
 */
export function recordHunterSlExternal(coin, now = Date.now()) {
  hunterPostSlCooldown.set(coin, now);
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

  // ── Детекция спайка: проходим весь список, считаем best-кандидата ──
  // Делаем это даже если slot занят чужой стратегией — нужно для heartbeat'а
  // (видимость "насколько близки к сигналу" при занятом слоте).
  let best = null;  // { coin, price, past, pct, item, trend15mPct }
  let bestUnqualified = null;  // лучший по pct даже если ниже порога / в cooldown — для heartbeat
  const data = scoutData ?? [];
  for (const item of data) {
    const past = getPriceNMinAgo(item.coin, HUNTER_SPIKE_WINDOW_MIN, now);
    if (past === null) continue;  // недостаточно истории

    const pct = ((item.price - past) / past) * 100;
    if (!bestUnqualified || pct > bestUnqualified.pct) {
      bestUnqualified = { coin: item.coin, pct };
    }

    if (pct < HUNTER_SPIKE_PCT) continue;  // pump слабый или dump (short-only → игнор)

    const lastFired = hunterCooldownMap.get(item.coin) ?? 0;
    if (now - lastFired < HUNTER_COOLDOWN_MS) continue;  // per-coin cooldown

    // Post-SL cooldown: после SL не возвращаемся к этой монете N минут (default 30).
    const lastSl = hunterPostSlCooldown.get(item.coin) ?? 0;
    if (now - lastSl < HUNTER_POST_SL_COOLDOWN_MS) continue;

    // Anti-trend filter: если за HUNTER_TREND_LOOKBACK_MIN цена выросла на ≥
    // HUNTER_TREND_MAX_RISE_PCT — это устойчивый pump, не reversion-кандидат.
    // Если истории нет (свежий старт / новая монета) — пропускаем фильтр.
    let trend15mPct = null;
    const trendPast = getPriceNMinAgo(item.coin, HUNTER_TREND_LOOKBACK_MIN, now);
    if (trendPast !== null) {
      trend15mPct = ((item.price - trendPast) / trendPast) * 100;
      if (trend15mPct >= HUNTER_TREND_MAX_RISE_PCT) {
        logger.info(
          `[Hunter] ⛔ #${item.coin} спайк +${pct.toFixed(2)}%/2мин ` +
            `пропущен: тренд +${trend15mPct.toFixed(2)}% за ${HUNTER_TREND_LOOKBACK_MIN}мин ≥ ${HUNTER_TREND_MAX_RISE_PCT}%`,
        );
        continue;
      }
    }

    if (!best || pct > best.pct) {
      best = { coin: item.coin, price: item.price, past, pct, item, trend15mPct };
    }
  }

  // ── Heartbeat: раз в 5 мин показываем что Hunter жив + ближайший к порогу ──
  if (now - lastHeartbeatAt >= HUNTER_HEARTBEAT_MS) {
    emitHeartbeat(data, activePosition, bestUnqualified, now);
    lastHeartbeatAt = now;
  }

  // ── Вход невозможен если slot занят другой стратегией (Iter A без эвикшена) ──
  if (activePosition) return { action: 'HOLD' };

  if (!best) return { action: 'HOLD' };

  hunterCooldownMap.set(best.coin, now);

  // SHORT: SL выше цены входа (loss при росте), TP ниже (profit при падении).
  const sl = best.price * (1 + HUNTER_SL_PCT / 100);
  const tp = best.price * (1 - HUNTER_TP_PCT / 100);

  // Extended logging — фичи рынка в момент сигнала.
  // Все nullable: missing → null в БД, не блокируют сигнал.
  const trend1hPast = getPriceNMinAgo(best.coin, HUNTER_TREND_1H_MIN, now);
  const trend1hPct  = trend1hPast != null
    ? ((best.price - trend1hPast) / trend1hPast) * 100
    : null;

  const entryFeatures = {
    entry_spike_pct:      best.pct,
    entry_trend_15m_pct:  best.trend15mPct,
    entry_trend_1h_pct:   trend1hPct,
    entry_funding_rate:   best.item?.fundingRate  ?? null,
    entry_volume_24h_usd: best.item?.volume24hUsd ?? null,
    entry_oi_usd:         best.item?.oiUsd        ?? null,
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  return {
    action:      'OPEN',
    strategy_id: 'hunter',
    coin:        best.coin,
    price:       best.price,
    direction:   'SHORT',
    sl, tp,
    spikePct:    best.pct,
    entryFeatures,
  };
}

/**
 * Heartbeat-лог: подтверждение что Hunter жив + ближайший к порогу кандидат.
 * Показывает сколько монет в отслеживании, slot-status, и best spike (даже если в cooldown / ниже порога).
 */
function emitHeartbeat(data, activePosition, bestUnqualified, now) {
  const tracked = data.length;
  // Сколько монет накопили 2-мин историю (реально "видимы" для детектора)
  let withHistory = 0;
  for (const item of data) {
    if (getPriceNMinAgo(item.coin, HUNTER_SPIKE_WINDOW_MIN, now) !== null) withHistory++;
  }

  let slotStatus;
  if (!activePosition) slotStatus = 'IDLE';
  else slotStatus = `occupied by ${activePosition.strategy_id || 'carry'} #${activePosition.coin}`;

  const cooldownActive = hunterCooldownMap.size;

  let bestLine;
  if (bestUnqualified) {
    const sign = bestUnqualified.pct >= 0 ? '+' : '';
    bestLine = `best: ${sign}${bestUnqualified.pct.toFixed(2)}% on #${bestUnqualified.coin} (need ≥${HUNTER_SPIKE_PCT}%)`;
  } else if (tracked === 0) {
    bestLine = 'no hunter-scope coins';
  } else {
    bestLine = `no 2min-history yet (${withHistory}/${tracked} ready)`;
  }

  logger.info(
    `[Hunter] 💓 tracked=${tracked} (${withHistory} w/history) | ${bestLine} | ` +
      `slot=${slotStatus} | cooldowns=${cooldownActive}`,
  );
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

  // Обновляем MFE/MAE на каждом тике (до проверки SL/TP — захватываем краевые
  // значения тоже). Используется при close для записи в history.
  updateMfeMae(position, item.price);

  if (position.sl_price != null && item.price >= position.sl_price) {
    // Регистрируем post-SL cooldown — Hunter не вернётся к этой монете N мин.
    hunterPostSlCooldown.set(position.coin, Date.now());
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

  // Time-stop: mean-reversion должен отработать за минуты-десятки. Если позиция
  // болтается между SL/TP уже HUNTER_TIME_STOP_MIN — сценарий не сработал, выходим.
  // Регистрируем cooldown как при SL: монета "не отыгрывает", не лезем обратно.
  if (position.entry_time && Date.now() - position.entry_time >= HUNTER_TIME_STOP_MS) {
    hunterPostSlCooldown.set(position.coin, Date.now());
    const heldMin = Math.round((Date.now() - position.entry_time) / 60_000);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  item.price,
      reason: 'hunter_time_stop',
      heldMin,
    };
  }

  return { action: 'HOLD' };
}
