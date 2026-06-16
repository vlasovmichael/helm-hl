// ─────────────────────────────────────────────────
//  Strategy: Setup Swing paper — торгует вердикт карточки Swing 1:1
// ─────────────────────────────────────────────────
// Идея (оператор 2026-06-17): бот торгует карточку «Setup Scanner · Swing» так же,
// как оператор читает её руками. Карточка (setupScannerSwing.js) уже отдаёт per-coin
// вердикт LONG/SHORT/WAIT + entry-зону (1h EMA20) + готовый план входа
// plan{sl,tp} (стоп за 1h slow-EMA = инвалидация тренда, таргет 2R). Берём это
// 1:1 — план карточки и есть наш выход.
//
// Вход = directional-сигнал свинга (LONG/SHORT) + есть plan + СВЕЖЕЕ Candy Girl
// 5m-подтверждение в ту же сторону (findCandyConfirm) — это слой тайминга входа,
// которым оператор пользуется руками: одна 1h-зона ≠ вход, ждём «🍬 reclaim
// напечатался». Без candy НЕ входим (фикс 2026-06-17: бот зашёл ZEC LONG по зоне
// при 🍬 WAIT). Edge-trigger по появлению candy. Свинг — медленный ТФ (4h/1h),
// поэтому тяжёлый агрегат getSetupScannerRows троттлим (60с); выход
// (SL/TP/time-stop) проверяем каждый тик по живой цене.
//
// Слот: независимый paper-слот strategy_id='swing', одна поза за раз,
// сосуществует с hunter/adopt/hotmovers/vapor (мультислот). Размер — от реального
// paper-баланса. PROD-пути нет. ≥20 сделок до оценки эджа.

import { logger } from '../core/logger.js';
import { getSetupScannerRows } from '../core/database.js';
import { enrichSwingSignals, findCandyConfirm } from './setupScannerSwing.js';
import { getCandyGirlSignals } from './strategistCandyGirl.js';

// ── Параметры (env-overrideable) ──
export const SWING_EVAL_INTERVAL_MS    = parseInt(process.env.SWING_PAPER_EVAL_INTERVAL_SEC || '60', 10) * 1_000;
export const SWING_TIME_STOP_HOURS     = parseFloat(process.env.SWING_PAPER_TIME_STOP_HOURS || '72');
export const SWING_POST_EXIT_COOLDOWN_MS = parseInt(process.env.SWING_PAPER_POST_EXIT_COOLDOWN_MIN || '240', 10) * 60_000;
const SWING_HEARTBEAT_MS               = 10 * 60_000;

// Per-coin state (in-memory; paper-эксперимент).
const prevByCoin         = new Map(); // coin → actionable-key ('LONG:zone'|'SHORT:zone'|'none')
const swingPostExitCooldown = new Map(); // coin → last-exit ts
let lastEvalAt = 0;
let lastHeartbeatAt = 0;

/** Тестовый сброс состояния. */
export function resetSwingState() {
  prevByCoin.clear();
  swingPostExitCooldown.clear();
  lastEvalAt = 0;
  lastHeartbeatAt = 0;
}

/** Цена по монете из живого снапшота бота. */
function priceMapOf(hunterData) {
  const m = new Map();
  for (const it of hunterData ?? []) {
    if (it?.coin && it.price != null) m.set(it.coin, it.price);
  }
  return m;
}

/**
 * Actionable-ключ строки: directional-сигнал свинга + готовый план + СВЕЖЕЕ
 * Candy Girl 5m-подтверждение в ту же сторону (слой тайминга входа — оператор входит
 * руками только по нему, не по одной 1h-зоне; см. findCandyConfirm). Триггером
 * делаем именно candy: если 🍬 печатается, когда монета уже в зоне, ключ
 * переходит none→go и edge-trigger срабатывает.
 * @returns {'LONG:go'|'SHORT:go'|'none'}
 */
function actionableKey(swing, candy) {
  if (!swing) return 'none';
  const { signal, plan } = swing;
  if ((signal === 'LONG' || signal === 'SHORT') && plan && candy) {
    return `${signal}:go`;
  }
  return 'none';
}

/**
 * Чистый выбор кандидата на вход из обогащённых строк. Мутирует prevByCoin для
 * ВСЕХ монет (честный edge-trigger). Возвращает лучшего по strength или null.
 *
 * @param {Array<{coin, mark, fundingRate, vol24hUsd, oiUsd, oi7d, swing}>} enriched
 * @param {Map<string,number>} priceByCoin — живые цены (fallback на mark)
 * @param {Array<{coin, direction, ts}>} candySignals — лента Candy Girl (newest-first)
 * @param {number} now
 */
export function selectSwingCandidate(enriched, priceByCoin, candySignals, now) {
  let best = null;
  for (const r of enriched ?? []) {
    const candy = findCandyConfirm(r.coin, r.swing?.signal, candySignals, now);
    const key = actionableKey(r.swing, candy);
    const prev = prevByCoin.get(r.coin);
    prevByCoin.set(r.coin, key);

    if (key === 'none') continue;
    if (prev === key) continue; // держится — не повторяем (edge-trigger)
    if (now - (swingPostExitCooldown.get(r.coin) ?? 0) < SWING_POST_EXIT_COOLDOWN_MS) continue;

    const price = priceByCoin.get(r.coin) ?? r.mark;
    if (price == null || !(price > 0)) continue;
    const strength = r.swing.strength ?? 0;
    if (!best || strength > best.strength) {
      best = { coin: r.coin, price, direction: r.swing.signal, swing: r.swing, row: r, strength, candy };
    }
  }
  return best;
}

/**
 * Главный анализ Setup Swing paper.
 * @param {Array<{coin:string, price:number}>} hunterData — живой снапшот цен
 * @param {Object|null} activePosition — swing paper-поза
 * @param {number} [now=Date.now()]
 * @returns {Object} { action:'HOLD' }
 *   | { action:'OPEN', strategy_id:'swing', coin, price, direction, sl, tp, entryFeatures }
 *   | { action:'CLOSE', coin, price, reason }
 */
export function analyzeSwing(hunterData, activePosition, now = Date.now()) {
  const priceByCoin = priceMapOf(hunterData);

  // ── Выход: своя поза → SL/TP/time-stop (каждый тик, дёшево) ──
  if (activePosition?.strategy_id === 'swing') {
    return checkSwingExit(activePosition, priceByCoin, now);
  }

  // ── Вход: тяжёлый агрегат троттлим (свинг — медленный ТФ) ──
  if (now - lastEvalAt < SWING_EVAL_INTERVAL_MS) return { action: 'HOLD' };
  lastEvalAt = now;

  let enriched;
  try {
    enriched = enrichSwingSignals(getSetupScannerRows(), now);
  } catch (err) {
    logger.warn(`[Swing] eval failed: ${err.message}`);
    return { action: 'HOLD' };
  }

  const candySignals = getCandyGirlSignals();
  const best = selectSwingCandidate(enriched, priceByCoin, candySignals, now);

  if (now - lastHeartbeatAt >= SWING_HEARTBEAT_MS) {
    const directional = (enriched ?? []).filter((r) => r.swing?.signal === 'LONG' || r.swing?.signal === 'SHORT').length;
    logger.info(`[Swing] 📐 rows=${(enriched ?? []).length} | directional=${directional} | 🍬=${candySignals.length} | slot=IDLE`);
    lastHeartbeatAt = now;
  }

  if (!best) return { action: 'HOLD' };

  const { sl, tp } = best.swing.plan;
  const entryFeatures = {
    entry_spike_pct:      best.swing.strength ?? null, // сила свинг-сигнала
    entry_trend_1h_pct:   best.swing.ext1h ?? null,    // растяжка от 1h EMA20
    entry_funding_rate:   best.row.fundingRate ?? null,
    entry_volume_24h_usd: best.row.vol24hUsd ?? null,
    entry_oi_usd:         best.row.oiUsd ?? null,
    entry_hour_utc:       new Date(now).getUTCHours(),
  };

  logger.info(
    `[Swing] 🎯 OPEN ${best.direction} #${best.coin} @ $${best.price} ` +
      `| 4h${best.swing.trend4h ?? '?'} 1h${best.swing.trend1h ?? '?'}, strength ${best.strength.toFixed(1)}, ` +
      `🍬 ${best.candy?.ageMin ?? '?'}m | SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} (R:R ${best.swing.plan.rr})`,
  );

  return {
    action:      'OPEN',
    strategy_id: 'swing',
    coin:        best.coin,
    price:       best.price,
    direction:   best.direction,
    sl, tp,
    entryFeatures,
  };
}

/** SL/TP/time-stop для открытой swing-позиции (LONG или SHORT). */
function checkSwingExit(position, priceByCoin, now) {
  const price = priceByCoin.get(position.coin);
  if (price == null) return { action: 'HOLD' }; // нет свежей цены — ждём тик

  const isLong = (position.side || 'short') === 'long';
  const hitSl = position.sl_price != null && (isLong ? price <= position.sl_price : price >= position.sl_price);
  const hitTp = position.tp_price != null && (isLong ? price >= position.tp_price : price <= position.tp_price);

  if (hitSl) {
    swingPostExitCooldown.set(position.coin, now);
    return { action: 'CLOSE', coin: position.coin, price: position.sl_price, reason: 'swing_sl' };
  }
  if (hitTp) {
    swingPostExitCooldown.set(position.coin, now);
    return { action: 'CLOSE', coin: position.coin, price: position.tp_price, reason: 'swing_tp' };
  }
  if (position.entry_time && now - position.entry_time >= SWING_TIME_STOP_HOURS * 3_600_000) {
    swingPostExitCooldown.set(position.coin, now);
    const heldH = Math.round((now - position.entry_time) / 3_600_000);
    return { action: 'CLOSE', coin: position.coin, price, reason: 'swing_time_stop', heldH };
  }
  return { action: 'HOLD' };
}
