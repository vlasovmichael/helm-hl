// ─────────────────────────────────────────────────
//  Strategy #3: Hunter LONG (Iter E.1) — Long-after-dump
// ─────────────────────────────────────────────────
// Зеркало strategistSniper.js на long-сторону: ловим резкий dump (≥X% за 2мин)
// и лонгуем в противоход, рассчитывая на mean-reversion (отскок).
//
// Заняла слот после soft-kill Fade. См. memory/hunter_iter_e_plan.md.
//
// Отличия от Hunter SHORT:
//  - Триггер: dump (pct < -DUMP_PCT), а не pump
//  - Направление: LONG → SL ниже entry, TP выше entry
//  - PnL формула на close: (close - entry)/entry × size (зеркально)
//  - Anti-trend агрессивнее (6% vs 8%) — дампы чаще = real news (delist/scam)
//  - Iter E.1: PAPER only, без trailing TP (это E.2), без PROD trigger orders (E.3)

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';
import {
  setHunterCrossCooldown,
  isHunterCrossCooldownActive,
  getHunterCrossCooldownRemainMs,
} from './hunterCrossCooldown.js';
import { recordNearMiss } from './nearMisses.js';
import {
  loadHunterCooldowns,
  setLongPostSl,
  setLongSlStreak,
  clearLongSlStreak as persistClearLongSlStreak,
  _resetForTest as resetCooldownStore,
} from './hunterCooldownStore.js';

export const HUNTER_LONG_SPIKE_WINDOW_MIN = 2;          // окно 2 мин (как у HUNTER SHORT)
export const HUNTER_LONG_COOLDOWN_MS      = 2 * 60_000; // 2 мин re-detect cooldown per coin
export const HUNTER_LONG_HEARTBEAT_MS     = 5 * 60_000; // heartbeat в лог раз в 5 мин

// Параметры из config (env-overrideable).
export const HUNTER_LONG_DUMP_PCT   = config.trading.hunterLongDumpPct;
const HUNTER_LONG_SL_PCT            = config.trading.hunterLongSlPct;
const HUNTER_LONG_TP_PCT            = config.trading.hunterLongTpPct;
const HUNTER_LONG_TREND_LOOKBACK_MIN = config.trading.hunterLongTrendLookbackMin;
const HUNTER_LONG_TREND_MAX_DROP_PCT = config.trading.hunterLongTrendMaxDropPct;
const HUNTER_LONG_POST_SL_COOLDOWN_MS = config.trading.hunterLongPostSlCooldownMin * 60_000;
const HUNTER_LONG_TIME_STOP_MS       = config.trading.hunterLongTimeStopMin * 60_000;

const HUNTER_LONG_TREND_1H_MIN = 60; // entry feature, не фильтр

// Iter E.2: trailing TP config.
const HUNTER_LONG_TRAIL_ENABLED      = config.trading.hunterLongTrailEnabled;
const HUNTER_LONG_TRAIL_SHADOW_LOG   = config.trading.hunterLongTrailShadowLog;
const HUNTER_LONG_TRAIL_ARM_PCT      = config.trading.hunterLongTrailArmPct;
const HUNTER_LONG_TRAIL_GIVE_BACK_PCT = config.trading.hunterLongTrailGiveBackPct;

// 2026-05-20 toxic-coin filters.
const HUNTER_LONG_MIN_OI_USD     = config.trading.hunterLongMinOiUsd;
const HUNTER_LONG_MIN_VOL_24H    = config.trading.hunterLongMinVol24hUsd;
const HUNTER_LONG_SL_STREAK_BAN     = config.trading.hunterLongSlStreakBan;
const HUNTER_LONG_SL_STREAK_WINDOW_MS = config.trading.hunterLongSlStreakWindowH * 3_600_000;
const HUNTER_LONG_SL_STREAK_BAN_MS  = config.trading.hunterLongSlStreakBanH    * 3_600_000;

// Per-coin cooldown state (изолировано от Hunter SHORT — у него свои Maps).
const cooldownMap     = new Map();   // coin → last-signal timestamp (re-detect)
const postSlCooldown  = new Map();   // coin → ban-until timestamp (мс). Coin запрещена до этого ts.
const slStreak        = new Map();   // coin → { count, lastSlAt } — для consecutive-SL бана

// Восстановление postSlCooldown + slStreak из data/hunter_cooldowns.json после рестарта.
// Bug fix 2026-05-22: до этого Map'ы жили только in-memory, рестарт сбрасывал 24h-баны.
// cooldownMap (2-min re-detect) НЕ персистим — за 2 мин рестарт + новый сигнал в той же монете
// крайне маловероятен, а файловое IO на каждом сигнале не оправдано.
let restoredFromDisk = false;
function restoreFromDiskOnce() {
  if (restoredFromDisk) return;
  restoredFromDisk = true;
  const snap = loadHunterCooldowns();
  for (const [coin, unbanAt] of Object.entries(snap.long.postSlCooldown)) {
    postSlCooldown.set(coin, unbanAt);
  }
  for (const [coin, entry] of Object.entries(snap.long.slStreak)) {
    slStreak.set(coin, entry);
  }
}
restoreFromDiskOnce();
const mfeMaeMap       = new Map();   // positionId → { mfeUsd, maeUsd, mfePct, maePct }
const peakUnrealizedPct = new Map(); // positionId → peak unrealized% (LONG: (current-entry)/entry*100)
const armedShadowMap  = new Map();   // positionId → true, если SHADOW лог уже сработал (one-shot)
let lastHeartbeatAt   = 0;

// Снимок последних подсчитанных dump-спайков для дашборд-карточки Hunter Watchlist.
// Обновляется каждый тик внутри analyzeHunterLong, [{coin, pct}], отсортирован по pct asc (самые сильные dump'ы первые).
let lastLongDumpsSnapshot = { ts: 0, items: [] };
const LONG_SNAPSHOT_LIMIT = 8;
export function getHunterLongDumpsSnapshot() {
  return lastLongDumpsSnapshot;
}

/**
 * Снимок активных cooldown'ов Hunter LONG для дашборда.
 * Возвращает [{coin, type, remainMs}], type ∈ 're_detect' | 'post_sl' | 'sl_streak'.
 */
export function getHunterLongCooldownSnapshot(now = Date.now()) {
  const out = [];
  for (const [coin, lastFired] of cooldownMap) {
    const remain = HUNTER_LONG_COOLDOWN_MS - (now - lastFired);
    if (remain > 0) out.push({ coin, type: 're_detect', remainMs: remain });
  }
  for (const [coin, unbanAt] of postSlCooldown) {
    const remain = unbanAt - now;
    if (remain > 0) {
      const streak = slStreak.get(coin);
      const isStreakBan = streak && streak.count >= HUNTER_LONG_SL_STREAK_BAN;
      out.push({ coin, type: isStreakBan ? 'sl_streak' : 'post_sl', remainMs: remain });
    }
  }
  return out;
}

/** Тестовый helper — сброс state. */
export function resetHunterLongCooldowns() {
  cooldownMap.clear();
  postSlCooldown.clear();
  slStreak.clear();
  mfeMaeMap.clear();
  peakUnrealizedPct.clear();
  armedShadowMap.clear();
  lastHeartbeatAt = 0;
  resetCooldownStore();
  restoredFromDisk = false;
}

/**
 * Ставит post-SL cooldown с учётом streak'а. Вызывается из:
 *   - checkHunterLongExit() при SL (этот же модуль)
 *   - production.js при external_close детекте (Fix C)
 *
 * Behavior:
 *   - streak увеличивается на 1 (или сбрасывается в 1 если прошлый SL > WINDOW назад)
 *   - если streak ≥ HUNTER_LONG_SL_STREAK_BAN → длинный бан (BAN_HOURS)
 *   - иначе стандартный postSlCooldown (HUNTER_LONG_POST_SL_COOLDOWN_MIN)
 */
export function recordHunterLongLossEvent(coin, now = Date.now()) {
  const prev = slStreak.get(coin);
  let count;
  if (prev && now - prev.lastSlAt <= HUNTER_LONG_SL_STREAK_WINDOW_MS) {
    count = prev.count + 1;
  } else {
    count = 1;
  }
  const streakEntry = { count, lastSlAt: now };
  slStreak.set(coin, streakEntry);
  setLongSlStreak(coin, streakEntry);

  const banMs = count >= HUNTER_LONG_SL_STREAK_BAN
    ? HUNTER_LONG_SL_STREAK_BAN_MS
    : HUNTER_LONG_POST_SL_COOLDOWN_MS;
  const unbanAt = now + banMs;
  postSlCooldown.set(coin, unbanAt);
  setLongPostSl(coin, unbanAt);

  if (count >= HUNTER_LONG_SL_STREAK_BAN) {
    logger.warn(
      `[HunterLong] 🚫 #${coin} consecutive SL streak=${count} → banned for ${(banMs / 3_600_000).toFixed(1)}h`,
    );
  }
}

/** Очистка streak'а — вызывается на TP / trail_tp / положительный time_stop. */
export function clearHunterLongSlStreak(coin) {
  slStreak.delete(coin);
  persistClearLongSlStreak(coin);
}

/** Текущий peak unrealized% (для exitFeatures при close). */
export function getHunterLongPeakPct(positionId) {
  return peakUnrealizedPct.get(positionId) ?? 0;
}

/** Снять весь trail-state позиции (вызывается из paperClose). */
export function clearHunterLongTrailState(positionId) {
  if (positionId == null) return;
  peakUnrealizedPct.delete(positionId);
  armedShadowMap.delete(positionId);
}

/** Возвращает MFE/MAE для позиции и удаляет запись (вызывается из paperClose). */
export function consumeHunterLongMfeMae(positionId) {
  const v = mfeMaeMap.get(positionId);
  if (!v) return null;
  mfeMaeMap.delete(positionId);
  return v;
}

/**
 * LONG: profit при росте цены, loss при падении.
 * pnlPct = (current - entry) / entry × 100
 */
function updateMfeMae(position, currentPrice) {
  if (!position?.id || !position.entry_price || !position.size_usd) return;
  const entry = position.entry_price;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const pnlUsd = (position.size_usd * (currentPrice - entry)) / entry;

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
 * Главный анализ Hunter LONG.
 *
 * @param {Array<{coin: string, price: number}>} scoutData
 * @param {Object|null} activePosition — должна иметь strategy_id='hunter_long' для exit-check
 * @param {number} [now=Date.now()]
 * @returns {Object} action
 *   { action: 'HOLD' }
 *   { action: 'OPEN',  strategy_id: 'hunter_long', coin, price, direction: 'LONG', sl, tp, dumpPct, entryFeatures }
 *   { action: 'CLOSE', coin, price, reason: 'hunter_long_sl' | 'hunter_long_tp' | 'hunter_long_time_stop' }
 */
export function analyzeHunterLong(scoutData, activePosition, now = Date.now()) {
  // Exit: только hunter_long-позиция — проверка SL/TP.
  if (activePosition?.strategy_id === 'hunter_long') {
    return checkHunterLongExit(activePosition, scoutData);
  }

  // Детекция: ищем самый сильный dump среди scoutData (pct < -threshold).
  let best = null;            // { coin, price, past, pct (отрицательный), item, trendPct }
  let bestUnqualified = null; // для heartbeat — самый "сильный" dump даже если в cooldown / выше порога
  const allDumps = [];        // для snapshot дашборда
  const data = scoutData ?? [];

  for (const item of data) {
    const past = getPriceNMinAgo(item.coin, HUNTER_LONG_SPIKE_WINDOW_MIN, now);
    if (past === null) continue;

    const pct = ((item.price - past) / past) * 100;
    allDumps.push({ coin: item.coin, pct });
    // Для long-after-dump интересны отрицательные изменения. Чем меньше (ближе к -∞), тем сильнее dump.
    if (!bestUnqualified || pct < bestUnqualified.pct) {
      bestUnqualified = { coin: item.coin, pct };
    }

    if (pct > -HUNTER_LONG_DUMP_PCT) continue;  // дамп слабый или это pump → пропускаем

    const lastFired = cooldownMap.get(item.coin) ?? 0;
    if (now - lastFired < HUNTER_LONG_COOLDOWN_MS) {
      const remain = Math.ceil((HUNTER_LONG_COOLDOWN_MS - (now - lastFired)) / 1000);
      recordNearMiss({ ts: now, strategy: 'hunter_long', coin: item.coin, side: 'LONG', spikePct: pct, reason: 'cooldown', detail: `re-detect cooldown ${remain}s` });
      continue;
    }

    const unbanAt = postSlCooldown.get(item.coin) ?? 0;
    if (now < unbanAt) {
      const remain = Math.ceil((unbanAt - now) / 60_000);
      recordNearMiss({ ts: now, strategy: 'hunter_long', coin: item.coin, side: 'LONG', spikePct: pct, reason: 'post_sl', detail: `post-SL cooldown ${remain}min` });
      continue;
    }

    // Fix A (2026-05-20): toxic-coin filter. Null/undefined → пропуск проверки
    // (degradation: scout мог не получить данные). Число ниже порога → блок + лог.
    const oiUsd = Number.isFinite(item.oiUsd) ? item.oiUsd : null;
    const volUsd = Number.isFinite(item.volume24hUsd) ? item.volume24hUsd : null;
    if (oiUsd !== null && oiUsd < HUNTER_LONG_MIN_OI_USD) {
      logger.info(
        `[HunterLong] ⛔ #${item.coin} dump ${pct.toFixed(2)}% пропущен: OI $${(oiUsd / 1_000).toFixed(0)}k < min $${(HUNTER_LONG_MIN_OI_USD / 1_000).toFixed(0)}k (delist-risk)`,
      );
      recordNearMiss({ ts: now, strategy: 'hunter_long', coin: item.coin, side: 'LONG', spikePct: pct, reason: 'oi', detail: `OI $${(oiUsd / 1_000).toFixed(0)}k < $${(HUNTER_LONG_MIN_OI_USD / 1_000).toFixed(0)}k min` });
      continue;
    }
    if (volUsd !== null && volUsd < HUNTER_LONG_MIN_VOL_24H) {
      logger.info(
        `[HunterLong] ⛔ #${item.coin} dump ${pct.toFixed(2)}% пропущен: vol24h $${(volUsd / 1_000_000).toFixed(2)}M < min $${(HUNTER_LONG_MIN_VOL_24H / 1_000_000).toFixed(1)}M`,
      );
      recordNearMiss({ ts: now, strategy: 'hunter_long', coin: item.coin, side: 'LONG', spikePct: pct, reason: 'vol', detail: `vol24h $${(volUsd / 1_000_000).toFixed(2)}M < $${(HUNTER_LONG_MIN_VOL_24H / 1_000_000).toFixed(1)}M min` });
      continue;
    }

    // Cross-strategy cooldown: Hunter SHORT только что закрылся в этой монете —
    // не лезем в зеркальный long после уже отыгранного движения.
    if (isHunterCrossCooldownActive(item.coin, now)) {
      const remain = Math.ceil(getHunterCrossCooldownRemainMs(item.coin, now) / 60_000);
      logger.info(`[HunterLong] ⛔ #${item.coin} cross-cooldown active (${remain}min remaining)`);
      recordNearMiss({ ts: now, strategy: 'hunter_long', coin: item.coin, side: 'LONG', spikePct: pct, reason: 'cross_cooldown', detail: `cross-cooldown ${remain}min` });
      continue;
    }

    // Anti-trend: если за HUNTER_LONG_TREND_LOOKBACK_MIN цена уже упала на ≥ MAX_DROP_PCT —
    // это устойчивый downtrend (delist/scam/news), не локальный reversion-кандидат.
    let trendPct = null;
    const trendPast = getPriceNMinAgo(item.coin, HUNTER_LONG_TREND_LOOKBACK_MIN, now);
    if (trendPast !== null) {
      trendPct = ((item.price - trendPast) / trendPast) * 100;
      if (trendPct <= -HUNTER_LONG_TREND_MAX_DROP_PCT) {
        logger.info(
          `[HunterLong] ⛔ #${item.coin} dump ${pct.toFixed(2)}%/2мин ` +
            `пропущен: тренд ${trendPct.toFixed(2)}% за ${HUNTER_LONG_TREND_LOOKBACK_MIN}мин ≤ -${HUNTER_LONG_TREND_MAX_DROP_PCT}%`,
        );
        recordNearMiss({ ts: now, strategy: 'hunter_long', coin: item.coin, side: 'LONG', spikePct: pct, reason: 'trend', detail: `trend ${trendPct.toFixed(1)}%/${HUNTER_LONG_TREND_LOOKBACK_MIN}min ≤ -${HUNTER_LONG_TREND_MAX_DROP_PCT}%` });
        continue;
      }
    }

    if (!best || pct < best.pct) {
      best = { coin: item.coin, price: item.price, past, pct, item, trendPct };
    }
  }

  // Snapshot самых сильных dump'ов для дашборда (asc, наиболее отрицательные первые).
  allDumps.sort((a, b) => a.pct - b.pct);
  lastLongDumpsSnapshot = { ts: now, items: allDumps.slice(0, LONG_SNAPSHOT_LIMIT) };

  // Heartbeat.
  if (now - lastHeartbeatAt >= HUNTER_LONG_HEARTBEAT_MS) {
    emitHeartbeat(data, activePosition, bestUnqualified, now);
    lastHeartbeatAt = now;
  }

  // Slot занят чужой стратегией → ждём.
  if (activePosition) {
    if (best) {
      recordNearMiss({ ts: now, strategy: 'hunter_long', coin: best.coin, side: 'LONG', spikePct: best.pct, reason: 'slot_busy', detail: `slot occupied by #${activePosition.coin} (${activePosition.strategy_id || 'carry'})` });
    }
    return { action: 'HOLD' };
  }
  if (!best) return { action: 'HOLD' };

  cooldownMap.set(best.coin, now);

  // LONG: SL ниже entry (loss при дальнейшем падении), TP выше (profit при отскоке).
  const sl = best.price * (1 - HUNTER_LONG_SL_PCT / 100);
  const tp = best.price * (1 + HUNTER_LONG_TP_PCT / 100);

  // Entry features для аналитики (зеркально Hunter SHORT).
  const trend1hPast = getPriceNMinAgo(best.coin, HUNTER_LONG_TREND_1H_MIN, now);
  const trend1hPct  = trend1hPast != null
    ? ((best.price - trend1hPast) / trend1hPast) * 100
    : null;

  const entryFeatures = {
    entry_spike_pct:      best.pct,   // отрицательное число — это dump
    entry_trend_15m_pct:  best.trendPct,
    entry_trend_1h_pct:   trend1hPct,
    entry_funding_rate:   best.item?.fundingRate  ?? null,
    entry_volume_24h_usd: best.item?.volume24hUsd ?? null,
    entry_oi_usd:         best.item?.oiUsd        ?? null,
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  return {
    action:      'OPEN',
    strategy_id: 'hunter_long',
    coin:        best.coin,
    price:       best.price,
    direction:   'LONG',
    sl, tp,
    dumpPct:     best.pct,   // отрицательное; обернуть Math.abs в логах если нужно
    entryFeatures,
  };
}

/** Heartbeat-лог — зеркало Hunter SHORT, только акцент на dump. */
function emitHeartbeat(data, activePosition, bestUnqualified, now) {
  const tracked = data.length;
  let withHistory = 0;
  for (const item of data) {
    if (getPriceNMinAgo(item.coin, HUNTER_LONG_SPIKE_WINDOW_MIN, now) !== null) withHistory++;
  }

  let slotStatus;
  if (!activePosition) slotStatus = 'IDLE';
  else slotStatus = `occupied by ${activePosition.strategy_id || 'carry'} #${activePosition.coin}`;

  const cooldownActive = cooldownMap.size;

  let bestLine;
  if (bestUnqualified) {
    bestLine = `best dump: ${bestUnqualified.pct.toFixed(2)}% on #${bestUnqualified.coin} (need ≤ -${HUNTER_LONG_DUMP_PCT}%)`;
  } else if (tracked === 0) {
    bestLine = 'no hunter-scope coins';
  } else {
    bestLine = `no 2min-history yet (${withHistory}/${tracked} ready)`;
  }

  logger.info(
    `[HunterLong] 💓 tracked=${tracked} (${withHistory} w/history) | ${bestLine} | ` +
      `slot=${slotStatus} | cooldowns=${cooldownActive}`,
  );
}

/**
 * Exit-check для активной hunter_long позиции.
 * LONG:
 *   - SL: current price ≤ sl_price (цена ушла ещё ниже)
 *   - TP: current price ≥ tp_price (отскок)
 *   - Оба в одном тике → SL приоритет (консервативно)
 */
function checkHunterLongExit(position, scoutData) {
  const item = scoutData?.find((x) => x.coin === position.coin);
  if (!item) return { action: 'HOLD' };

  updateMfeMae(position, item.price);

  // Iter E.2: trailing TP. LONG → unrealized > 0 при price > entry.
  const unrealizedPct = ((item.price - position.entry_price) / position.entry_price) * 100;
  const prevPeak = peakUnrealizedPct.get(position.id) ?? 0;
  if (unrealizedPct > prevPeak) {
    peakUnrealizedPct.set(position.id, unrealizedPct);
  }
  const peak = peakUnrealizedPct.get(position.id) ?? 0;

  if (peak >= HUNTER_LONG_TRAIL_ARM_PCT && unrealizedPct > 0) {
    const giveBack = peak - unrealizedPct;
    const giveBackThreshold = peak * (HUNTER_LONG_TRAIL_GIVE_BACK_PCT / 100);
    if (giveBack >= giveBackThreshold) {
      if (HUNTER_LONG_TRAIL_ENABLED) {
        logger.info(
          `[HunterLong] 🎯 TRAIL CLOSE #${position.coin}: peak +${peak.toFixed(2)}% → now +${unrealizedPct.toFixed(2)}% ` +
            `(gave back ${(giveBack / peak * 100).toFixed(0)}% ≥ ${HUNTER_LONG_TRAIL_GIVE_BACK_PCT}%)`,
        );
        setHunterCrossCooldown(position.coin);
        clearHunterLongSlStreak(position.coin);
        return {
          action: 'CLOSE',
          coin:   position.coin,
          price:  item.price,
          reason: 'hunter_long_trail_tp',
          peakPct:     peak,
          giveBackPct: (giveBack / peak) * 100,
        };
      }
      // Shadow log: один раз на позицию.
      if (HUNTER_LONG_TRAIL_SHADOW_LOG && !armedShadowMap.get(position.id)) {
        armedShadowMap.set(position.id, true);
        const tpPrice = position.tp_price;
        const tpPnl = tpPrice ? (tpPrice - position.entry_price) / position.entry_price * 100 : null;
        logger.info(
          `[HunterLong SHADOW] would-trail #${position.coin}: peak +${peak.toFixed(2)}% → now +${unrealizedPct.toFixed(2)}% ` +
            `(giveback ${(giveBack / peak * 100).toFixed(0)}%). Trail-exit ≈ $${item.price.toFixed(6)} (+${unrealizedPct.toFixed(2)}%) ` +
            `vs fixed TP ≈ $${tpPrice} (${tpPnl !== null ? '+' + tpPnl.toFixed(2) + '%' : 'n/a'})`,
        );
      }
    }
  }

  if (position.sl_price != null && item.price <= position.sl_price) {
    recordHunterLongLossEvent(position.coin, Date.now());
    setHunterCrossCooldown(position.coin);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  position.sl_price,
      reason: 'hunter_long_sl',
    };
  }
  if (position.tp_price != null && item.price >= position.tp_price) {
    setHunterCrossCooldown(position.coin);
    clearHunterLongSlStreak(position.coin);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  position.tp_price,
      reason: 'hunter_long_tp',
    };
  }

  if (position.entry_time && Date.now() - position.entry_time >= HUNTER_LONG_TIME_STOP_MS) {
    // Time-stop с прибылью = сигнал отработал (медленно, но в плюс) → не наказываем.
    // Time-stop в убыток = ставим обычный cooldown через recordHunterLongLossEvent.
    const exitPnlPct = ((item.price - position.entry_price) / position.entry_price) * 100;
    if (exitPnlPct > 0) {
      clearHunterLongSlStreak(position.coin);
    } else {
      recordHunterLongLossEvent(position.coin, Date.now());
    }
    setHunterCrossCooldown(position.coin);
    const heldMin = Math.round((Date.now() - position.entry_time) / 60_000);
    // Observability: peak% vs current% при time-stop (см. аналог в strategistSniper.js).
    logger.info(
      `[HunterLong] ⏱ TIME-STOP #${position.coin} (id=${position.id}): held ${heldMin}min | peak +${peak.toFixed(2)}% | now ${exitPnlPct >= 0 ? '+' : ''}${exitPnlPct.toFixed(2)}%`,
    );
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  item.price,
      reason: 'hunter_long_time_stop',
      heldMin,
    };
  }

  return { action: 'HOLD' };
}
