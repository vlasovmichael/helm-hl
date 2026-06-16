// ─────────────────────────────────────────────────
//  Strategy: Hot Movers paper — торгует вердикт карточки 1:1
// ─────────────────────────────────────────────────
// Идея (оператор 2026-06-17): бот «смотрит» на карточку Hot Movers ровно как оператор
// руками и открывает paper-позицию по её вердикту. Вход = тот же момент, когда
// карточка пингует «🎯 enterable» (монета с подтверждённым Setup — trend ИЛИ
// fade, OI-подтверждён, score ≥ порога — ОТКАТИЛАСЬ в зону входа, не чейз).
// Используем ту же чистую логику, что и ntfy-воркер hotMoversAlerts.js
// (buildCoinFeatures + evaluateCoinAlert из hotMoversSetup.js) — это и есть «1:1
// с карточкой».
//
// Отличие от Vapor: Vapor — ОДИН узкий детектор (медленный гринд + OI-дивергенция
// → только SHORT). Hot Movers paper берёт ЛЮБОЙ бейдж карточки: trend-long,
// trend-short, fade-long, fade-short. Оба measurement-only, на ревью сравним.
//
// Слот: независимый paper-слот strategy_id='hotmovers', одна позиция за раз
// (твой one-coin focus), сосуществует с hunter/adopt/vapor (твой мультислот).
// Размер — от реального paper-баланса. Вход твой, выход дисциплинированный:
// жёсткий SL/TP + time-stop с первого дня (руками стопа нет — это главный леак).
// PROD-пути нет. ≥20 сделок до оценки эджа.
//
// trend/fade режим в БД отдельной колонкой НЕ пишем — восстановим на ревью из
// знака entry_oi_delta_15m (trend = OI↑, fade = OI↓). score кладём в
// entry_spike_pct (переиспользуем существующую колонку, без миграции).

import { logger } from '../core/logger.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';
import { getOiNMinAgo } from '../core/oiHistory.js';
import {
  buildCoinFeatures,
  evaluateCoinAlert,
  computeBreadthFlush,
  deriveOiKind,
} from './hotMoversSetup.js';

// ── Параметры (env-overrideable, дефолты захардкожены) ──
export const HM_MIN_SCORE       = parseFloat(process.env.HOT_MOVERS_PAPER_MIN_SCORE || '3');   // = порог бейджа карточки
export const HM_SL_PCT          = parseFloat(process.env.HOT_MOVERS_PAPER_SL_PCT || '2.0');    // жёсткий стоп
export const HM_TP_PCT          = parseFloat(process.env.HOT_MOVERS_PAPER_TP_PCT || '3.0');    // тейк (asymmetry как Hunter)
export const HM_TIME_STOP_MIN   = parseInt(process.env.HOT_MOVERS_PAPER_TIME_STOP_MIN || '120', 10);
export const HM_COOLDOWN_MS      = 2 * 60_000;                                                  // re-detect debounce per coin
export const HM_POST_EXIT_COOLDOWN_MS = parseInt(process.env.HOT_MOVERS_PAPER_POST_EXIT_COOLDOWN_MIN || '30', 10) * 60_000;
const HM_HEARTBEAT_MS           = 5 * 60_000;
const HM_TREND_1H_MIN           = 60;

// Per-coin state (in-memory; paper-эксперимент, без disk-persist в v1).
const prevByCoin          = new Map(); // coin → { side, state } (для evaluateCoinAlert)
const hmCooldownMap       = new Map(); // coin → last-signal ts (re-detect)
const hmPostExitCooldown  = new Map(); // coin → last-exit ts
let lastHeartbeatAt = 0;

/** Тестовый сброс состояния. */
export function resetHotMoversState() {
  prevByCoin.clear();
  hmCooldownMap.clear();
  hmPostExitCooldown.clear();
  lastHeartbeatAt = 0;
}

/**
 * Главный анализ Hot Movers paper.
 * @param {Array<{coin:string, price:number, oiUsd:number|null, fundingRate:number|null, volume24hUsd:number|null}>} hunterData
 * @param {Object|null} activePosition — paper-поза (coin, strategy_id, sl_price, tp_price, entry_price, entry_time, side)
 * @param {number} [now=Date.now()]
 * @returns {Promise<Object>} { action:'HOLD' }
 *   | { action:'OPEN', strategy_id:'hotmovers', coin, price, direction, sl, tp, mode, score, entryFeatures }
 *   | { action:'CLOSE', coin, price, reason }
 */
export async function analyzeHotMovers(hunterData, activePosition, now = Date.now()) {
  // ── Выход: своя поза → SL/TP/time-stop ──
  if (activePosition?.strategy_id === 'hotmovers') {
    return checkHotMoversExit(activePosition, hunterData, now);
  }

  const data = (hunterData ?? []).filter((it) => it?.coin && it.price != null);

  // Фичи по всем монетам один раз (нужно и для breadth-flush, и для решения).
  const deps = { priceNMinAgo: getPriceNMinAgo, oiNMinAgo: getOiNMinAgo };
  const featByCoin = new Map();
  const rows = [];
  for (const item of data) {
    const feats = buildCoinFeatures(item, now, deps);
    featByCoin.set(item.coin, feats);
    rows.push(feats);
  }
  const flush = computeBreadthFlush(rows);

  // HTF-тренд (1h-EMA) нужен только fade-сетапам — гасит fade по тренду, как в
  // карточке. Дёргаем 1h-свечи лишь для них (lazy import, чтобы не тянуть
  // dashboard в тестах/на старте). Зеркало hotMoversAlerts.runOnce.
  let getHtfTrend = null;
  const needHtf = data.some((item) => deriveOiKind(featByCoin.get(item.coin)) === 'down');
  if (needHtf) {
    try {
      ({ getHtfTrend } = await import('./dashboard/routes/movers.js'));
    } catch {
      getHtfTrend = null;
    }
  }

  // Решение по каждой монете (evaluateCoinAlert мутирует prevByCoin для ВСЕХ —
  // зовём по всем, не только по кандидатам, чтобы переходы зоны были честными).
  let best = null; // { coin, item, side, mode, score }
  for (const item of data) {
    const feats = featByCoin.get(item.coin);
    const htfTrend =
      getHtfTrend && deriveOiKind(feats) === 'down'
        ? await getHtfTrend(item.coin, item.price, now).catch(() => null)
        : null;
    const res = evaluateCoinAlert(item, feats, prevByCoin, HM_MIN_SCORE, flush, htfTrend);
    if (!res.fire) continue;

    // Слот занят / кулдауны — кандидата не берём, но prevByCoin уже обновлён.
    if (activePosition) continue;
    if (now - (hmCooldownMap.get(item.coin) ?? 0) < HM_COOLDOWN_MS) continue;
    if (now - (hmPostExitCooldown.get(item.coin) ?? 0) < HM_POST_EXIT_COOLDOWN_MS) continue;

    if (!best || res.score > best.score) {
      best = { coin: item.coin, item, feats, side: res.side, mode: res.mode, score: res.score };
    }
  }

  // Heartbeat.
  if (now - lastHeartbeatAt >= HM_HEARTBEAT_MS) {
    const slot = !activePosition ? 'IDLE' : `occupied by ${activePosition.strategy_id || '?'} #${activePosition.coin}`;
    logger.info(`[HotMovers] 👀 tracked=${data.length} | minScore=${HM_MIN_SCORE} | slot=${slot}`);
    lastHeartbeatAt = now;
  }

  if (activePosition) return { action: 'HOLD' }; // слот занят (свой exit обработан выше)
  if (!best) return { action: 'HOLD' };

  hmCooldownMap.set(best.coin, now);

  const price = best.item.price;
  const isLong = best.side === 'LONG';
  // LONG: SL ниже, TP выше. SHORT: зеркало.
  const sl = isLong ? price * (1 - HM_SL_PCT / 100) : price * (1 + HM_SL_PCT / 100);
  const tp = isLong ? price * (1 + HM_TP_PCT / 100) : price * (1 - HM_TP_PCT / 100);

  const trend1hPast = getPriceNMinAgo(best.coin, HM_TREND_1H_MIN, now);
  const trend1hPct = trend1hPast != null && trend1hPast > 0
    ? ((price - trend1hPast) / trend1hPast) * 100 : null;
  const win = (m) => (best.feats.windows || []).find((w) => w.mins === m)?.spikePct ?? null;

  const entryFeatures = {
    entry_spike_pct:      best.score,            // сила Setup-вердикта (score карточки)
    entry_trend_15m_pct:  win(15),               // 15m окно (база чейз-метра)
    entry_trend_1h_pct:   trend1hPct,
    entry_funding_rate:   best.item.fundingRate  ?? null,
    entry_volume_24h_usd: best.item.volume24hUsd ?? null,
    entry_oi_usd:         best.item.oiUsd        ?? null,
    entry_oi_delta_5m:    best.feats.oiDelta5m   ?? null,
    entry_oi_delta_15m:   best.feats.oiDelta15m  ?? null, // знак ⇒ режим: ↑ trend, ↓ fade
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  logger.info(
    `[HotMovers] 🎯 OPEN ${best.mode.toUpperCase()} ${best.side} #${best.coin} @ $${price} ` +
      `| score ${best.score.toFixed(1)}, ΔOI15m ${best.feats.oiDelta15m != null ? best.feats.oiDelta15m.toFixed(2) + '%' : 'n/a'} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)}`,
  );

  return {
    action:      'OPEN',
    strategy_id: 'hotmovers',
    coin:        best.coin,
    price,
    direction:   best.side,
    sl, tp,
    mode:        best.mode,
    score:       best.score,
    entryFeatures,
  };
}

/** SL/TP/time-stop для открытой hotmovers-позиции (LONG или SHORT). */
function checkHotMoversExit(position, hunterData, now) {
  const item = (hunterData ?? []).find((x) => x.coin === position.coin);
  if (!item || item.price == null) return { action: 'HOLD' }; // нет свежей цены — ждём тик

  const isLong = (position.side || 'short') === 'long';
  const hitSl = position.sl_price != null && (isLong ? item.price <= position.sl_price : item.price >= position.sl_price);
  const hitTp = position.tp_price != null && (isLong ? item.price >= position.tp_price : item.price <= position.tp_price);

  if (hitSl) {
    hmPostExitCooldown.set(position.coin, now);
    return { action: 'CLOSE', coin: position.coin, price: position.sl_price, reason: 'hotmovers_sl' };
  }
  if (hitTp) {
    return { action: 'CLOSE', coin: position.coin, price: position.tp_price, reason: 'hotmovers_tp' };
  }
  if (position.entry_time && now - position.entry_time >= HM_TIME_STOP_MIN * 60_000) {
    hmPostExitCooldown.set(position.coin, now);
    const heldMin = Math.round((now - position.entry_time) / 60_000);
    return { action: 'CLOSE', coin: position.coin, price: item.price, reason: 'hotmovers_time_stop', heldMin };
  }
  return { action: 'HOLD' };
}
