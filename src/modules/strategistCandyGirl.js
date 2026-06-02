// ─────────────────────────────────────────────────
//  Candy Girl — SIGNAL-ONLY радар (1h EMA-тренд + 5m pullback-reclaim)
// ─────────────────────────────────────────────────
// Codename «Chill Boy 2». План: memory/candy_girl_idea.md.
//
// ⚠️⚠️ Это РАДАР, НЕ торговая стратегия. Он НИКОГДА не открывает позицию и не
// возвращает OPEN — только пишет находку в ленту + (опц.) шлёт TG-алерт. Задача:
// подсветить сетап «тренд по 1h + откат-reclaim по 5m», чтобы оператор собрал 20-30
// РУЧНЫХ сделок по методу из coaching_session_2026_06_01 и валидировал payoff.
//
// Зеркалит радар-половину strategistTrendFollow.js (recordSignal/runScan паттерн),
// но детектор другой (candyGirlEma) и торгового слота нет вообще.
//
// Строгость (анти-фонтан, см. trading_coaching_payoff_leak): дедуп per-coin по
// ALERT_COOLDOWN, подтверждённый наклон EMA200 уже внутри детектора, кап на число
// сигналов за тик. Радар не должен усиливать переторговлю — он редкий.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { detectCandyGirlSignal } from './candyGirlEma.js';
import { getHourlyCandles, getFiveMinCandles, getFourHourCandles } from './candleCache.js';
import {
  recordCandySignal, getOpenCandySignals, resolveCandySignal, getCandySignalStats,
} from '../core/database.js';

export const CANDY_GIRL_HEARTBEAT_MS = 5 * 60_000;

// ── Параметры детектора (env-override через config.trading.candyGirl*) ───────
const FAST_1H        = config.trading.candyGirlFast1h;
const SLOW_1H        = config.trading.candyGirlSlow1h;
const SLOPE_LOOKBACK = config.trading.candyGirlSlopeLookback;
const EMA_5M         = config.trading.candyGirlEma5m;
const PULLBACK_LB    = config.trading.candyGirlPullbackLookback;
const RR             = config.trading.candyGirlRr;

// 4h HTF-confluence
const HTF_CONFLUENCE = config.trading.candyGirlHtfConfluence !== false;
const FAST_4H        = config.trading.candyGirlFast4h ?? 20;
const SLOW_4H        = config.trading.candyGirlSlow4h ?? 50;
const SLOPE_LB_4H    = config.trading.candyGirlSlopeLookback4h ?? 5;

// Signal log / авто-резолв исходов
const SIGNAL_LOG_ENABLED = config.trading.candyGirlSignalLogEnabled !== false;
const SIGNAL_TIMEOUT_MS  = (config.trading.candyGirlSignalTimeoutMin ?? 240) * 60_000;

// Лента/алерты
const ALERT_ENABLED      = config.trading.candyGirlAlertEnabled !== false;
const ALERT_COOLDOWN_MS  = (config.trading.candyGirlAlertCooldownMin ?? 45) * 60_000;
const MAX_SIGNALS_PER_TICK = config.trading.candyGirlMaxSignalsPerTick ?? 3;
const MAX_RECENT_SIGNALS = 30;

// Lookback: 1h нужно slow+slope (+буфер); 5m нужно ema+pullback (+буфер).
const LOOKBACK_HOURS   = SLOW_1H + SLOPE_LOOKBACK + 5;
const LOOKBACK_MINUTES = (EMA_5M + PULLBACK_LB + 5) * 5;
// 4h: нужно slow4h+slope свечей по 4 часа → в часах ×4 (+буфер).
const LOOKBACK_HOURS_4H = (SLOW_4H + SLOPE_LB_4H + 5) * 4;

// Per-coin state
const alertCooldown = new Map();   // coin → ts последнего записанного сигнала
const recentSignals = [];          // ring buffer (новые в начале)
let lastHeartbeat   = null;
let lastHeartbeatAt = 0;

export function resetCandyGirlState() {
  alertCooldown.clear();
  recentSignals.length = 0;
  lastHeartbeat = null;
  lastHeartbeatAt = 0;
}

/** Лента последних обнаруженных сетапов (для dashboard «Candy Girl»). */
export function getCandyGirlSignals() {
  return recentSignals.slice(0, 20);
}

/** Последний снимок состояния детектора (для dashboard). */
export function getCandyGirlHeartbeat() {
  return lastHeartbeat;
}

/**
 * Статистика точности сигналов за окно (для dashboard). null если лог выключен.
 * @param {number} [windowDays=14]
 */
export function getCandyGirlStats(windowDays = 14) {
  if (!SIGNAL_LOG_ENABLED) return null;
  try {
    return getCandySignalStats(Date.now() - windowDays * 86_400_000);
  } catch {
    return null;
  }
}

/**
 * Резолв открытых сигналов: дошёл ли price до TP раньше SL (по 5m-свечам после
 * сигнала). При коллизии в одной свече считаем пессимистично — SL первым (loss).
 * Если за SIGNAL_TIMEOUT_MS не сработало ни то ни другое → timeout.
 *
 * @param {number} [now=Date.now()]
 * @param {Function} [fiveMinFetcher=getFiveMinCandles] — DI для тестов
 */
export async function resolveOpenCandySignals(now = Date.now(), fiveMinFetcher = getFiveMinCandles) {
  if (!SIGNAL_LOG_ENABLED) return;
  let open;
  try { open = getOpenCandySignals(); } catch { return; }
  for (const s of open) {
    const ageMs = now - s.ts;
    const lookbackMin = Math.ceil(ageMs / 60_000) + 10;
    let candles;
    try { candles = await fiveMinFetcher(s.coin, lookbackMin, now); } catch { continue; }
    const after = (candles || []).filter((c) => c.time >= s.ts);

    let outcome = null;
    let price = null;
    const isLong = s.direction === 'LONG';
    for (const c of after) {
      if (isLong) {
        if (c.low <= s.sl)  { outcome = 'loss'; price = s.sl; break; }
        if (c.high >= s.tp) { outcome = 'win';  price = s.tp; break; }
      } else {
        if (c.high >= s.sl) { outcome = 'loss'; price = s.sl; break; }
        if (c.low <= s.tp)  { outcome = 'win';  price = s.tp; break; }
      }
    }
    if (!outcome && ageMs >= SIGNAL_TIMEOUT_MS) {
      outcome = 'timeout';
      price = after.length ? after[after.length - 1].close : s.price;
    }
    if (outcome) resolveCandySignal(s.id, outcome, price, now);
  }
}

/** Lazy-import reporter, чтобы не тянуть axios в юнит-тестах детектора. */
async function fireCandyGirlAlert(text) {
  try {
    const { sendMessage } = await import('./reporter.js');
    await sendMessage(text, false, { bypassThrottle: true });
  } catch (err) {
    logger.warn(`[CandyGirl] TG alert failed: ${err.message}`);
  }
}

/**
 * Записать обнаруженный сетап в ленту + (опц.) TG-алерт. Дедуп per-coin.
 * @param {{item, signal}} r
 * @param {number} now
 */
function recordCandyGirlSignal(r, now) {
  const { item, signal } = r;
  const last = alertCooldown.get(item.coin) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;   // дедуп
  alertCooldown.set(item.coin, now);

  const direction = signal.signal;   // 'long' | 'short'
  const entry = {
    coin:      item.coin,
    direction: direction.toUpperCase(),
    price:     item.price,
    entry:     signal.entry,
    sl:        signal.sl,
    tp:        signal.tp,
    trend4h:   signal.trend4h ?? 'none',
    emaFast1h: signal.emaFast1h,
    emaSlow1h: signal.emaSlow1h,
    ema5m:     signal.ema5m,
    rr:        RR,
    ts:        now,
  };
  recentSignals.unshift(entry);
  if (recentSignals.length > MAX_RECENT_SIGNALS) recentSignals.length = MAX_RECENT_SIGNALS;

  // Лог в БД для замера точности (TP-before-SL резолвится позже трекером).
  if (SIGNAL_LOG_ENABLED) {
    recordCandySignal({
      coin: item.coin, direction: entry.direction, ts: now, price: item.price,
      entry: signal.entry, sl: signal.sl, tp: signal.tp, rr: RR, trend4h: entry.trend4h,
    });
  }

  if (ALERT_ENABLED) {
    const arrow = direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
    const risk = Math.abs(signal.entry - signal.sl);
    const rrTxt = risk > 0 ? (Math.abs(signal.tp - signal.entry) / risk).toFixed(1) : '?';
    const htfTxt = HTF_CONFLUENCE ? ` · 4h ${(entry.trend4h || 'none').toUpperCase()}` : '';
    fireCandyGirlAlert(
      `🍬 <b>Candy Girl</b> — сетап по тренду\n` +
        `${arrow} <b>#${item.coin}</b> @ $${item.price}\n` +
        `1h-тренд ${direction === 'long' ? 'UP' : 'DOWN'}${htfTxt} · откат к 5m EMA20 + reclaim\n` +
        `entry $${fmt(signal.entry)} · SL $${fmt(signal.sl)} · TP $${fmt(signal.tp)} (R:R ${rrTxt})\n` +
        `👀 сигнал — это РАДАР, бот не входит. Вход и стоп — руками.`,
    );
  }
  return true;
}

function fmt(v) {
  return v == null ? '—' : Number(v).toFixed(6);
}

/** Прогон детектора по всему юниверсу. Чистый скан без побочных решений. */
async function performScan(scoutData, now, hourlyFetcher, fiveMinFetcher, fourHourFetcher) {
  const data = scoutData ?? [];
  return Promise.all(
    data.map(async (item) => {
      const candles1h = await hourlyFetcher(item.coin, LOOKBACK_HOURS, now);
      if (!candles1h || candles1h.length < SLOW_1H + SLOPE_LOOKBACK) return null;
      const candles5m = await fiveMinFetcher(item.coin, LOOKBACK_MINUTES, now);
      if (!candles5m || candles5m.length < EMA_5M + PULLBACK_LB + 1) return null;
      // 4h — только если confluence включён (иначе экономим API-квоту).
      const candles4h = HTF_CONFLUENCE
        ? await fourHourFetcher(item.coin, LOOKBACK_HOURS_4H, now)
        : null;

      const sig = detectCandyGirlSignal(candles1h, candles5m, item.price, {
        fast1h: FAST_1H, slow1h: SLOW_1H, slopeLookback: SLOPE_LOOKBACK,
        ema5m: EMA_5M, pullbackLookback: PULLBACK_LB, rr: RR,
        candles4h, fast4h: FAST_4H, slow4h: SLOW_4H, slopeLookback4h: SLOPE_LB_4H,
        htfConfluence: HTF_CONFLUENCE,
      });
      return { item, signal: sig };
    }),
  );
}

function updateHeartbeat(results, tracked, now) {
  const trending = results.filter((r) => r?.signal && r.signal.trend !== 'none').length;
  const hits     = results.filter((r) => r?.signal?.signal).length;
  lastHeartbeat = {
    tracked, trending, signals: hits,
    cooldowns: alertCooldown.size,
    ts: now,
  };
  if (now - lastHeartbeatAt >= CANDY_GIRL_HEARTBEAT_MS) {
    logger.info(
      `[CandyGirl] 💓 tracked=${tracked} trending=${trending} signals=${hits} | cooldowns=${alertCooldown.size}`,
    );
    lastHeartbeatAt = now;
  }
}

/**
 * Радар-скан без торговли. НИКОГДА не открывает позицию — только лента + алерты.
 * Вызывается из тика за флагом config.trading.candyGirlEnabled.
 *
 * @param {Array<{coin:string, price:number}>} scoutData
 * @param {number} [now=Date.now()]
 * @param {Function} [hourlyFetcher=getHourlyCandles] — DI для тестов
 * @param {Function} [fiveMinFetcher=getFiveMinCandles] — DI для тестов
 */
export async function scanCandyGirlRadar(
  scoutData,
  now = Date.now(),
  hourlyFetcher = getHourlyCandles,
  fiveMinFetcher = getFiveMinCandles,
  fourHourFetcher = getFourHourCandles,
) {
  const results = await performScan(scoutData, now, hourlyFetcher, fiveMinFetcher, fourHourFetcher);
  updateHeartbeat(results, scoutData?.length ?? 0, now);

  // Кап на число записанных сигналов за тик (анти-фонтан): берём первые по
  // порядку scoutData, остальные дропаем — дедуп per-coin всё равно их догонит.
  const hits = results.filter((r) => r?.signal?.signal);
  let recorded = 0;
  for (const r of hits) {
    if (recorded >= MAX_SIGNALS_PER_TICK) break;
    if (recordCandyGirlSignal(r, now)) recorded++;
  }

  // Резолв ранее открытых сигналов (TP-before-SL). Ошибки не должны ронять скан.
  try {
    await resolveOpenCandySignals(now, fiveMinFetcher);
  } catch (err) {
    logger.warn(`[CandyGirl] resolve failed: ${err.message}`);
  }
}
