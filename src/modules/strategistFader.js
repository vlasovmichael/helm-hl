// ─────────────────────────────────────────────────
//  Strategy #5: Fader — contrarian fade scalper (PAPER)
// ─────────────────────────────────────────────────
// Плед: plans/fader-strategy-plan.md.
//
// Логика:
//  - Универс: hunterData (Hot Movers feed, ~топ-20 по абс. движению).
//  - Вход: |move5m| ≥ FADER_SPIKE_PCT_MIN, chopRatio > FADER_CHOP_RATIO_MIN,
//    цена в верхнем/нижнем 25% диапазона 5m.
//  - Направление: contrarian — pump → SHORT, dump → LONG.
//  - TP: adaptive (impulsePct × FADER_TP_RECLAIM_FRAC), floor/ceiling в $.
//  - SL: нет. Soft-kills: time-stop 24h, adverse-kill -20% nominal,
//    trend-break (3× chopRatio низкий подряд).
//  - Cooldown: per-coin после закрытия + global 3 убытка → 1ч stop.
//
// Помимо торгового сигнала экспортирует tier-map для Hot Movers traffic-light
// (Setup column): GREEN/YELLOW/RED по chopRatio + cooldown + slot.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getSamplesSince, hasEnoughHistory } from '../core/priceHistory.js';

export const FADER_HEARTBEAT_MS = 5 * 60_000;

// In-memory state
const cooldownMap        = new Map();   // coin → ts закрытия (cooldown re-entry)
const recentLosses       = [];          // ts недавних убытков для global stop
const trendBreakState    = new Map();   // positionId → { lastCheckTs, lowChopCount }
const mfeMaeMap          = new Map();   // positionId → { mfeUsd, maeUsd, mfePct, maePct }
let lastHeartbeatAt      = 0;
let lastHeartbeat        = null;

const SPIKE_WINDOW_MIN     = () => config.trading.faderSpikeWindowMin;
const SPIKE_PCT_MIN        = () => config.trading.faderSpikePctMin;
const CHOP_RATIO_MIN       = () => config.trading.faderChopRatioMin;
const CHOP_TREND_BREAK_MIN = () => config.trading.faderChopTrendBreakMin;
const EDGE_BAND_PCT        = () => config.trading.faderEdgeBandPct;
const NOMINAL_USD          = () => config.trading.faderNominalUsd;
const LEVERAGE             = () => config.trading.faderLeverage;
const TP_RECLAIM_FRAC      = () => config.trading.faderTpReclaimFrac;
const TP_FLOOR_USD         = () => config.trading.faderTpFloorUsd;
const TP_CEILING_USD       = () => config.trading.faderTpCeilingUsd;
const ADVERSE_KILL_PCT     = () => config.trading.faderAdverseKillPct;
const TIME_STOP_HOURS      = () => config.trading.faderTimeStopHours;
const COOLDOWN_MIN         = () => config.trading.faderReentryCooldownMin;
const LOSS_STREAK_LIMIT    = () => config.trading.faderLossStreakLimit;
const LOSS_STREAK_WINDOW_MIN = () => config.trading.faderLossStreakWindowMin;
const LOSS_STREAK_PAUSE_MIN  = () => config.trading.faderLossStreakPauseMin;

export function resetFaderState() {
  cooldownMap.clear();
  recentLosses.length = 0;
  trendBreakState.clear();
  mfeMaeMap.clear();
  lastHeartbeatAt = 0;
  lastHeartbeat = null;
}

export function getFaderMfeMae(positionId) {
  if (positionId == null) return null;
  return mfeMaeMap.get(positionId) ?? null;
}

export function consumeFaderMfeMae(positionId) {
  if (positionId == null) return null;
  const v = mfeMaeMap.get(positionId);
  if (!v) return null;
  mfeMaeMap.delete(positionId);
  return v;
}

export function clearFaderPositionState(positionId) {
  trendBreakState.delete(positionId);
}

export function getFaderHeartbeat() {
  return lastHeartbeat;
}

/**
 * Регистрирует убыток для loss-streak гейта. Дёргается из paperClose когда
 * закрытая Fader-позиция была в минусе.
 */
export function recordFaderLoss(now = Date.now()) {
  recentLosses.push(now);
  const cutoff = now - LOSS_STREAK_WINDOW_MIN() * 60_000;
  while (recentLosses.length > 0 && recentLosses[0] < cutoff) recentLosses.shift();
}

/** Устанавливает cooldown на повторный вход в монету. */
export function setFaderCooldown(coin, now = Date.now()) {
  cooldownMap.set(coin, now);
}

function isCoolingDown(coin, now) {
  const ts = cooldownMap.get(coin);
  if (!ts) return false;
  if (now - ts >= COOLDOWN_MIN() * 60_000) {
    cooldownMap.delete(coin);
    return false;
  }
  return true;
}

function isGlobalLossPause(now) {
  const cutoff = now - LOSS_STREAK_WINDOW_MIN() * 60_000;
  let count = 0;
  for (let i = recentLosses.length - 1; i >= 0; i--) {
    if (recentLosses[i] >= cutoff) count++;
    else break;
  }
  if (count < LOSS_STREAK_LIMIT()) return false;
  // pause = LOSS_STREAK_PAUSE_MIN с момента последнего убытка
  const last = recentLosses[recentLosses.length - 1];
  return now - last < LOSS_STREAK_PAUSE_MIN() * 60_000;
}

/**
 * Расчёт «choppy»-метрик за окно window-min из priceHistory.
 * Возвращает null если данных недостаточно.
 */
function computeChopMetrics(coin, now) {
  const windowMin = SPIKE_WINDOW_MIN();
  if (!hasEnoughHistory(coin, windowMin, now)) return null;
  const samples = getSamplesSince(coin, windowMin, now);
  if (samples.length < 3) return null;

  let high = -Infinity, low = Infinity;
  for (const s of samples) {
    if (s.price > high) high = s.price;
    if (s.price < low)  low  = s.price;
  }
  const first = samples[0].price;
  const last  = samples[samples.length - 1].price;
  const range = high - low;
  const netAbs = Math.abs(last - first);
  if (first <= 0) return null;

  // chopRatio = range / |net|; защищаем от деления на ~0 (флэт)
  const chopRatio = netAbs < first * 0.0005 ? 999 : range / Math.max(netAbs, 1e-9);
  const movePct   = ((last - first) / first) * 100;  // знаковый
  const rangeBand = range > 0 ? (last - low) / range : 0.5;  // 0..1

  return { high, low, first, last, range, chopRatio, movePct, rangeBand };
}

/**
 * Tier-map для Setup column в Hot Movers.
 * 🟢 GREEN — choppy + не в cooldown + slot свободен
 * 🟡 YELLOW — borderline chopRatio, cooldown активен, или slot занят этой монетой
 * 🔴 RED — trending (chopRatio низкий) либо нет данных
 */
function computeTier(metrics, coin, now, slotState) {
  if (!metrics) return { tier: 'RED', chopRatio: null, direction: null, blocked: 'no_history' };
  const { chopRatio, rangeBand, movePct } = metrics;
  const min = CHOP_RATIO_MIN();
  const tbMin = CHOP_TREND_BREAK_MIN();

  // Direction: pump → SHORT (fade up), dump → LONG (fade down).
  // null если движение слишком слабое чтобы говорить о направлении.
  const direction = Math.abs(movePct) >= 0.3
    ? (movePct > 0 ? 'SHORT' : 'LONG')
    : null;

  if (chopRatio <= tbMin) {
    return { tier: 'RED', chopRatio, direction, blocked: 'trending' };
  }
  if (slotState === 'busy_self') {
    return { tier: 'YELLOW', chopRatio, direction, blocked: 'open_position' };
  }
  if (isCoolingDown(coin, now)) {
    return { tier: 'YELLOW', chopRatio, direction, blocked: 'cooldown' };
  }
  if (chopRatio < min) {
    return { tier: 'YELLOW', chopRatio, direction, blocked: 'chop_borderline' };
  }
  // edge-band gate: для GREEN цена должна быть рядом с экстремумом окна
  const inTopBand    = rangeBand >= 1 - EDGE_BAND_PCT();
  const inBottomBand = rangeBand <= EDGE_BAND_PCT();
  if (!inTopBand && !inBottomBand) {
    return { tier: 'YELLOW', chopRatio, direction, blocked: 'mid_range' };
  }
  if (Math.abs(movePct) < SPIKE_PCT_MIN()) {
    return { tier: 'YELLOW', chopRatio, direction, blocked: 'small_impulse' };
  }
  return { tier: 'GREEN', chopRatio, direction };
}

function updateMfeMae(position, currentPrice) {
  if (!position?.id || !position.entry_price || !position.size_usd) return;
  const isLong = (position.side || '').toLowerCase() === 'long';
  const entry  = position.entry_price;
  const pnlPct = isLong
    ? ((currentPrice - entry) / entry) * 100
    : ((entry - currentPrice) / entry) * 100;
  const pnlUsd = isLong
    ? (position.size_usd * (currentPrice - entry)) / entry
    : (position.size_usd * (entry - currentPrice)) / entry;

  let v = mfeMaeMap.get(position.id);
  if (!v) {
    v = { mfeUsd: pnlUsd, maeUsd: pnlUsd, mfePct: pnlPct, maePct: pnlPct };
    mfeMaeMap.set(position.id, v);
    return;
  }
  if (pnlUsd > v.mfeUsd) { v.mfeUsd = pnlUsd; v.mfePct = pnlPct; }
  if (pnlUsd < v.maeUsd) { v.maeUsd = pnlUsd; v.maePct = pnlPct; }
}

/**
 * Основная точка входа.
 *
 * @param {Array<{coin:string, price:number}>} scoutData  — обычно hunterData
 * @param {Object|null} activePosition  — paper-позиция любой стратегии (single slot)
 * @param {number} [now=Date.now()]
 * @returns {Promise<Object>} signal
 *   { action: 'HOLD' | 'OPEN' | 'CLOSE', ..., tiers: Map<coin, {tier, chopRatio, blocked?}> }
 */
export async function analyzeFader(scoutData, activePosition, now = Date.now()) {
  const data = Array.isArray(scoutData) ? scoutData : [];
  const tiers = new Map();

  // Если slot занят НАШЕЙ позицией — exit-check + tier-map с пометкой busy_self.
  if (activePosition?.strategy_id === 'fader') {
    const exit = checkFaderExit(activePosition, data, now);
    for (const it of data) {
      const m = computeChopMetrics(it.coin, now);
      const slotState = it.coin === activePosition.coin ? 'busy_self' : 'idle';
      tiers.set(it.coin, computeTier(m, it.coin, now, slotState));
    }
    refreshHeartbeat(data, tiers, now, 'BUSY');
    return { ...exit, tiers };
  }

  // Slot занят чужой стратегией — HOLD, но всё равно строим tier-map (для UI).
  if (activePosition) {
    for (const it of data) {
      const m = computeChopMetrics(it.coin, now);
      tiers.set(it.coin, computeTier(m, it.coin, now, 'idle'));
    }
    refreshHeartbeat(data, tiers, now, 'BUSY_OTHER');
    return { action: 'HOLD', tiers };
  }

  // Global loss pause
  if (isGlobalLossPause(now)) {
    for (const it of data) {
      const m = computeChopMetrics(it.coin, now);
      const base = computeTier(m, it.coin, now, 'idle');
      tiers.set(it.coin, { ...base, tier: base.tier === 'RED' ? 'RED' : 'YELLOW', blocked: 'loss_streak_pause' });
    }
    refreshHeartbeat(data, tiers, now, 'PAUSED');
    return { action: 'HOLD', tiers };
  }

  // Scan: ищем первую GREEN-монету с подходящим импульсом.
  let chosen = null;
  for (const it of data) {
    const m = computeChopMetrics(it.coin, now);
    const tier = computeTier(m, it.coin, now, 'idle');
    tiers.set(it.coin, tier);
    if (chosen || tier.tier !== 'GREEN') continue;

    const impulsePct = Math.abs(m.movePct);
    // direction: pump → SHORT (fade up), dump → LONG (fade down)
    const direction = m.movePct > 0 ? 'SHORT' : 'LONG';
    chosen = { item: it, metrics: m, impulsePct, direction };
  }

  refreshHeartbeat(data, tiers, now, chosen ? 'SIGNAL' : 'IDLE');

  if (!chosen) return { action: 'HOLD', tiers };

  const { item, impulsePct, direction } = chosen;
  const tpDistPct = (impulsePct * TP_RECLAIM_FRAC()) / 100;  // как доля цены
  const notional  = NOMINAL_USD() * LEVERAGE();
  // PnL до фрикции ≈ notional × tpDistPct.
  let tpPnlGross = notional * tpDistPct;
  const fee  = config.trading.faderFeeRoundtripPct * 0.01 * notional;
  const slip = config.trading.faderSlippageRoundtripUsd;
  // floor/ceiling работают по NET pnl (после fees+slip).
  let tpPnlNet = tpPnlGross - fee - slip;
  if (tpPnlNet < TP_FLOOR_USD()) {
    tpPnlNet = TP_FLOOR_USD();
    tpPnlGross = tpPnlNet + fee + slip;
  } else if (tpPnlNet > TP_CEILING_USD()) {
    tpPnlNet = TP_CEILING_USD();
    tpPnlGross = tpPnlNet + fee + slip;
  }
  const adjustedTpDistPct = tpPnlGross / notional;
  const tp = direction === 'SHORT'
    ? item.price * (1 - adjustedTpDistPct)
    : item.price * (1 + adjustedTpDistPct);

  setFaderCooldown(item.coin, now);  // занимаем cooldown сразу, чтобы повторно не вошли

  logger.info(
    `[Fader] 🎯 FADE ${direction} #${item.coin} @ $${item.price} | impulse ${impulsePct.toFixed(2)}% ` +
      `| chop ${chosen.metrics.chopRatio.toFixed(2)} | TP $${tp.toFixed(6)} (≈ +$${tpPnlNet.toFixed(2)} net)`,
  );

  return {
    action:      'OPEN',
    strategy_id: 'fader',
    coin:        item.coin,
    price:       item.price,
    direction,
    sl:          null,
    tp,
    impulsePct,
    entryFeatures: {
      entry_spike_pct:   chosen.metrics.movePct,
      entry_trend_15m_pct: null,
      entry_trend_1h_pct:  null,
      entry_hour_utc:    new Date(now).getUTCHours(),
    },
    tiers,
  };
}

function refreshHeartbeat(data, tiers, now, slot) {
  let g = 0, y = 0, r = 0;
  for (const v of tiers.values()) {
    if (v.tier === 'GREEN') g++;
    else if (v.tier === 'YELLOW') y++;
    else r++;
  }
  const top = [...tiers.entries()]
    .filter(([, v]) => v.tier === 'GREEN')
    .slice(0, 5)
    .map(([coin, v]) => ({ coin, chopRatio: v.chopRatio }));

  lastHeartbeat = {
    tracked: data.length,
    green: g, yellow: y, red: r,
    slot,
    cooldowns: cooldownMap.size,
    recentLosses: recentLosses.length,
    watchlist: top,
    ts: now,
  };
  if (now - lastHeartbeatAt >= FADER_HEARTBEAT_MS) {
    logger.info(
      `[Fader] 💓 tracked=${data.length} GREEN=${g} YELLOW=${y} RED=${r} | slot=${slot} ` +
        `| cooldowns=${cooldownMap.size} | recentLosses=${recentLosses.length}`,
    );
    lastHeartbeatAt = now;
  }
}

function checkFaderExit(position, scoutData, now) {
  // Time-stop первым (не нужен item)
  const timeStopMs = TIME_STOP_HOURS() * 3_600_000;
  if (position.entry_time && now - position.entry_time >= timeStopMs) {
    const item = scoutData.find((x) => x.coin === position.coin);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  item?.price ?? position.entry_price,
      reason: 'fader_time_stop',
    };
  }

  const item = scoutData.find((x) => x.coin === position.coin);
  if (!item) {
    return { action: 'HOLD' };
  }

  const isLong = (position.side || '').toLowerCase() === 'long';
  const price  = item.price;

  updateMfeMae(position, price);

  // TP-hit
  if (position.tp_price != null) {
    const tpHit = isLong ? price >= position.tp_price : price <= position.tp_price;
    if (tpHit) {
      return {
        action: 'CLOSE',
        coin:   position.coin,
        price:  position.tp_price,
        reason: 'fader_tp',
      };
    }
  }

  // Adverse-kill: PnL ≤ -ADVERSE_KILL_PCT × nominal
  const nominal = NOMINAL_USD();
  const unrealizedPnl = isLong
    ? (position.size_usd * (price - position.entry_price)) / position.entry_price
    : (position.size_usd * (position.entry_price - price)) / position.entry_price;
  const killThreshold = -nominal * ADVERSE_KILL_PCT();
  if (unrealizedPnl <= killThreshold) {
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price,
      reason: 'fader_adverse_kill',
    };
  }

  // Trend-break: каждые 5мин проверяем chopRatio; 3 раза подряд ниже порога → выход
  const state = trendBreakState.get(position.id) || { lastCheckTs: 0, lowChopCount: 0 };
  if (now - state.lastCheckTs >= 5 * 60_000) {
    const m = computeChopMetrics(position.coin, now);
    if (m) {
      if (m.chopRatio <= CHOP_TREND_BREAK_MIN()) {
        state.lowChopCount += 1;
      } else {
        state.lowChopCount = 0;
      }
      state.lastCheckTs = now;
      trendBreakState.set(position.id, state);
      if (state.lowChopCount >= 3) {
        return {
          action: 'CLOSE',
          coin:   position.coin,
          price,
          reason: 'fader_trend_break',
        };
      }
    }
  }

  return { action: 'HOLD' };
}
