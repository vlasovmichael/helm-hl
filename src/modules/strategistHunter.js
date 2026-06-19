// ─────────────────────────────────────────────────
//  Strategy #3: Hunter SHORT — Volatility Spike Mean-Reversion
// ─────────────────────────────────────────────────
// Directional short-only скальп: ловим резкий pump (≥5% за 2мин) и шортим
// в противоход, рассчитывая на mean-reversion. SL/TP ставятся сразу.
//
// Переименован из strategistSniper.js (2026-06-17) после удаления executor
// Sniper Mode (maker-exit) — путаница «sniper» снята. Single-slot,
// strategy_id='hunter'. Зеркало на long-сторону — strategistHunterLong.js.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getPriceNMinAgo, getBufferLength } from '../core/priceHistory.js';
import { getOiNMinAgo } from '../core/oiHistory.js';
import {
  setHunterCrossCooldown,
  isHunterCrossCooldownActive,
  getHunterCrossCooldownRemainMs,
} from './hunterCrossCooldown.js';
import { recordNearMiss } from './nearMisses.js';
import { trackShadowTick, finalizeShadow } from './hunterShadowExits.js';
import {
  loadHunterCooldowns,
  setShortPostSl,
  _resetForTest as resetCooldownStore,
} from './hunterCooldownStore.js';

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

// Восстановление hunterPostSlCooldown из data/hunter_cooldowns.json после рестарта.
// Bug fix 2026-05-22 (см. hunterCooldownStore.js). hunterCooldownMap (2-min) не персистим.
let restoredFromDisk = false;
function restoreFromDiskOnce() {
  if (restoredFromDisk) return;
  restoredFromDisk = true;
  const snap = loadHunterCooldowns();
  for (const [coin, lastSlAt] of Object.entries(snap.short.postSlCooldown)) {
    hunterPostSlCooldown.set(coin, lastSlAt);
  }
}
restoreFromDiskOnce();

// Снимок последних подсчитанных спайков (для дашборд-карточки Hunter Watchlist).
// Обновляется каждый тик внутри analyzeHunter, [{coin, pct}], отсортирован по pct desc.
let lastShortSpikesSnapshot = { ts: 0, items: [] };
const SPIKE_SNAPSHOT_LIMIT = 8;
export function getHunterShortSpikesSnapshot() {
  return lastShortSpikesSnapshot;
}

// MFE/MAE per open hunter position. Обновляется на каждом тике в checkHunterExit,
// читается paperClose/hunterReconcile при закрытии. Очищается через
// clearHunterMfeMae(positionId) после INSERT в history.
// Структура: positionId → { mfeUsd, maeUsd, mfePct, maePct }
const hunterMfeMaeMap = new Map();

// ── Iter D: trailing TP state ────────────────────────────────────────────
// peakUnrealizedPct: positionId → peak unrealized% (SHORT: (entry-current)/entry*100).
// hunterArmedMap: positionId → true, если ARM_PCT уже пересекали (для D2:
// сигнализирует, что exchange TP-trigger мы сами cancelнули). Live state,
// очищается при close. В D1 заполняется но не влияет на PROD-path.
// hunterArmRequestMap: positionId → true, выставляется в checkHunterExit когда
// нужно выполнить cancel-TP. tick.js consume'ит и выполняет side-effect.
const peakUnrealizedPct   = new Map();
const hunterArmedMap      = new Map();
const hunterArmRequestMap = new Map();
// Iter D3: breakeven храповик. positionId → true, как только peak ≥ BE_ARM_PCT.
const hunterBeArmedMap    = new Map();
// UNCAP-shadow дедуп: positionId, по которым уже залогировали «фикс-TP сработал
// при armed-трейле» (отдельно от hunterArmedMap, чтобы не ломать arm-state).
const hunterUncapShadowLogged = new Set();

const HUNTER_TRAIL_ENABLED      = config.trading.hunterTrailEnabled;
const HUNTER_TRAIL_SHADOW_LOG   = config.trading.hunterTrailShadowLog;
const HUNTER_TRAIL_ARM_PCT      = config.trading.hunterTrailArmPct;
const HUNTER_TRAIL_GIVE_BACK_PCT = config.trading.hunterTrailGiveBackPct;
const HUNTER_TRAIL_UNCAP_TP     = config.trading.hunterTrailUncapTp;
const HUNTER_BE_RATCHET_ENABLED = config.trading.hunterBeRatchetEnabled;
const HUNTER_BE_ARM_PCT         = config.trading.hunterBeArmPct;
const HUNTER_BE_FLOOR_PCT       = config.trading.hunterBeFloorPct;
const HUNTER_SL_SAFETY_BUFFER_PCT = config.trading.hunterSlSafetyBufferPct;

/** Чистит весь trail-state для позиции (вызывается из close-handler'ов). */
export function clearHunterTrailState(positionId) {
  if (positionId == null) return;
  peakUnrealizedPct.delete(positionId);
  hunterArmedMap.delete(positionId);
  hunterArmRequestMap.delete(positionId);
  hunterBeArmedMap.delete(positionId);
  hunterUncapShadowLogged.delete(positionId);
}

/** tick.js: проверить и забрать pending ARM request (one-shot). */
export function consumeHunterArmRequest(positionId) {
  if (positionId == null) return false;
  if (!hunterArmRequestMap.get(positionId)) return false;
  hunterArmRequestMap.delete(positionId);
  return true;
}

/** Возврат ARM request обратно (используется при сбое cancel TP). */
export function requestHunterArm(positionId) {
  if (positionId != null) hunterArmRequestMap.set(positionId, true);
}

/** Проверка armed-флага для D2 (executor/hunterReconcile). Только PROD-armed,
 * не shadow-sentinel. */
export function isHunterArmed(positionId) {
  return hunterArmedMap.get(positionId) === true;
}

/** D2: помечает позицию armed после успешного cancel exchange TP. */
export function setHunterArmed(positionId) {
  if (positionId != null) hunterArmedMap.set(positionId, true);
}

/** D2 restart-handler: снимает armed-флаг после restore TP. */
export function clearHunterArmed(positionId) {
  if (positionId != null) hunterArmedMap.delete(positionId);
}

/** Возвращает текущий peak unrealized% (для exitFeatures при close). */
export function getHunterPeakPct(positionId) {
  return peakUnrealizedPct.get(positionId) ?? 0;
}

const HUNTER_TREND_1H_MIN = 60;  // окно для entry_trend_1h_pct (логирование, не фильтр)

/**
 * Снимок активных cooldown'ов Hunter SHORT для дашборда.
 * Возвращает [{coin, type, remainMs}], type ∈ 're_detect' | 'post_sl'.
 */
export function getHunterShortCooldownSnapshot(now = Date.now()) {
  const out = [];
  for (const [coin, lastFired] of hunterCooldownMap) {
    const remain = HUNTER_COOLDOWN_MS - (now - lastFired);
    if (remain > 0) out.push({ coin, type: 're_detect', remainMs: remain });
  }
  for (const [coin, lastSl] of hunterPostSlCooldown) {
    const remain = HUNTER_POST_SL_COOLDOWN_MS - (now - lastSl);
    if (remain > 0) out.push({ coin, type: 'post_sl', remainMs: remain });
  }
  return out;
}

/** Тестовый helper — сброс cooldown'ов + heartbeat timer. */
export function resetHunterCooldowns() {
  hunterCooldownMap.clear();
  hunterPostSlCooldown.clear();
  hunterMfeMaeMap.clear();
  peakUnrealizedPct.clear();
  hunterArmedMap.clear();
  hunterArmRequestMap.clear();
  hunterBeArmedMap.clear();
  lastHeartbeatAt = 0;
  resetCooldownStore();
  restoredFromDisk = false;
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
  setShortPostSl(coin, now);
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
export function analyzeHunter(scoutData, activePosition, now = Date.now(), opts = {}) {
  // opts: A/B paper-двойник (hunter_oi) переопределяет ровно нужное; дефолты =
  // боевой Hunter байт-в-байт (существующие тесты не затрагиваются).
  //   strategyId    — какой strategy_id ведём/открываем ('hunter' | 'hunter_oi')
  //   oiDivMaxPct   — OI-divergence ворота: skip если ΔOI15м > порога (Infinity=нет ворот)
  //   cooldownMap   — re-detect cooldown (свой у двойника → не душит боевой)
  //   postSlMap     — post-SL cooldown (свой у двойника → не блокирует живые входы)
  //   persistPostSl — писать post-SL на диск (только боевой; двойник нет)
  //   crossCooldown — писать cross-cooldown vs hunter_long (только боевой)
  //   updateSnapshot— обновлять snapshot/heartbeat дашборда (только боевой)
  const {
    strategyId     = 'hunter',
    oiDivMaxPct    = Infinity,
    cooldownMap    = hunterCooldownMap,
    postSlMap      = hunterPostSlCooldown,
    persistPostSl  = true,
    crossCooldown  = true,
    updateSnapshot = true,
  } = opts;

  // ── Выход: hunter-позиция → проверяем SL/TP ──
  if (activePosition?.strategy_id === strategyId) {
    return checkHunterExit(activePosition, scoutData, { postSlMap, persistPostSl, crossCooldown });
  }

  // ── Детекция спайка: проходим весь список, считаем best-кандидата ──
  // Делаем это даже если slot занят чужой стратегией — нужно для heartbeat'а
  // (видимость "насколько близки к сигналу" при занятом слоте).
  let best = null;  // { coin, price, past, pct, item, trend15mPct }
  let bestUnqualified = null;  // лучший по pct даже если ниже порога / в cooldown — для heartbeat
  const allSpikes = [];  // для snapshot
  const data = scoutData ?? [];
  for (const item of data) {
    const past = getPriceNMinAgo(item.coin, HUNTER_SPIKE_WINDOW_MIN, now);
    if (past === null) continue;  // недостаточно истории

    const pct = ((item.price - past) / past) * 100;
    allSpikes.push({ coin: item.coin, pct });
    if (!bestUnqualified || pct > bestUnqualified.pct) {
      bestUnqualified = { coin: item.coin, pct };
    }

    if (pct < HUNTER_SPIKE_PCT) continue;  // pump слабый или dump (short-only → игнор)

    const lastFired = cooldownMap.get(item.coin) ?? 0;
    if (now - lastFired < HUNTER_COOLDOWN_MS) {
      const remain = Math.ceil((HUNTER_COOLDOWN_MS - (now - lastFired)) / 1000);
      recordNearMiss({ ts: now, strategy: strategyId, coin: item.coin, side: 'SHORT', spikePct: pct, reason: 'cooldown', detail: `re-detect cooldown ${remain}s` });
      continue;
    }

    // Post-SL cooldown: после SL не возвращаемся к этой монете N минут (default 30).
    const lastSl = postSlMap.get(item.coin) ?? 0;
    if (now - lastSl < HUNTER_POST_SL_COOLDOWN_MS) {
      const remain = Math.ceil((HUNTER_POST_SL_COOLDOWN_MS - (now - lastSl)) / 60_000);
      recordNearMiss({ ts: now, strategy: strategyId, coin: item.coin, side: 'SHORT', spikePct: pct, reason: 'post_sl', detail: `post-SL cooldown ${remain}min` });
      continue;
    }

    // Cross-strategy cooldown: Hunter LONG только что закрылся в этой монете —
    // не лезем туда же.
    if (isHunterCrossCooldownActive(item.coin, now)) {
      const remain = Math.ceil(getHunterCrossCooldownRemainMs(item.coin, now) / 60_000);
      logger.info(`[Hunter] ⛔ #${item.coin} cross-cooldown active (${remain}min remaining)`);
      recordNearMiss({ ts: now, strategy: strategyId, coin: item.coin, side: 'SHORT', spikePct: pct, reason: 'cross_cooldown', detail: `cross-cooldown ${remain}min` });
      continue;
    }

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
        recordNearMiss({ ts: now, strategy: strategyId, coin: item.coin, side: 'SHORT', spikePct: pct, reason: 'trend', detail: `trend +${trend15mPct.toFixed(1)}%/${HUNTER_TREND_LOOKBACK_MIN}min ≥ ${HUNTER_TREND_MAX_RISE_PCT}%` });
        continue;
      }
    }

    // OI-divergence ворота (вариант hunter_oi). Большой рост открытого интереса
    // за 15м = свежие лонги залезли в памп = это пробой/продолжение, а не выдох →
    // фейдить опасно. Боевой Hunter ворота НЕ ставит (oiDivMaxPct=Infinity). Нет
    // истории OI → пропускаем фильтр (как anti-trend), не блокируем сигнал.
    if (Number.isFinite(oiDivMaxPct)) {
      const oiNowGate = item.oiUsd ?? null;
      const oi15Gate  = getOiNMinAgo(item.coin, 15, now);
      if (oiNowGate != null && oi15Gate != null && oi15Gate > 0) {
        const oiDelta15 = ((oiNowGate - oi15Gate) / oi15Gate) * 100;
        if (oiDelta15 > oiDivMaxPct) {
          recordNearMiss({ ts: now, strategy: strategyId, coin: item.coin, side: 'SHORT', spikePct: pct, reason: 'oi_confirms', detail: `ΔOI +${oiDelta15.toFixed(2)}% > ${oiDivMaxPct}% (свежие лонги — пробой, не выдох)` });
          continue;
        }
      }
    }

    if (!best || pct > best.pct) {
      best = { coin: item.coin, price: item.price, past, pct, item, trend15mPct };
    }
  }

  // ── Snapshot top-N pump spikes для дашборда (только боевой Hunter; двойник
  // hunter_oi не перетирает карточку и не дублирует heartbeat) ──
  if (updateSnapshot) {
    allSpikes.sort((a, b) => b.pct - a.pct);
    lastShortSpikesSnapshot = { ts: now, items: allSpikes.slice(0, SPIKE_SNAPSHOT_LIMIT) };

    // ── Heartbeat: раз в 5 мин показываем что Hunter жив + ближайший к порогу ──
    if (now - lastHeartbeatAt >= HUNTER_HEARTBEAT_MS) {
      emitHeartbeat(data, activePosition, bestUnqualified, now);
      lastHeartbeatAt = now;
    }
  }

  // ── Вход невозможен если slot занят другой стратегией (Iter A без эвикшена) ──
  if (activePosition) {
    if (best) {
      recordNearMiss({ ts: now, strategy: strategyId, coin: best.coin, side: 'SHORT', spikePct: best.pct, reason: 'slot_busy', detail: `slot occupied by #${activePosition.coin} (${activePosition.strategy_id || 'carry'})` });
    }
    return { action: 'HOLD' };
  }

  if (!best) return { action: 'HOLD' };

  cooldownMap.set(best.coin, now);

  // SHORT: SL выше цены входа (loss при росте), TP ниже (profit при падении).
  const sl = best.price * (1 + HUNTER_SL_PCT / 100);
  const tp = best.price * (1 - HUNTER_TP_PCT / 100);

  // Extended logging — фичи рынка в момент сигнала.
  // Все nullable: missing → null в БД, не блокируют сигнал.
  const trend1hPast = getPriceNMinAgo(best.coin, HUNTER_TREND_1H_MIN, now);
  const trend1hPct  = trend1hPast != null
    ? ((best.price - trend1hPast) / trend1hPast) * 100
    : null;

  // Трек B (squeeze-фильтр, 2026-06-15): «форсированность» пампа — растёт ли OI
  // синхронно со спайком (свежий леверидж → склонность к сквизу-откату) или
  // движение тянет short-covering (OI flat/вниз). Measurement-only: пишем
  // ΔOI%, гейт на входе НЕ ставим — решаем фильтр по ≥20 live-сделкам.
  const oiNow    = best.item?.oiUsd ?? null;
  const oi2mAgo  = getOiNMinAgo(best.coin, HUNTER_SPIKE_WINDOW_MIN, now);
  const oi5mAgo  = getOiNMinAgo(best.coin, 5, now);
  const oi15mAgo = getOiNMinAgo(best.coin, 15, now);
  const oiDelta = (past) => oiNow != null && past != null && past > 0
    ? ((oiNow - past) / past) * 100 : null;

  const entryFeatures = {
    entry_spike_pct:      best.pct,
    entry_trend_15m_pct:  best.trend15mPct,
    entry_trend_1h_pct:   trend1hPct,
    entry_funding_rate:   best.item?.fundingRate  ?? null,
    entry_volume_24h_usd: best.item?.volume24hUsd ?? null,
    entry_oi_usd:         best.item?.oiUsd        ?? null,
    entry_oi_delta_2m:    oiDelta(oi2mAgo),
    entry_oi_delta_5m:    oiDelta(oi5mAgo),
    entry_oi_delta_15m:   oiDelta(oi15mAgo),
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  return {
    action:      'OPEN',
    strategy_id: strategyId,
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
function checkHunterExit(position, scoutData, exitOpts = {}) {
  const item = scoutData?.find((x) => x.coin === position.coin);
  // Shadow exits: учитываем тик и финализируем сравнение на close. Полностью
  // measurement-only — реальное решение ниже не зависит от этого.
  if (item) trackShadowTick(position, item.price);
  const result = checkHunterExitCore(position, scoutData, item, exitOpts);
  if (result.action === 'CLOSE') finalizeShadow(position, result.price);
  return result;
}

function checkHunterExitCore(position, scoutData, item, exitOpts = {}) {
  // exitOpts (paper-двойник): postSlMap/persistPostSl/crossCooldown изолируют
  // запись cooldown'ов — бумажный стоп НЕ блокирует боевые входы Hunter.
  const {
    postSlMap     = hunterPostSlCooldown,
    persistPostSl = true,
    crossCooldown = true,
  } = exitOpts;
  // Записи cooldown через хелперы — двойник пишет в СВОЙ postSlMap и не трогает
  // диск/cross-cooldown боевого Hunter.
  const writePostSl = (coin, ts) => {
    postSlMap.set(coin, ts);
    if (persistPostSl) setShortPostSl(coin, ts);
  };
  const writeCrossCooldown = (coin) => {
    if (crossCooldown) setHunterCrossCooldown(coin);
  };
  if (!item) return { action: 'HOLD' };  // нет свежей цены — ждём следующий тик

  // Обновляем MFE/MAE на каждом тике (до проверки SL/TP — захватываем краевые
  // значения тоже). Используется при close для записи в history.
  updateMfeMae(position, item.price);

  // ── Iter D: trailing TP ─────────────────────────────────────────────
  // Track peak unrealized% (SHORT: positive when price falls below entry).
  // Important: оценка trail'а до SL/TP — если armed + giveback, выходим раньше
  // чем сработал бы fixed TP (что и даёт upside в кейсах LDO-типа).
  const unrealizedPct = ((position.entry_price - item.price) / position.entry_price) * 100;
  const prevPeak = peakUnrealizedPct.get(position.id) ?? 0;
  if (unrealizedPct > prevPeak) {
    peakUnrealizedPct.set(position.id, unrealizedPct);
  }
  const peak = peakUnrealizedPct.get(position.id) ?? 0;

  // D2 ARM request: peak пересёк ARM_PCT впервые на PROD hunter позиции.
  // Side-effect (cancel TP-trigger) выполняет tick.js, не этот pure-модуль.
  if (
    HUNTER_TRAIL_ENABLED &&
    config.isProduction &&
    position.mode === 'PRODUCTION' &&
    position.strategy_id === 'hunter' &&
    peak >= HUNTER_TRAIL_ARM_PCT &&
    prevPeak < HUNTER_TRAIL_ARM_PCT &&
    hunterArmedMap.get(position.id) !== true &&
    position.hunter_tp_oid
  ) {
    hunterArmRequestMap.set(position.id, true);
    logger.info(
      `[Hunter] 🔫 TRAIL ARM REQUEST #${position.coin} (id=${position.id}): peak crossed +${peak.toFixed(2)}% ≥ ${HUNTER_TRAIL_ARM_PCT}%`,
    );
  }

  if (peak >= HUNTER_TRAIL_ARM_PCT && unrealizedPct > 0) {
    const giveBack = peak - unrealizedPct;
    const giveBackThreshold = peak * (HUNTER_TRAIL_GIVE_BACK_PCT / 100);
    if (giveBack >= giveBackThreshold) {
      if (HUNTER_TRAIL_ENABLED) {
        logger.info(
          `[Hunter] 🎯 TRAIL CLOSE #${position.coin}: peak +${peak.toFixed(2)}% → now +${unrealizedPct.toFixed(2)}% ` +
            `(gave back ${(giveBack / peak * 100).toFixed(0)}% ≥ ${HUNTER_TRAIL_GIVE_BACK_PCT}%)`,
        );
        writeCrossCooldown(position.coin);
        return {
          action: 'CLOSE',
          coin:   position.coin,
          price:  item.price,
          reason: 'hunter_trail_tp',
          peakPct:     peak,
          giveBackPct: (giveBack / peak) * 100,
        };
      }
      // Shadow: лог один раз на позицию (отдельный sentinel-флаг, чтобы не
      // конфликтовать с PROD-armed состоянием из D2).
      if (HUNTER_TRAIL_SHADOW_LOG && hunterArmedMap.get(position.id) !== 'shadow') {
        hunterArmedMap.set(position.id, 'shadow');
        const wouldBePrice = item.price;
        const tpPrice = position.tp_price;
        const tpPnl = tpPrice ? (position.entry_price - tpPrice) / position.entry_price * 100 : null;
        logger.info(
          `[Hunter SHADOW] would-trail #${position.coin}: peak +${peak.toFixed(2)}% → now +${unrealizedPct.toFixed(2)}% ` +
            `(giveback ${(giveBack / peak * 100).toFixed(0)}%). Trail-exit ≈ $${wouldBePrice.toFixed(6)} (+${unrealizedPct.toFixed(2)}%) ` +
            `vs fixed TP ≈ $${tpPrice} (${tpPnl !== null ? '+' + tpPnl.toFixed(2) + '%' : 'n/a'})`,
        );
      }
    }
  }

  // ── Iter D3: breakeven храповик ─────────────────────────────────────
  // Как только peak ≥ BE_ARM_PCT, взводим. Дальше, если unrealized% упал
  // ≤ FLOOR (0 = безубыток) — закрываем в ~0 ВМЕСТО того чтобы добивать
  // полный SL. Ловит "ушёл в плюс → развернулся" (ZEC: peak +3% → SL −2%).
  // Идёт ВЫШЕ SL-проверки, т.к. floor (price=entry) пробивается раньше,
  // чем SL (price=entry+2%). Порог ARM ниже trail-arm — берёт и подарки,
  // которые не дотянули до trail.
  if (HUNTER_BE_RATCHET_ENABLED && peak >= HUNTER_BE_ARM_PCT) {
    // Лог только на переходе (взвод), не на каждом тике — чтобы был явный
    // след "храповик взведён", и больше не возникало "а где же он?".
    if (hunterBeArmedMap.get(position.id) !== true) {
      logger.info(
        `[Hunter] 🛡 BREAKEVEN RATCHET ARMED #${position.coin} (id=${position.id}): peak +${peak.toFixed(2)}% ≥ ${HUNTER_BE_ARM_PCT}% — ` +
          `floor ${HUNTER_BE_FLOOR_PCT}%, теперь не отдадим в минус`,
      );
    }
    hunterBeArmedMap.set(position.id, true);
  }
  if (hunterBeArmedMap.get(position.id) === true && unrealizedPct <= HUNTER_BE_FLOOR_PCT) {
    logger.warn(
      `[Hunter] 🛡 BREAKEVEN RATCHET #${position.coin} (id=${position.id}): peak +${peak.toFixed(2)}% → ` +
        `now ${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}% ≤ floor ${HUNTER_BE_FLOOR_PCT}% — ` +
        `закрываем в безубыток, не отдаём подарок в минус`,
    );
    writeCrossCooldown(position.coin);
    return {
      action:  'CLOSE',
      coin:    position.coin,
      price:   item.price,
      reason:  'hunter_breakeven_ratchet',
      peakPct: peak,
    };
  }

  if (position.sl_price != null) {
    // SL safety-buffer: если на бирже висит живой SL-триггер (hunter_sl_oid),
    // софтверный стоп — лишь страховка. Срабатывает, только когда цена ушла ЗА
    // sl_price на буфер (= биржевой триггер НЕ исполнился). Нормальный стоп
    // отдаём resting-триггеру: он закрывает на ~0.37 лучше market-close на тике
    // (живые данные 2026-06-19). В paper триггера нет → буфер 0, как раньше.
    const hasExchangeStop = position.hunter_sl_oid != null;
    const slBufPct = hasExchangeStop ? HUNTER_SL_SAFETY_BUFFER_PCT : 0;
    const slLevel = position.sl_price * (1 + slBufPct / 100);

    // Shadow: цена пробила sl_price, но ещё не дошла до буфера — раньше тут
    // софт-стоп бы выстрелил и обогнал биржевой триггер. Лог для оценки эффекта.
    if (hasExchangeStop && slBufPct > 0 && item.price >= position.sl_price && item.price < slLevel) {
      logger.info(
        `[Hunter SL-BUFFER] #${position.coin} (id=${position.id}): цена $${item.price} ≥ SL $${position.sl_price} ` +
          `но < буфер $${slLevel.toFixed(6)} (+${slBufPct}%) — отдаём биржевому триггеру, софт-стоп ждёт`,
      );
    }

    if (item.price >= slLevel) {
      // Регистрируем post-SL cooldown — Hunter не вернётся к этой монете N мин.
      const slTs = Date.now();
      writePostSl(position.coin, slTs);
      writeCrossCooldown(position.coin);
      return {
        action: 'CLOSE',
        coin:   position.coin,
        price:  position.sl_price,
        reason: 'hunter_sl',
      };
    }
  }
  if (position.tp_price != null && item.price <= position.tp_price) {
    const armed = isHunterArmed(position.id);
    // Uncap: при взведённом трейле фикс-TP НЕ режет — поза едет на трейле
    // (выход по giveback/SL/BE). Иначе остаётся потолок +3% (текущее поведение).
    if (HUNTER_TRAIL_UNCAP_TP && armed) {
      // Не закрываем по TP — пусть трейл ведёт. Падаем в HOLD ниже.
    } else {
      // Shadow: фикс-TP сработал, ХОТЯ трейл был armed — ровно те кейсы, где
      // UNCAP вёл бы себя иначе. Лог раз на позицию, для оценки на ≥15 сделках.
      if (armed && !hunterUncapShadowLogged.has(position.id)) {
        hunterUncapShadowLogged.add(position.id);
        logger.info(
          `[Hunter UNCAP-SHADOW] #${position.coin} (id=${position.id}): фикс-TP +${HUNTER_TP_PCT}% сработал при ВЗВЕДЁННОМ трейле ` +
            `(peak +${peak.toFixed(2)}%) — HUNTER_TRAIL_UNCAP_TP=true дал бы ехать дальше на трейле.`,
        );
      }
      writeCrossCooldown(position.coin);
      return {
        action: 'CLOSE',
        coin:   position.coin,
        price:  position.tp_price,
        reason: 'hunter_tp',
      };
    }
  }

  // Time-stop: mean-reversion должен отработать за минуты-десятки. Если позиция
  // болтается между SL/TP уже HUNTER_TIME_STOP_MIN — сценарий не сработал, выходим.
  // Регистрируем cooldown как при SL: монета "не отыгрывает", не лезем обратно.
  if (position.entry_time && Date.now() - position.entry_time >= HUNTER_TIME_STOP_MS) {
    const tsNow = Date.now();
    writePostSl(position.coin, tsNow);
    writeCrossCooldown(position.coin);
    const heldMin = Math.round((Date.now() - position.entry_time) / 60_000);
    // Observability: peak% vs current% при time-stop. Помогает решить, нужен ли
    // в будущем "ARM trail при time-stop если peak >0" или достаточно текущей логики.
    logger.info(
      `[Hunter] ⏱ TIME-STOP #${position.coin} (id=${position.id}): held ${heldMin}min | peak +${peak.toFixed(2)}% | now ${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}%`,
    );
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
