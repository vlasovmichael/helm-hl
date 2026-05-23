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

// Снимок последнего heartbeat — только для dashboard-карточки (диагностика
// детектора). Бот-логику не трогает: на торговые решения никак не влияет.
let lastHeartbeat = null;

// MFE/MAE per open trend_follow position. Обновляется в checkTrendFollowExit,
// читается paperClose при закрытии (по аналогии с Hunter). Только paper —
// долгосрочно поможет оценить «закрытия в плюсе/минусе раньше времени».
const trendFollowMfeMaeMap = new Map();

export function resetTrendFollowState() {
  cooldownMap.clear();
  postSlCooldown.clear();
  trendFollowMfeMaeMap.clear();
  lastHeartbeatAt = 0;
  lastHeartbeat = null;
}

/** Текущие MFE/MAE для открытой trend_follow позиции (dashboard, peek). */
export function getTrendFollowMfeMae(positionId) {
  if (positionId == null) return null;
  return trendFollowMfeMaeMap.get(positionId) ?? null;
}

/** Забрать MFE/MAE и удалить запись (вызывается из paper close-handler'а). */
export function consumeTrendFollowMfeMae(positionId) {
  if (positionId == null) return null;
  const v = trendFollowMfeMaeMap.get(positionId);
  if (!v) return null;
  trendFollowMfeMaeMap.delete(positionId);
  return v;
}

function updateTrendFollowMfeMae(position, currentPrice) {
  if (!position?.id || !position.entry_price || !position.size_usd) return;
  const entry = position.entry_price;
  const isLong = (position.side || '').toLowerCase() === 'long';
  // LONG profit при росте, SHORT — при падении.
  const pnlPct = isLong
    ? ((currentPrice - entry) / entry) * 100
    : ((entry - currentPrice) / entry) * 100;
  const pnlUsd = isLong
    ? (position.size_usd * (currentPrice - entry)) / entry
    : (position.size_usd * (entry - currentPrice)) / entry;

  let v = trendFollowMfeMaeMap.get(position.id);
  if (!v) {
    v = { mfeUsd: pnlUsd, maeUsd: pnlUsd, mfePct: pnlPct, maePct: pnlPct };
    trendFollowMfeMaeMap.set(position.id, v);
    return;
  }
  if (pnlUsd > v.mfeUsd) { v.mfeUsd = pnlUsd; v.mfePct = pnlPct; }
  if (pnlUsd < v.maeUsd) { v.maeUsd = pnlUsd; v.maePct = pnlPct; }
}

/**
 * Облегчённый heartbeat для тиков, где slot занят и universe не сканируется.
 * Держит dashboard-карточку живой — иначе после рестарта она висит «warming up»,
 * пока ChillBoy в сделке (analyzeTrendFollow уходит в ранний return до снапшота).
 */
function markBusyHeartbeat(tracked, now) {
  lastHeartbeat = {
    tracked, squeezed: 0, breakouts: 0,
    slot: 'BUSY',
    reCooldowns: cooldownMap.size,
    postSlCooldowns: postSlCooldown.size,
    watchlist: [],
    cooldownList: buildCooldownList(now),
    ts: now,
  };
}

function buildCooldownList(now) {
  const out = [];
  for (const [coin, ts] of cooldownMap.entries()) {
    const remainMs = TREND_FOLLOW_REENTRY_COOLDOWN_MS - (now - ts);
    if (remainMs > 0) out.push({ coin, kind: 're', remainMs });
  }
  for (const [coin, ts] of postSlCooldown.entries()) {
    const remainMs = POST_SL_MS - (now - ts);
    if (remainMs > 0) out.push({ coin, kind: 'post_sl', remainMs });
  }
  out.sort((a, b) => b.remainMs - a.remainMs);
  return out.slice(0, 10);
}

// Topn squeeze-candidates: считаем «близость к breakout» как dist в %, минимум
// из (range.high - price) и (price - range.low) от текущей цены. Берём только
// inSqueeze монеты (где детектор уже видит coil). Для UI принятия решений.
function buildWatchlist(results, limit = 5) {
  const items = [];
  for (const r of results) {
    if (!r?.signal?.inSqueeze || !r.signal.range) continue;
    const { item, signal } = r;
    const { high, low } = signal.range;
    const distUp   = ((high - item.price) / item.price) * 100;
    const distDown = ((item.price - low) / item.price) * 100;
    items.push({
      coin: item.coin,
      price: item.price,
      ratio: signal.atrShort && signal.atrLong ? signal.atrShort / signal.atrLong : null,
      rangeHigh: high,
      rangeLow:  low,
      distUpPct:   distUp,
      distDownPct: distDown,
      nearest: Math.min(Math.abs(distUp), Math.abs(distDown)),
    });
  }
  items.sort((a, b) => a.nearest - b.nearest);
  return items.slice(0, limit);
}

/** Последний снимок состояния детектора Chill Boy (для dashboard). */
export function getChillBoyHeartbeat() {
  return lastHeartbeat;
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
    markBusyHeartbeat(scoutData?.length ?? 0, now);
    return checkTrendFollowExit(activePosition, scoutData, now);
  }

  // Если slot занят чужой стратегией — Iter F.1b без эвикшена, HOLD.
  if (activePosition) {
    markBusyHeartbeat(scoutData?.length ?? 0, now);
    return { action: 'HOLD' };
  }

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
      // Возвращаем sig всегда, даже без breakout'а: heartbeat считает squeezed
      // по inSqueeze. Раньше тут стоял `if (!sig.signal) return null` — results
      // фильтровались до одних breakout'ов, и squeezed был структурно всегда 0.
      return { item, signal: sig };
    }),
  );

  // Heartbeat snapshot — обновляем каждый тик (дёшево, results уже посчитаны),
  // чтобы dashboard-карточка была свежей. В лог пишем раз в 5мин.
  const tracked  = data.length;
  const squeezed = results.filter((r) => r?.signal?.inSqueeze).length;
  const hits     = results.filter((r) => r?.signal?.signal).length;
  lastHeartbeat = {
    tracked, squeezed, breakouts: hits,
    slot: activePosition ? 'BUSY' : 'IDLE',
    reCooldowns: cooldownMap.size,
    postSlCooldowns: postSlCooldown.size,
    watchlist:    buildWatchlist(results, 5),
    cooldownList: buildCooldownList(now),
    ts: now,
  };
  if (now - lastHeartbeatAt >= TREND_FOLLOW_HEARTBEAT_MS) {
    logger.info(
      `[ChillBoy] 💓 tracked=${tracked} squeezed=${squeezed} breakouts=${hits} | slot=${activePosition ? 'BUSY' : 'IDLE'} | cooldowns=${cooldownMap.size}+${postSlCooldown.size}`,
    );
    lastHeartbeatAt = now;
  }

  // Берём первый breakout (по порядку scoutData) — никакого ранжирования по силе
  // на F.1b. Если будет шквал сигналов одновременно, добавим scoring в F.4.
  // results теперь содержит и не-breakout монеты (для heartbeat) — фильтруем
  // явно по signal.signal, чтобы не открыть позицию на coil без пробоя.
  const best = results.find((r) => r?.signal?.signal);
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
  // Time-stop проверяем ПЕРВЫМ — он time-based, не нуждается в свежей цене.
  // Раньше стоял в самом низу под early-return `if (!item) return HOLD`, из-за
  // чего позиция могла висеть бесконечно, если её coin выпадал из scoutData
  // (инцидент BTC id=90, 2026-05-22: 10h+ при TIME_STOP=6h).
  if (position.entry_time && now - position.entry_time >= TIME_STOP_MS) {
    postSlCooldown.set(position.coin, now);
    const heldMin = Math.round((now - position.entry_time) / 60_000);
    const item    = (scoutData ?? []).find((x) => x.coin === position.coin);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  item?.price ?? position.entry_price,
      reason: 'trend_follow_time_stop',
      heldMin,
    };
  }

  const item = (scoutData ?? []).find((x) => x.coin === position.coin);
  if (!item) {
    logger.warn(`[ChillBoy] exit-check: #${position.coin} нет в scoutData — SL/TP пропущены, ждём time-stop`);
    return { action: 'HOLD' };
  }

  const isLong = (position.side || '').toLowerCase() === 'long';
  const price  = item.price;

  updateTrendFollowMfeMae(position, price);

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
  // Time-stop проверяется в начале функции (до early-return по отсутствию item).
  return { action: 'HOLD' };
}
