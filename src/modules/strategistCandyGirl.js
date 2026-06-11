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
const TG_ENABLED         = config.trading.candyGirlTgEnabled === true;
const ALERT_COOLDOWN_MS  = (config.trading.candyGirlAlertCooldownMin ?? 45) * 60_000;
const MAX_SIGNALS_PER_TICK = config.trading.candyGirlMaxSignalsPerTick ?? 3;
const MAX_RECENT_SIGNALS = 30;

// Lookback: 1h нужно slow+slope (+буфер); 5m нужно ema+pullback (+буфер).
const LOOKBACK_HOURS   = SLOW_1H + SLOPE_LOOKBACK + 5;
const LOOKBACK_MINUTES = (EMA_5M + PULLBACK_LB + 5) * 5;
// 4h: нужно slow4h+slope свечей по 4 часа → в часах ×4 (+буфер).
const LOOKBACK_HOURS_4H = (SLOW_4H + SLOPE_LB_4H + 5) * 4;

// Paper-слот (Iter 2): таймаут удержания = тот же, что у signal-лога; re-entry
// cooldown после exit'а = ALERT_COOLDOWN (анти-churn в ту же монету).
const PAPER_TIMEOUT_MS = SIGNAL_TIMEOUT_MS;
const PAPER_REENTRY_COOLDOWN_MS = ALERT_COOLDOWN_MS;
// Ранжированные хиты живут между сканами; перед открытием убеждаемся, что они с
// текущего тика (radar сканит каждый тик ≈15с) — не торгуем по протухшему скану.
const RANKED_HITS_MAX_AGE_MS = 60_000;

// Per-coin state
const alertCooldown = new Map();   // coin → ts последнего записанного сигнала
const paperReentryCooldown = new Map();  // coin → ts последнего paper-exit'а (анти-churn)
const recentSignals = [];          // ring buffer (новые в начале)
let lastHeartbeat   = null;
let lastHeartbeatAt = 0;
let lastRankedHits  = { ts: 0, hits: [] };  // ранжированные сигналы последнего тика (для paper-слота, Iter 2)

export function resetCandyGirlState() {
  alertCooldown.clear();
  paperReentryCooldown.clear();
  recentSignals.length = 0;
  lastHeartbeat = null;
  lastHeartbeatAt = 0;
  lastRankedHits = { ts: 0, hits: [] };
}

/**
 * Скоринг сигнала для ранжирования ОДНОВРЕМЕННЫХ сетапов (≥2 монеты сигналят в
 * один тик, слот один — берём лучший). Выше = лучше.
 *
 * Приоритет: 4h-confluence (HTF-тренд выровнен с направлением сделки) доминирует —
 * именно он давал +0.16R эдж в shadow-логе. При равном confluence — сила 1h-тренда:
 * относительный разрыв EMA fast/slow (шире = увереннее тренд).
 *
 * @param {{signal:'long'|'short'|null, trend4h?:string, emaFast1h?:number, emaSlow1h?:number}} sig
 * @returns {number}
 */
export function scoreCandySignal(sig) {
  if (!sig || !sig.signal) return -Infinity;
  const aligned =
    (sig.trend4h === 'up'   && sig.signal === 'long') ||
    (sig.trend4h === 'down' && sig.signal === 'short');
  const slow = sig.emaSlow1h;
  const sepPct =
    Number.isFinite(slow) && slow > 0 && Number.isFinite(sig.emaFast1h)
      ? Math.abs(sig.emaFast1h - slow) / slow
      : 0;
  return (aligned ? 1 : 0) + sepPct;
}

/** Ранжированные сигналы последнего скана (для будущего paper-слота). */
export function getCandyGirlRankedHits() {
  return lastRankedHits;
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

async function fireNtfyAlert(coin, direction, entry, sl, tp, price) {
  const { url, topic, token } = config.ntfy;
  if (!url || !topic) return;
  const arrow = direction === 'LONG' ? '▲' : '▼';
  const risk = Math.abs((entry ?? 0) - (sl ?? 0));
  const rr = risk > 0 ? (Math.abs((tp ?? 0) - (entry ?? 0)) / risk).toFixed(1) : '?';
  try {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');
    const body = JSON.stringify({
      topic,
      title: `${arrow} ${direction} #${coin}`,
      message: `@ $${price}\nentry $${entry} · SL $${sl} · TP $${tp} (R:R ${rr})`,
      priority: 4,
      tags: [direction === 'LONG' ? 'green_circle' : 'red_circle'],
    });
    const u = new URL(`${url}/`);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await new Promise((resolve, reject) => {
      const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/', method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    logger.warn(`[CandyGirl] ntfy alert failed: ${err.message}`);
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
    if (TG_ENABLED) {
      fireCandyGirlAlert(
        `🍬 <b>Candy Girl</b> — сетап по тренду\n` +
          `${arrow} <b>#${item.coin}</b> @ $${item.price}\n` +
          `1h-тренд ${direction === 'long' ? 'UP' : 'DOWN'}${htfTxt} · откат к 5m EMA20 + reclaim\n` +
          `entry $${fmt(signal.entry)} · SL $${fmt(signal.sl)} · TP $${fmt(signal.tp)} (R:R ${rrTxt})\n` +
          `👀 сигнал — это РАДАР, бот не входит. Вход и стоп — руками.`,
      );
    }
    fireNtfyAlert(item.coin, entry.direction, signal.entry, signal.sl, signal.tp, item.price);
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

  // Ранжируем одновременные сигналы: лучший = 4h-confluence + сильнее 1h-тренд.
  // Раньше брались первые по порядку scoutData — теперь по score (см.
  // scoreCandySignal). Кап MAX_SIGNALS_PER_TICK теперь режет ХУДШИЕ, а не случайные.
  const hits = results
    .filter((r) => r?.signal?.signal)
    .map((r) => ({ ...r, score: scoreCandySignal(r.signal) }))
    .sort((a, b) => b.score - a.score);
  lastRankedHits = { ts: now, hits };
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

// ─────────────────────────────────────────────────
//  Iter 2 — paper-слот (decision-only, без fetch)
// ─────────────────────────────────────────────────
// analyzeCandyGirl НЕ сканирует — переиспользует ранжированные хиты последнего
// scanCandyGirlRadar (см. getCandyGirlRankedHits) для входа и scoutData для
// текущей цены при exit-check. Оркестрация (вызов executor) — в
// app/candyGirlPaperTick.js. Чистое решение здесь, по конвенции strategist'ов.

/**
 * Exit-check для candy_girl paper-позиции. Sync, без fetch.
 * Time-stop проверяется ПЕРВЫМ (time-based, не требует свежей цены — иначе
 * выпавшая из scoutData монета подвисала бы навсегда, ср. checkTrendFollowExit).
 * SL/TP — по текущей цене из scoutData; если монеты там нет → HOLD.
 */
function checkCandyGirlExit(position, scoutData, now) {
  if (position.entry_time && now - position.entry_time >= PAPER_TIMEOUT_MS) {
    paperReentryCooldown.set(position.coin, now);
    return {
      action: 'CLOSE',
      coin:   position.coin,
      price:  (scoutData ?? []).find((x) => x.coin === position.coin)?.price ?? position.entry_price,
      reason: 'candy_girl_time_stop',
    };
  }

  const item = (scoutData ?? []).find((x) => x.coin === position.coin);
  if (!item) {
    logger.warn(`[CandyGirl] exit-check: #${position.coin} нет в scoutData — SL/TP пропущены, ждём time-stop`);
    return { action: 'HOLD' };
  }

  const isLong = (position.side || '').toLowerCase() === 'long';
  const price  = item.price;

  if (position.sl_price != null) {
    const slHit = isLong ? price <= position.sl_price : price >= position.sl_price;
    if (slHit) {
      paperReentryCooldown.set(position.coin, now);
      return { action: 'CLOSE', coin: position.coin, price: position.sl_price, reason: 'candy_girl_sl' };
    }
  }
  if (position.tp_price != null) {
    const tpHit = isLong ? price >= position.tp_price : price <= position.tp_price;
    if (tpHit) {
      paperReentryCooldown.set(position.coin, now);
      return { action: 'CLOSE', coin: position.coin, price: position.tp_price, reason: 'candy_girl_tp' };
    }
  }
  return { action: 'HOLD' };
}

/**
 * Решение для paper-слота Candy Girl.
 *   • Своя поза → exit-check (SL/TP/time-stop).
 *   • Чужая поза → HOLD (свой слот, по идее не случается).
 *   • Слот свободен → OPEN лучшего ранжированного хита последнего скана
 *     (getCandyGirlRankedHits), если он свежий и монета не на re-entry cooldown.
 *
 * @param {Array<{coin:string, price:number}>} scoutData — для exit-цены
 * @param {Object|null} activePosition — candy_girl paper-позиция (или null)
 * @param {number} [now=Date.now()]
 * @returns {Object} signal: HOLD | OPEN | CLOSE
 */
export function analyzeCandyGirl(scoutData, activePosition, now = Date.now()) {
  if (activePosition?.strategy_id === 'candy_girl') {
    return checkCandyGirlExit(activePosition, scoutData, now);
  }
  if (activePosition) return { action: 'HOLD' };

  // Слот свободен → берём лучший хит свежего скана.
  const ranked = lastRankedHits;
  if (!ranked || now - ranked.ts > RANKED_HITS_MAX_AGE_MS) return { action: 'HOLD' };

  for (const hit of ranked.hits) {
    const { item, signal } = hit;
    if (!signal?.signal || signal.entry == null || signal.sl == null || signal.tp == null) continue;
    const cd = paperReentryCooldown.get(item.coin) ?? 0;
    if (now - cd < PAPER_REENTRY_COOLDOWN_MS) continue;   // анти-churn в ту же монету
    return {
      action:      'OPEN',
      strategy_id: 'candy_girl',
      coin:        item.coin,
      price:       signal.entry,
      direction:   signal.signal.toUpperCase(),
      sl:          signal.sl,
      tp:          signal.tp,
      entryFeatures: {
        entry_trend4h:  signal.trend4h ?? 'none',
        entry_hour_utc: new Date(now).getUTCHours(),
      },
    };
  }
  return { action: 'HOLD' };
}
