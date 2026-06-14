// ─────────────────────────────────────────────────
//  Hot Movers / Signals — multi-window spike scoring
// ─────────────────────────────────────────────────
// Обслуживает Hot Movers (WS-статус) и HTTP /api/signals. Считает спайки по
// нескольким окнам (2m/5m/15m/1h), tier'ы, anti-trend gate, OI-дельты и
// vol-мультипликатор. Тяжёлая сборка кэшируется (TTL 3с) — её зовёт и
// WS-броадкаст (каждые 2с), и /api/status, и /api/signals.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { hlInfo } from "../../../core/hlClient.js";
import { getPriceNMinAgo, getBufferLength } from "../../../core/priceHistory.js";
import { getActivePosition } from "../../../core/database.js";
import { TICK_INTERVAL_MS, state } from "../../../app/state.js";
import {
  HUNTER_SPIKE_PCT,
  HUNTER_SPIKE_WINDOW_MIN,
  HUNTER_SL_PCT,
  HUNTER_TP_PCT,
} from "../../strategistSniper.js";

// ─────────────────────────────────────────────────
//  OI history — ring buffer для oiDelta в /api/signals
// ─────────────────────────────────────────────────
// Снапшот берётся из state.latestHunter каждые 30с.
// Нужно ~20 снапшотов для 15m окна (30с × 30 = 15 мин).
const OI_SNAPSHOT_MS  = 30_000;
const OI_MAX_SNAPS    = 40;   // 20 мин запаса
const _oiHistory      = new Map(); // coin → [{ts, oiUsd}]

export function takeOiSnapshot() {
  const data = state.latestHunter;
  if (!Array.isArray(data) || data.length === 0) return;
  const ts = Date.now();
  for (const item of data) {
    if (item.oiUsd == null) continue;
    let arr = _oiHistory.get(item.coin);
    if (!arr) { arr = []; _oiHistory.set(item.coin, arr); }
    arr.push({ ts, oiUsd: item.oiUsd });
    if (arr.length > OI_MAX_SNAPS) arr.shift();
  }
}

export function getOiNMinAgo(coin, mins, now) {
  const arr = _oiHistory.get(coin);
  if (!arr || arr.length < 2) return null;
  const target = now - mins * 60_000;
  let best = null;
  for (const snap of arr) {
    if (snap.ts <= target) best = snap;
    else break;
  }
  return best?.oiUsd ?? null;
}

// Интервал OI-снапшота — экспортируется для таймера в server.js lifecycle.
export { OI_SNAPSHOT_MS };

// Multi-window spike scoring (Hunter Signals A+B).
// 2m остаётся «нативным» Hunter-окном (бот всё ещё триггерит по нему через
// HUNTER_SPIKE_PCT=5%); здесь пороги ДЛЯ ДАШБОРДА — для ручной торговли —
// специально мягче, чтобы сигналы появлялись регулярно. Tier WEAK (0.6×)
// = «следить», NORMAL (1×) = «торгуемо», STRONG (1.5×) = «уверенный сигнал».
//
// Калибровка 2026-05-08 на спокойном рынке: при 2m≥3%/5m≥4%/15m≥5%/1h≥7%
// в любой момент почти всегда есть 5-15 WEAK-сигналов в скоупе ~65 монет.
const HUNTER_SIGNAL_WINDOWS = [
  { mins: 2, threshold: 3, label: "2m" },
  { mins: 5, threshold: 4, label: "5m" },
  { mins: 15, threshold: 5, label: "15m" },
  { mins: 60, threshold: 7, label: "1h" },
];

const TIER_RANK = { STRONG: 3, NORMAL: 2, WEAK: 1, NEUTRAL: 0 };

function computeTier(absPct, threshold) {
  if (absPct >= threshold * 1.5) return "STRONG";
  if (absPct >= threshold) return "NORMAL";
  if (absPct >= threshold * 0.6) return "WEAK";
  return "NEUTRAL";
}

// Volume multiplier cache for Hot Movers: (5min recent vol) / (avg 5min vol over last hour).
// 2026-05-25: TTL поднят 30s → 120s. Vol-mult — медленный показатель (mean of last hour);
// 30s давал шторм candleSnapshot-запросов с каждого тика дашборда + 429.
const volMultCache = new Map(); // coin -> { ts, mult }
const VOL_MULT_TTL_MS = 120_000;
async function fetchVolMult(coin) {
  const cached = volMultCache.get(coin);
  if (cached && Date.now() - cached.ts < VOL_MULT_TTL_MS) return cached.mult;
  try {
    const stripped = String(coin).replace(/-PERP$/i, "").replace(/^@/, "");
    const hlCoin = /^k[A-Z]/.test(stripped) ? stripped : stripped.toUpperCase();
    const data = await hlInfo(
      {
        type: "candleSnapshot",
        req: { coin: hlCoin, interval: "1m", startTime: Date.now() - 60 * 60_000, endTime: Date.now() },
      },
      { label: "dash/volMult", timeoutMs: 4000, maxRetries: 2 },
    );
    if (!Array.isArray(data) || data.length < 10) {
      volMultCache.set(coin, { ts: Date.now(), mult: null });
      return null;
    }
    const vols = data.map((c) => Number(c.v) || 0);
    const last5 = vols.slice(-5).reduce((a, b) => a + b, 0);
    const total = vols.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      volMultCache.set(coin, { ts: Date.now(), mult: null });
      return null;
    }
    const mult = (last5 * (60 / 5)) / total; // = vol_last_5min / avg_5min_over_hour
    volMultCache.set(coin, { ts: Date.now(), mult });
    return mult;
  } catch {
    volMultCache.set(coin, { ts: Date.now(), mult: null });
    return null;
  }
}

async function enrichVolMult(items) {
  // Параллельный fetch для top N; cache absorb-ит большую часть нагрузки.
  const results = await Promise.allSettled(items.map((it) => fetchVolMult(it.coin)));
  results.forEach((r, i) => {
    items[i].volMult = r.status === "fulfilled" ? r.value : null;
  });
  return items;
}

async function buildMoversPayload(limit = 12) {
  try {
    const data = Array.isArray(state.latestHunter) ? state.latestHunter : [];
    const now = state.latestHunterAt || Date.now();
    const faderTiers = state.latestFader instanceof Map ? state.latestFader : null;
    const trendLookback = config.trading.hunterTrendLookbackMin;
    const trendMaxRise = config.trading.hunterTrendMaxRisePct;
    // Активные монеты для подсветки в Hot Movers: позиция бота + все ручные
    // (HANDS-OFF) позиции. Юзер торгует руками часами — хочет видеть свою
    // монету выделенной во всех лентах (2026-06-09).
    const activeCoin = getActivePosition()?.coin ?? null;
    const activeCoins = new Set(state.manualPositionCoins);
    if (activeCoin) activeCoins.add(activeCoin);

    const ticksNeeded = Math.max(
      2,
      Math.ceil((HUNTER_SPIKE_WINDOW_MIN * 60_000) / TICK_INTERVAL_MS),
    );

    const enriched = data.map((item) => {
      // Считаем спайки по всем окнам.
      const windows = HUNTER_SIGNAL_WINDOWS.map((w) => {
        const past = getPriceNMinAgo(item.coin, w.mins, now);
        if (past == null)
          return { ...w, spikePct: null, tier: null, side: null, ratio: 0 };
        const spikePct = ((item.price - past) / past) * 100;
        const absPct = Math.abs(spikePct);
        const tier = computeTier(absPct, w.threshold);
        const side = spikePct >= 0 ? "SHORT" : "LONG"; // pump → fade short, dump → fade long
        return { ...w, spikePct, tier, side, ratio: absPct / w.threshold };
      });

      // Best signal: STRONG > NORMAL > WEAK; tiebreak — наибольший ratio (насколько выше порога).
      const ranked = windows
        .filter((w) => w.tier && w.tier !== "NEUTRAL")
        .sort(
          (a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.ratio - a.ratio,
        );
      const best = ranked[0] ?? null;

      const trendPast = getPriceNMinAgo(item.coin, trendLookback, now);
      const trendPct =
        trendPast != null ? ((item.price - trendPast) / trendPast) * 100 : null;
      const bufLen = getBufferLength(item.coin);
      const native2m = windows.find((w) => w.mins === HUNTER_SPIKE_WINDOW_MIN);
      return {
        coin: item.coin,
        price: item.price,
        spikePct: native2m?.spikePct ?? null, // обратная совместимость: старое поле = 2m
        windows,
        best,
        trendPct,
        bufLen,
      };
    });

    // Сортировка: best tier rank desc → ratio desc → 2m abs desc (для пустых).
    enriched.sort((a, b) => {
      const aRank = a.best ? TIER_RANK[a.best.tier] : 0;
      const bRank = b.best ? TIER_RANK[b.best.tier] : 0;
      if (bRank !== aRank) return bRank - aRank;
      const aRatio = a.best?.ratio ?? 0;
      const bRatio = b.best?.ratio ?? 0;
      if (bRatio !== aRatio) return bRatio - aRatio;
      const a2 = a.spikePct == null ? -Infinity : Math.abs(a.spikePct);
      const b2 = b.spikePct == null ? -Infinity : Math.abs(b.spikePct);
      return b2 - a2;
    });

    // Гарантируем активные монеты в выдаче. Если позиция затихла (момент упал
    // ниже limit), монета вылетала из top → фронт синтезировал строку из одной
    // цены и весь ряд позиции превращался в «—». Это худший момент терять данные
    // (оператор как раз держит эту монету). Дотягиваем её сюда с полными окнами,
    // даже если по моменту она глубоко внизу (2026-06-14).
    const selected = enriched.slice(0, limit);
    const selectedSet = new Set(selected.map((m) => m.coin));
    for (const m of enriched) {
      if (activeCoins.has(m.coin) && !selectedSet.has(m.coin)) {
        selected.push(m);
        selectedSet.add(m.coin);
      }
    }

    const top = selected.map((m, idx) => {
      let signal = "NEUTRAL";
      let blocked = null;
      let sl = null;
      let tp = null;
      let tier = null;
      let windowLabel = null;
      let windowMin = null;
      let signalSpikePct = null;

      const noHistoryAtAll = m.windows.every((w) => w.spikePct == null);
      if (noHistoryAtAll) {
        signal = "WARMUP";
      } else if (m.best) {
        const b = m.best;
        tier = b.tier;
        windowLabel = b.label;
        windowMin = b.mins;
        signalSpikePct = b.spikePct;
        // SHORT/LONG для NORMAL+ (торгуемое), WATCH для WEAK (только наблюдение).
        if (b.tier === "WEAK") {
          signal = "WATCH";
        } else {
          signal = b.side; // 'SHORT' или 'LONG'
          // Anti-trend gate применяется только к торгуемым тирам.
          if (
            b.side === "SHORT" &&
            m.trendPct != null &&
            m.trendPct >= trendMaxRise
          ) {
            blocked = `trend +${m.trendPct.toFixed(1)}%/${trendLookback}m`;
          } else if (
            b.side === "LONG" &&
            m.trendPct != null &&
            m.trendPct <= -trendMaxRise
          ) {
            blocked = `trend ${m.trendPct.toFixed(1)}%/${trendLookback}m`;
          }
          if (b.side === "SHORT") {
            sl = m.price * (1 + HUNTER_SL_PCT / 100);
            tp = m.price * (1 - HUNTER_TP_PCT / 100);
          } else {
            sl = m.price * (1 - HUNTER_SL_PCT / 100);
            tp = m.price * (1 + HUNTER_TP_PCT / 100);
          }
        }
      }

      const oiNow  = data.find((d) => d.coin === m.coin)?.oiUsd ?? null;
      const oiP5   = getOiNMinAgo(m.coin, 5, now);
      const oiP15  = getOiNMinAgo(m.coin, 15, now);
      const oiDelta5m  = oiNow != null && oiP5  != null && oiP5  > 0 ? ((oiNow - oiP5)  / oiP5)  * 100 : null;
      const oiDelta15m = oiNow != null && oiP15 != null && oiP15 > 0 ? ((oiNow - oiP15) / oiP15) * 100 : null;

      return {
        rank: idx + 1,
        coin: m.coin,
        pair: `${m.coin}/USDC`,
        price: m.price,
        spikePct: m.spikePct, // legacy: 2m спайк
        signalSpikePct, // спайк для выбранного окна
        windowLabel,
        windowMin,
        tier,
        windows: m.windows.map((w) => ({
          label: w.label,
          mins: w.mins,
          threshold: w.threshold,
          spikePct: w.spikePct,
          tier: w.tier,
          side: w.side,
        })),
        trendPct: m.trendPct,
        signal,
        blocked,
        sl,
        tp,
        slPct: sl != null ? HUNTER_SL_PCT : null,
        tpPct: tp != null ? HUNTER_TP_PCT : null,
        bufferLen: m.bufLen,
        bufferNeeded: ticksNeeded,
        isActive: activeCoins.has(m.coin),
        fader: faderTiers?.get(m.coin) ?? null,
        oiDelta5m,
        oiDelta15m,
      };
    });

    // Обогащаем top vol-мультипликатором (≤20 монет; кеш 30с поглощает повторы).
    // + активные монеты, даже если они упали за top-20 — чтобы Vol× позиции не
    // висел «…» в самой важной строке.
    const toEnrich = top.slice(0, 20);
    const enrichSet = new Set(toEnrich.map((m) => m.coin));
    for (const m of top) {
      if (m.isActive && !enrichSet.has(m.coin)) {
        toEnrich.push(m);
        enrichSet.add(m.coin);
      }
    }
    await enrichVolMult(toEnrich);

    return {
      ts: state.latestHunterAt || 0,
      thresholds: {
        spikePct: HUNTER_SPIKE_PCT,
        spikeWindowMin: HUNTER_SPIKE_WINDOW_MIN,
        slPct: HUNTER_SL_PCT,
        tpPct: HUNTER_TP_PCT,
        trendLookbackMin: trendLookback,
        trendMaxRisePct: trendMaxRise,
        windows: HUNTER_SIGNAL_WINDOWS.map((w) => ({
          mins: w.mins,
          threshold: w.threshold,
          label: w.label,
        })),
      },
      universeSize: data.length,
      activeCoin,
      count: top.length,
      signals: top,
      faderEnabled: config.trading.faderEnabled,
    };
  } catch (err) {
    logger.warn(`[Movers] build failed: ${err.message}`);
    return null;
  }
}

// Кэш Hot Movers: WS-броадкаст зовёт каждые 2с — считаем не чаще TTL, чтобы
// тяжёлую сборку (окна по вселенной + enrichVolMult) не гонять на каждый кадр.
// Тот же кэш обслуживает HTTP /api/signals (дедуп compute).
const _moversCache = { ts: 0, limit: null, payload: null };
const MOVERS_CACHE_TTL_MS = 3000;

export async function getMoversPayloadCached(limit = 12) {
  const now = Date.now();
  if (
    _moversCache.payload &&
    _moversCache.limit === limit &&
    now - _moversCache.ts < MOVERS_CACHE_TTL_MS
  ) {
    return _moversCache.payload;
  }
  const payload = await buildMoversPayload(limit);
  if (payload) {
    _moversCache.ts = now;
    _moversCache.limit = limit;
    _moversCache.payload = payload;
  }
  return payload;
}

export async function handleSignals(req, res) {
  try {
    const limit = req.query.limit
      ? Math.max(1, Math.min(300, parseInt(req.query.limit, 10)))
      : 12;
    const payload = await getMoversPayloadCached(limit);
    if (!payload) return res.status(500).json({ error: 'movers build failed' });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
