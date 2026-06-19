// ─────────────────────────────────────────────────
//  Strategy: Fade-high-ER paper — forward-валидация «fade выдохшегося хвоста»
// ─────────────────────────────────────────────────
// Торгует правило fadeHotSignal.js (вход: |ход 30м|≥3% И Kaufman ER 4ч≥0.47,
// сторона = fade против хода). Выход: широкий защитный стоп ~3% ИЛИ time-stop ~2ч
// (НЕ тесный стоп — он убивает эдж; НЕ фикс-TP — эдж живёт в удержании до времени).
// Контекст и обоснование: memory darkknight_backtest_2026_06_19 / fadehot_build_plan.
//
// Слот: независимый paper-слот strategy_id='fadehot', одна позиция за раз,
// сосуществует с hunter/adopt/vapor/hotmovers/swing. PROD-пути нет — всегда
// виртуально, гейт только FADEHOT_PAPER_ENABLED. ≥20-30 сделок до оценки эджа,
// решение через ~месяц живых данных (forward-валидация выбранного правила).
//
// Источник истории — 15m candleSnapshot (candleCache), а не OI-окна карточки.
// Тяжёлый fetch гейтим дешёвым пре-фильтром по priceHistory (ход 30м ≥ порога):
// тянем 15m-свечи только для кандидатов, не по всей вселенной каждый тик.

import { logger } from '../core/logger.js';
import { getPriceNMinAgo } from '../core/priceHistory.js';
import { getFifteenMinCandles } from './candleCache.js';
import {
  evaluateFadeHot,
  fadeHotZone,
  FADEHOT_MOVE_LB,
  FADEHOT_ER_WIN,
  FADEHOT_MOVE_THR,
  FADEHOT_STOP_PCT,
  FADEHOT_TIME_STOP_MIN,
} from './fadeHotSignal.js';

// ── Параметры слота (env-overrideable) ──
const FH_MOVE_30M_MIN          = FADEHOT_MOVE_THR;                 // = порог сигнала (дешёвый пре-гейт)
const FH_PREGATE_MIN           = parseInt(process.env.FADEHOT_PREGATE_LOOKBACK_MIN || '30', 10); // 30м = MOVE_LB×15
const FH_CANDLE_LOOKBACK_MIN   = (FADEHOT_ER_WIN + FADEHOT_MOVE_LB + 4) * 15;  // ≈5ч с запасом
const FH_COOLDOWN_MS           = 2 * 60_000;                        // re-detect debounce per coin
const FH_POST_EXIT_COOLDOWN_MS = parseInt(process.env.FADEHOT_POST_EXIT_COOLDOWN_MIN || '60', 10) * 60_000;
const FH_MAX_CANDIDATES        = parseInt(process.env.FADEHOT_MAX_CANDIDATES || '8', 10); // кап тяжёлых fetch/тик
const FH_HEARTBEAT_MS          = 5 * 60_000;

// Per-coin state (in-memory; paper-эксперимент, без disk-persist в v1).
const fhCooldownMap      = new Map(); // coin → last-signal ts (re-detect)
const fhPostExitCooldown = new Map(); // coin → last-exit ts
let lastHeartbeatAt = 0;

/** Тестовый сброс состояния. */
export function resetFadeHotState() {
  fhCooldownMap.clear();
  fhPostExitCooldown.clear();
  lastHeartbeatAt = 0;
}

/**
 * Главный анализ Fade-high-ER paper.
 * @param {Array<{coin:string, price:number, fundingRate?:number|null, volume24hUsd?:number|null, oiUsd?:number|null}>} hunterData
 * @param {Object|null} activePosition — paper-поза (coin, strategy_id, sl_price, side, entry_time)
 * @param {number} [now=Date.now()]
 * @param {Function} [fetchCandles=getFifteenMinCandles] — инжектится в тестах
 * @returns {Promise<Object>} { action:'HOLD' }
 *   | { action:'OPEN', strategy_id:'fadehot', coin, price, direction, sl, tp:null, entryFeatures }
 *   | { action:'CLOSE', coin, price, reason }
 */
export async function analyzeFadeHot(hunterData, activePosition, now = Date.now(), fetchCandles = getFifteenMinCandles) {
  // ── Выход: своя поза → стоп / time-stop ──
  if (activePosition?.strategy_id === 'fadehot') {
    return checkFadeHotExit(activePosition, hunterData, now);
  }

  const data = (hunterData ?? []).filter((it) => it?.coin && it.price != null);

  // ── Дешёвый пре-гейт: |ход 30м| ≥ порога по priceHistory (без HL-запросов) ──
  // Отбираем кандидатов, по которым только и тянем тяжёлые 15m-свечи.
  const candidates = [];
  for (const item of data) {
    const past = getPriceNMinAgo(item.coin, FH_PREGATE_MIN, now);
    if (past == null || !(past > 0)) continue;
    const move30 = ((item.price - past) / past) * 100;
    if (Math.abs(move30) < FH_MOVE_30M_MIN) continue;
    candidates.push({ item, move30, absMove: Math.abs(move30) });
  }
  // Сильнейший ход первым — кап тяжёлых fetch на тик.
  candidates.sort((a, b) => b.absMove - a.absMove);
  const toCheck = candidates.slice(0, FH_MAX_CANDIDATES);

  // ── Подтверждение по 15m-свечам (ход + Kaufman ER) ──
  let best = null; // { coin, item, side, move, er }
  for (const { item } of toCheck) {
    // Слот занят / кулдауны — кандидата не подтверждаем (экономим fetch).
    if (activePosition) break;
    if (now - (fhCooldownMap.get(item.coin) ?? 0) < FH_COOLDOWN_MS) continue;
    if (now - (fhPostExitCooldown.get(item.coin) ?? 0) < FH_POST_EXIT_COOLDOWN_MS) continue;

    let candles;
    try {
      candles = await fetchCandles(item.coin, FH_CANDLE_LOOKBACK_MIN, now);
    } catch {
      candles = null;
    }
    if (!candles) continue;

    const v = evaluateFadeHot(candles);
    if (!v.fired) continue;

    // Лучший по ER (сильнее «выдохшийся хвост» = выше эффективность хода).
    if (!best || v.er > best.er) {
      best = { coin: item.coin, item, side: v.side, move: v.move, er: v.er };
    }
  }

  // Heartbeat.
  if (now - lastHeartbeatAt >= FH_HEARTBEAT_MS) {
    const slot = !activePosition ? 'IDLE' : `occupied by ${activePosition.strategy_id || '?'} #${activePosition.coin}`;
    logger.info(`[FadeHot] 🔥 tracked=${data.length} | candidates=${candidates.length} | slot=${slot}`);
    lastHeartbeatAt = now;
  }

  if (activePosition) return { action: 'HOLD' };
  if (!best) return { action: 'HOLD' };

  fhCooldownMap.set(best.coin, now);

  const price = best.item.price;
  const { stop } = fadeHotZone(best.side, price, FADEHOT_STOP_PCT);

  const entryFeatures = {
    entry_spike_pct:      best.move,                          // ход 30м, % (со знаком)
    entry_trend_15m_pct:  best.er * 100,                      // Kaufman ER 4ч ×100 (переиспуск колонки)
    entry_funding_rate:   best.item.fundingRate  ?? null,
    entry_volume_24h_usd: best.item.volume24hUsd ?? null,
    entry_oi_usd:         best.item.oiUsd        ?? null,
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  logger.info(
    `[FadeHot] 🔥 OPEN FADE ${best.side} #${best.coin} @ $${price} ` +
      `| ход30м ${best.move.toFixed(2)}%, ER ${best.er.toFixed(2)} ` +
      `| SL $${stop.toFixed(6)} (${FADEHOT_STOP_PCT}%) / time-stop ${FADEHOT_TIME_STOP_MIN}м`,
  );

  return {
    action:      'OPEN',
    strategy_id: 'fadehot',
    coin:        best.coin,
    price,
    direction:   best.side,
    sl:          stop,
    tp:          null,   // фикс-TP нет — выход по времени/стопу
    move:        best.move,
    er:          best.er,
    entryFeatures,
  };
}

/** Стоп / time-stop для открытой fadehot-позиции (LONG или SHORT). Фикс-TP нет. */
function checkFadeHotExit(position, hunterData, now) {
  const item = (hunterData ?? []).find((x) => x.coin === position.coin);
  if (!item || item.price == null) return { action: 'HOLD' }; // нет свежей цены — ждём тик

  const isLong = (position.side || 'short') === 'long';
  const hitSl = position.sl_price != null && (isLong ? item.price <= position.sl_price : item.price >= position.sl_price);

  if (hitSl) {
    fhPostExitCooldown.set(position.coin, now);
    return { action: 'CLOSE', coin: position.coin, price: position.sl_price, reason: 'fadehot_sl' };
  }
  if (position.entry_time && now - position.entry_time >= FADEHOT_TIME_STOP_MIN * 60_000) {
    fhPostExitCooldown.set(position.coin, now);
    const heldMin = Math.round((now - position.entry_time) / 60_000);
    return { action: 'CLOSE', coin: position.coin, price: item.price, reason: 'fadehot_time_stop', heldMin };
  }
  return { action: 'HOLD' };
}
