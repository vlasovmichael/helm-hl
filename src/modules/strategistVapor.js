// ─────────────────────────────────────────────────
//  Strategy: Vapor — Exhaustion Short (OI-divergence)
// ─────────────────────────────────────────────────
// Тезис (Трек A, plans/paper-strategies-2026-06-15-plan.md): цена печатает новый
// локальный хай МЕДЛЕННЫМ гриндом, но OI НЕ подтверждает (flat/вниз) → движение
// тянет short-covering, а не свежие лонги → топлива нет → шорт на возврат.
//
// Ортогонален Hunter SHORT (тот ловит резкий спайк ≥3%/2мин по ЧИСТОЙ цене,
// OI игнорит). Vapor ловит то, что Hunter пропускает: медленный гринд без спайка,
// где OI расходится с ценой. PAPER-only, single paper-слот (strategy_id='vapor').
//
// Вход (оператор выбрал rollover-подтверждение 2026-06-15): шортим не на самом хае,
// а когда цена УЖЕ откатилась от хая окна (не лезем в лоб едущий гринд).
// Жёсткий SL с первого дня. ≥20 сделок до оценки эджа, PROD-гейта нет.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getPriceNMinAgo, getSamplesSince } from '../core/priceHistory.js';
import { getOiNMinAgo } from '../core/oiHistory.js';
import { recordNearMiss } from './nearMisses.js';

// ── Параметры (env-overrideable, дефолты захардкожены) ──
export const VAPOR_WINDOW_MIN     = parseInt(process.env.VAPOR_WINDOW_MIN     || '15', 10);   // окно гринда + дивергенции
export const VAPOR_GRIND_MIN_PCT  = parseFloat(process.env.VAPOR_GRIND_MIN_PCT  || '1.5');     // цена ↑ ≥ за окно = гринд
export const VAPOR_SPIKE_MAX_PCT  = parseFloat(process.env.VAPOR_SPIKE_MAX_PCT  || '1.5');     // 2м-движение < этого → НЕ спайк (орто к Hunter)
export const VAPOR_OI_DIV_MAX_PCT = parseFloat(process.env.VAPOR_OI_DIV_MAX_PCT || '0.0');     // ΔOI за окно ≤ этого = нет подтверждения
export const VAPOR_ROLLOVER_MIN_PCT = parseFloat(process.env.VAPOR_ROLLOVER_MIN_PCT || '0.2'); // откат от хая ≥ = rollover подтверждён
export const VAPOR_ROLLOVER_MAX_PCT = parseFloat(process.env.VAPOR_ROLLOVER_MAX_PCT || '1.5'); // но не дальше = ещё у вершины, свежо
export const VAPOR_SL_PCT         = parseFloat(process.env.VAPOR_SL_PCT         || '2.0');     // SL +2% (short = стоп вверх)
export const VAPOR_TP_PCT         = parseFloat(process.env.VAPOR_TP_PCT         || '2.0');     // TP -2% (профит вниз)
export const VAPOR_TIME_STOP_MIN  = parseInt(process.env.VAPOR_TIME_STOP_MIN  || '60', 10);    // выход если сценарий не отработал
export const VAPOR_COOLDOWN_MS    = 2 * 60_000;                                                // re-detect debounce per coin
export const VAPOR_POST_EXIT_COOLDOWN_MS = parseInt(process.env.VAPOR_POST_EXIT_COOLDOWN_MIN || '30', 10) * 60_000;
const VAPOR_HEARTBEAT_MS          = 5 * 60_000;
const VAPOR_TREND_1H_MIN          = 60;

// Per-coin state (in-memory; iter 1 без disk-persist — paper-эксперимент).
const vaporCooldownMap     = new Map(); // coin → last-signal ts (re-detect)
const vaporPostExitCooldown = new Map(); // coin → last-exit ts (после SL/time-stop)
let lastHeartbeatAt = 0;

/** Тестовый сброс состояния. */
export function resetVaporState() {
  vaporCooldownMap.clear();
  vaporPostExitCooldown.clear();
  lastHeartbeatAt = 0;
}

/** Снапшот активных cooldown'ов для дашборда. */
export function getVaporCooldownSnapshot(now = Date.now()) {
  const out = [];
  for (const [coin, ts] of vaporCooldownMap) {
    const remain = VAPOR_COOLDOWN_MS - (now - ts);
    if (remain > 0) out.push({ coin, type: 're_detect', remainMs: remain });
  }
  for (const [coin, ts] of vaporPostExitCooldown) {
    const remain = VAPOR_POST_EXIT_COOLDOWN_MS - (now - ts);
    if (remain > 0) out.push({ coin, type: 'post_exit', remainMs: remain });
  }
  return out;
}

/**
 * Главный анализ Vapor.
 * @param {Array<{coin:string, price:number, oiUsd:number|null, fundingRate:number|null, volume24hUsd:number|null}>} hunterData
 * @param {Object|null} activePosition — paper-поза (с coin, strategy_id, sl_price, tp_price, entry_price, entry_time)
 * @param {number} [now=Date.now()]
 * @returns {Object} { action: 'HOLD' }
 *   | { action:'OPEN', strategy_id:'vapor', coin, price, direction:'SHORT', sl, tp, grindPct, entryFeatures }
 *   | { action:'CLOSE', coin, price, reason }
 */
export function analyzeVapor(hunterData, activePosition, now = Date.now()) {
  // ── Выход: vapor-поза → SL/TP/time-stop ──
  if (activePosition?.strategy_id === 'vapor') {
    return checkVaporExit(activePosition, hunterData, now);
  }

  const data = hunterData ?? [];
  let best = null;          // лучший кандидат по grindPct
  let bestUnqualified = null; // для heartbeat (самый растянутый гринд, даже если не прошёл гейт)

  for (const item of data) {
    const price15 = getPriceNMinAgo(item.coin, VAPOR_WINDOW_MIN, now);
    if (price15 === null || price15 <= 0) continue;            // мало истории

    const grindPct = ((item.price - price15) / price15) * 100;
    if (!bestUnqualified || grindPct > bestUnqualified.grindPct) {
      bestUnqualified = { coin: item.coin, grindPct };
    }
    if (grindPct < VAPOR_GRIND_MIN_PCT) continue;              // не гринд (плоско/вниз)

    // Орто к Hunter: 2м-движение должно быть слабым (это не быстрый спайк).
    const price2 = getPriceNMinAgo(item.coin, 2, now);
    const move2 = price2 != null && price2 > 0 ? ((item.price - price2) / price2) * 100 : null;
    if (move2 != null && move2 >= VAPOR_SPIKE_MAX_PCT) {
      recordNearMiss({ ts: now, strategy: 'vapor', coin: item.coin, side: 'SHORT', spikePct: grindPct, reason: 'is_spike', detail: `2m +${move2.toFixed(2)}% ≥ ${VAPOR_SPIKE_MAX_PCT}% (Hunter-территория)` });
      continue;
    }

    // Rollover-подтверждение: цена уже откатилась от хая окна (но недалеко).
    const samples = getSamplesSince(item.coin, VAPOR_WINDOW_MIN, now);
    if (samples.length < 2) continue;
    let windowMax = 0;
    for (const s of samples) if (s.price > windowMax) windowMax = s.price;
    if (windowMax <= 0) continue;
    const drawFromHigh = ((windowMax - item.price) / windowMax) * 100;
    if (drawFromHigh < VAPOR_ROLLOVER_MIN_PCT || drawFromHigh > VAPOR_ROLLOVER_MAX_PCT) {
      recordNearMiss({ ts: now, strategy: 'vapor', coin: item.coin, side: 'SHORT', spikePct: grindPct, reason: 'no_rollover', detail: `pullback ${drawFromHigh.toFixed(2)}% вне [${VAPOR_ROLLOVER_MIN_PCT}, ${VAPOR_ROLLOVER_MAX_PCT}]` });
      continue;
    }

    // OI-дивергенция — ядро сигнала. Без OI-истории не входим (нечем подтвердить).
    const oiNow = item.oiUsd ?? null;
    const oi15  = getOiNMinAgo(item.coin, VAPOR_WINDOW_MIN, now);
    if (oiNow == null || oi15 == null || oi15 <= 0) {
      recordNearMiss({ ts: now, strategy: 'vapor', coin: item.coin, side: 'SHORT', spikePct: grindPct, reason: 'no_oi', detail: 'нет OI-истории за окно' });
      continue;
    }
    const oiDelta15 = ((oiNow - oi15) / oi15) * 100;
    if (oiDelta15 > VAPOR_OI_DIV_MAX_PCT) {
      recordNearMiss({ ts: now, strategy: 'vapor', coin: item.coin, side: 'SHORT', spikePct: grindPct, reason: 'oi_confirms', detail: `ΔOI +${oiDelta15.toFixed(2)}% > ${VAPOR_OI_DIV_MAX_PCT}% (свежие лонги — это брейкаут, не выдох)` });
      continue;
    }

    // Cooldown'ы.
    const lastFired = vaporCooldownMap.get(item.coin) ?? 0;
    if (now - lastFired < VAPOR_COOLDOWN_MS) continue;
    const lastExit = vaporPostExitCooldown.get(item.coin) ?? 0;
    if (now - lastExit < VAPOR_POST_EXIT_COOLDOWN_MS) {
      const remain = Math.ceil((VAPOR_POST_EXIT_COOLDOWN_MS - (now - lastExit)) / 60_000);
      recordNearMiss({ ts: now, strategy: 'vapor', coin: item.coin, side: 'SHORT', spikePct: grindPct, reason: 'post_exit', detail: `post-exit cooldown ${remain}min` });
      continue;
    }

    if (!best || grindPct > best.grindPct) {
      best = { coin: item.coin, price: item.price, grindPct, move2, oiDelta15, item };
    }
  }

  // Heartbeat.
  if (now - lastHeartbeatAt >= VAPOR_HEARTBEAT_MS) {
    const slot = !activePosition ? 'IDLE' : `occupied by ${activePosition.strategy_id || '?'} #${activePosition.coin}`;
    const bl = bestUnqualified
      ? `best grind +${bestUnqualified.grindPct.toFixed(2)}% on #${bestUnqualified.coin} (need ≥${VAPOR_GRIND_MIN_PCT}%)`
      : 'no window-history yet';
    logger.info(`[Vapor] 💨 tracked=${data.length} | ${bl} | slot=${slot}`);
    lastHeartbeatAt = now;
  }

  if (activePosition) return { action: 'HOLD' };  // слот занят (свой exit обработан выше)
  if (!best) return { action: 'HOLD' };

  vaporCooldownMap.set(best.coin, now);

  // SHORT: SL выше входа, TP ниже.
  const sl = best.price * (1 + VAPOR_SL_PCT / 100);
  const tp = best.price * (1 - VAPOR_TP_PCT / 100);

  const trend1hPast = getPriceNMinAgo(best.coin, VAPOR_TREND_1H_MIN, now);
  const trend1hPct  = trend1hPast != null && trend1hPast > 0
    ? ((best.price - trend1hPast) / trend1hPast) * 100 : null;
  const oiNow   = best.item?.oiUsd ?? null;
  const oi2mAgo = getOiNMinAgo(best.coin, 2, now);
  const oi5mAgo = getOiNMinAgo(best.coin, 5, now);
  const oiDelta = (past) => oiNow != null && past != null && past > 0
    ? ((oiNow - past) / past) * 100 : null;

  const entryFeatures = {
    entry_spike_pct:      best.move2,        // слабое 2м-движение (≠ Hunter-спайк)
    entry_trend_15m_pct:  best.grindPct,     // сам гринд за окно
    entry_trend_1h_pct:   trend1hPct,
    entry_funding_rate:   best.item?.fundingRate  ?? null,
    entry_volume_24h_usd: best.item?.volume24hUsd ?? null,
    entry_oi_usd:         oiNow,
    entry_oi_delta_2m:    oiDelta(oi2mAgo),
    entry_oi_delta_5m:    oiDelta(oi5mAgo),
    entry_oi_delta_15m:   best.oiDelta15,    // ядро: дивергенция за окно
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  logger.info(
    `[Vapor] 🎯 OPEN SHORT #${best.coin} @ $${best.price} | grind +${best.grindPct.toFixed(2)}%/${VAPOR_WINDOW_MIN}m, ` +
      `ΔOI ${best.oiDelta15.toFixed(2)}% (выдох), 2m ${best.move2 != null ? best.move2.toFixed(2) + '%' : 'n/a'} | ` +
      `SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)}`,
  );

  return {
    action:      'OPEN',
    strategy_id: 'vapor',
    coin:        best.coin,
    price:       best.price,
    direction:   'SHORT',
    sl, tp,
    grindPct:    best.grindPct,
    entryFeatures,
  };
}

/** SL/TP/time-stop для открытой vapor-позиции (SHORT). */
function checkVaporExit(position, hunterData, now) {
  const item = (hunterData ?? []).find((x) => x.coin === position.coin);
  if (!item) return { action: 'HOLD' };  // нет свежей цены — ждём тик

  if (position.sl_price != null && item.price >= position.sl_price) {
    vaporPostExitCooldown.set(position.coin, now);
    return { action: 'CLOSE', coin: position.coin, price: position.sl_price, reason: 'vapor_sl' };
  }
  if (position.tp_price != null && item.price <= position.tp_price) {
    return { action: 'CLOSE', coin: position.coin, price: position.tp_price, reason: 'vapor_tp' };
  }
  if (position.entry_time && now - position.entry_time >= VAPOR_TIME_STOP_MIN * 60_000) {
    vaporPostExitCooldown.set(position.coin, now);
    const heldMin = Math.round((now - position.entry_time) / 60_000);
    return { action: 'CLOSE', coin: position.coin, price: item.price, reason: 'vapor_time_stop', heldMin };
  }
  return { action: 'HOLD' };
}
