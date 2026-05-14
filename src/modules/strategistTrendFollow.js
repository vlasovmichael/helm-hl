// ─────────────────────────────────────────────────
//  Strategy #4: trend_follow (codename Chill Boy) — Volatility squeeze breakout
// ─────────────────────────────────────────────────
// Trend-follower: пересиживаем тихие фазы (squeeze) и заходим по направлению
// первого пробоя. Защищает портфель от трендовых режимов, в которых дед/Hunter
// фейдят и режутся в ноль.
//
// План: memory/trend_follow_plan.md.
// Iter F.1b: PAPER only, single-slot, signal по 1h candles.
//
// Отличия от Hunter:
//  - Окно: 1h candles (не 2 мин tick)
//  - Направление: BOTH long и short (по направлению пробоя)
//  - SL/TP в ATR-единицах (не фиксированные %), 1.5×ATR / 3×ATR (R:R=2:1)
//  - Win rate ожидаемый ~35-40%, payoff большой — это норма для trend-follow

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { detectTrendFollowSignal } from './trendFollowAtr.js';
import { getHourlyCandles } from './candleCache.js';

export const TREND_FOLLOW_HEARTBEAT_MS = 5 * 60_000;
export const TREND_FOLLOW_REENTRY_COOLDOWN_MS = 2 * 60_000; // re-detect debounce per coin

const ATR_SHORT       = config.trading.chillBoyAtrShort;
const ATR_LONG        = config.trading.chillBoyAtrLong;
const SQUEEZE_RATIO   = config.trading.chillBoySqueezeRatio;
const BREAKOUT_MULT   = config.trading.chillBoyBreakoutMult;
const SL_ATR_MULT     = config.trading.chillBoySlAtrMult;
const TP_ATR_MULT     = config.trading.chillBoyTpAtrMult;
const TIME_STOP_MS    = config.trading.chillBoyTimeStopHours * 3_600_000;
const POST_SL_MS      = config.trading.chillBoyPostSlCooldownMin * 60_000;

// Lookback в часах для candleSnapshot: ATR_LONG+1 свечей минимум, +5 запасом.
const LOOKBACK_HOURS = ATR_LONG + 5;

// Per-coin state
const cooldownMap    = new Map();   // coin → ts последнего сигнала (re-detect)
const postSlCooldown = new Map();   // coin → ts последнего SL/time_stop
let lastHeartbeatAt  = 0;

export function resetTrendFollowState() {
  cooldownMap.clear();
  postSlCooldown.clear();
  lastHeartbeatAt = 0;
}

/**
 * Анализ trend-follow.
 *
 * @param {Array<{coin: string, price: number}>} scoutData — те же coins что у Hunter
 * @param {Object|null} activePosition — для exit-check (strategy_id='trend_follow')
 * @param {number} [now=Date.now()]
 * @param {Function} [candleFetcher=getHourlyCandles] — DI для тестов
 * @returns {Promise<Object>} signal
 *   { action: 'HOLD' }
 *   { action: 'OPEN', strategy_id, coin, price, direction, sl, tp, atr, entryFeatures }
 *   { action: 'CLOSE', coin, price, reason: 'trend_follow_sl'|'trend_follow_tp'|'trend_follow_time_stop' }
 */
export async function analyzeTrendFollow(scoutData, activePosition, now = Date.now(), candleFetcher = getHourlyCandles) {
  // Exit для своей позиции
  if (activePosition?.strategy_id === 'trend_follow') {
    return checkTrendFollowExit(activePosition, scoutData, now);
  }

  // Если slot занят чужой стратегией — Iter F.1b без эвикшена, HOLD.
  if (activePosition) return { action: 'HOLD' };

  // Сканируем universe — ищем squeeze+breakout. Параллельные fetch.
  const data = scoutData ?? [];
  const results = await Promise.all(
    data.map(async (item) => {
      // Re-detect cooldown
      const lastFired = cooldownMap.get(item.coin) ?? 0;
      if (now - lastFired < TREND_FOLLOW_REENTRY_COOLDOWN_MS) return null;
      // Post-SL cooldown
      const lastSl = postSlCooldown.get(item.coin) ?? 0;
      if (now - lastSl < POST_SL_MS) return null;

      const candles = await candleFetcher(item.coin, LOOKBACK_HOURS, now);
      if (!candles || candles.length < ATR_LONG + 1) return null;

      const sig = detectTrendFollowSignal(candles, item.price, {
        atrShort: ATR_SHORT, atrLong: ATR_LONG,
        squeezeRatio: SQUEEZE_RATIO, breakoutMult: BREAKOUT_MULT,
      });
      if (!sig.signal) return null;
      return { item, signal: sig };
    }),
  );

  // Heartbeat (раз в 5мин)
  if (now - lastHeartbeatAt >= TREND_FOLLOW_HEARTBEAT_MS) {
    const tracked = data.length;
    const squeezed = results.filter((r) => r?.signal?.inSqueeze).length;
    const hits     = results.filter((r) => r?.signal?.signal).length;
    logger.info(
      `[ChillBoy] 💓 tracked=${tracked} squeezed=${squeezed} breakouts=${hits} | slot=${activePosition ? 'BUSY' : 'IDLE'} | cooldowns=${cooldownMap.size}+${postSlCooldown.size}`,
    );
    lastHeartbeatAt = now;
  }

  // Берём первый breakout (по порядку scoutData) — никакого ранжирования по силе
  // на F.1b. Если будет шквал сигналов одновременно, добавим scoring в F.4.
  const best = results.find((r) => r != null);
  if (!best) return { action: 'HOLD' };

  const { item, signal } = best;
  const direction = signal.signal;   // 'long' | 'short'
  const atrValue  = signal.atrShort;
  const sl = direction === 'long'
    ? item.price - SL_ATR_MULT * atrValue
    : item.price + SL_ATR_MULT * atrValue;
  const tp = direction === 'long'
    ? item.price + TP_ATR_MULT * atrValue
    : item.price - TP_ATR_MULT * atrValue;

  cooldownMap.set(item.coin, now);

  logger.info(
    `[ChillBoy] 🎯 BREAKOUT ${direction.toUpperCase()} #${item.coin} @ $${item.price} | ` +
      `ATR=${atrValue.toFixed(6)} | range=$${signal.range.low.toFixed(6)}-$${signal.range.high.toFixed(6)} | ` +
      `SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)}`,
  );

  return {
    action:      'OPEN',
    strategy_id: 'trend_follow',
    coin:        item.coin,
    price:       item.price,
    direction:   direction.toUpperCase(),
    sl, tp,
    atr:         atrValue,
    entryFeatures: {
      entry_atr_short:    atrValue,
      entry_atr_long:     signal.atrLong,
      entry_squeeze_ratio: atrValue / signal.atrLong,
      entry_range_high:   signal.range.high,
      entry_range_low:    signal.range.low,
      entry_hour_utc:     new Date(now).getUTCHours(),
    },
  };
}

/**
 * Exit-check для trend_follow позиции. Sync (без fetch).
 * Берёт current price из scoutData; если монеты нет — HOLD (next tick подскажет).
 */
function checkTrendFollowExit(position, scoutData, now) {
  const item = (scoutData ?? []).find((x) => x.coin === position.coin);
  if (!item) return { action: 'HOLD' };

  const isLong = (position.side || '').toLowerCase() === 'long';
  const price  = item.price;

  // SL: long → price ≤ sl, short → price ≥ sl
  if (position.sl_price != null) {
    const slHit = isLong ? price <= position.sl_price : price >= position.sl_price;
    if (slHit) {
      postSlCooldown.set(position.coin, now);
      return {
        action: 'CLOSE',
        coin:   position.coin,
        price:  position.sl_price,
        reason: 'trend_follow_sl',
      };
    }
  }
  // TP
  if (position.tp_price != null) {
    const tpHit = isLong ? price >= position.tp_price : price <= position.tp_price;
    if (tpHit) {
      return {
        action: 'CLOSE',
        coin:   position.coin,
        price:  position.tp_price,
        reason: 'trend_follow_tp',
      };
    }
  }
  // Time-stop
  if (position.entry_time && now - position.entry_time >= TIME_STOP_MS) {
    postSlCooldown.set(position.coin, now);
    const heldMin = Math.round((now - position.entry_time) / 60_000);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price,
      reason: 'trend_follow_time_stop',
      heldMin,
    };
  }
  return { action: 'HOLD' };
}
