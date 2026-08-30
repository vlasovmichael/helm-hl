// ─────────────────────────────────────────────────
//  Hot Movers / Signals — multi-window spike scoring
// ─────────────────────────────────────────────────
// Обслуживает Hot Movers (WS-статус) и HTTP /api/signals. Считает спайки по
// нескольким окнам (2m/5m/15m/1h), tier'ы, anti-trend gate, OI-дельты и
// vol-мультипликатор. Тяжёлая сборка кэшируется (TTL 3с) — её зовёт и
// WS-броадкаст (каждые 2с), и /api/status, и /api/signals.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";
import { getPriceNMinAgo, getBufferLength, getLatestPrice, getPriceSpark } from "../../../core/priceHistory.js";
import { getActivePosition, getActiveAdoptPositions, getHistory } from "../../../core/database.js";
import { findAsset, getUniverse } from "../../../core/universe.js";
import { getCachedAccountValueSync } from "../../../core/balanceCache.js";
import { TICK_INTERVAL_MS, state } from "../../../app/state.js";
import { computeBreadthFlush } from "../../hotMoversSetup.js";
import { reportBreadthFlush } from "../../../app/toastBridge.js";
import { getHourlyCandles, getFifteenMinCandles } from "../../candleCache.js";
import { classifyTrend } from "../../candyGirlEma.js";
import { analyzeChart } from "../../chartCoach.js";

// ─────────────────────────────────────────────────
//  OI history — буфер вынесен в core/oiHistory.js (2026-06-15)
// ─────────────────────────────────────────────────
// Снапшот берётся из state.latestHunter каждые OI_SNAPSHOT_MS (таймер в
// server.js lifecycle зовёт takeOiSnapshot). getOiNMinAgo/OI_SNAPSHOT_MS
// реэкспортятся отсюда ради старых импортов (server.js, hotMoversAlerts).
import {
  recordOiSnapshot,
  getOiNMinAgo,
  OI_SNAPSHOT_MS,
} from "../../../core/oiHistory.js";

export function takeOiSnapshot() {
  recordOiSnapshot(state.latestHunter);
}

export { OI_SNAPSHOT_MS, getOiNMinAgo };

// Multi-window spike scoring (Hunter Signals A+B).
// 2m остаётся «нативным» Hunter-окном (бот всё ещё триггерит по нему через
// SPIKE_PCT=5%); здесь пороги ДЛЯ ДАШБОРДА — для ручной торговли —
// специально мягче, чтобы сигналы появлялись регулярно. Tier WEAK (0.6×)
// = «следить», NORMAL (1×) = «торгуемо», STRONG (1.5×) = «уверенный сигнал».
//
// Калибровка 2026-05-08 на спокойном рынке: при 2m≥3%/5m≥4%/15m≥5%/1h≥7%
// в любой момент почти всегда есть 5-15 WEAK-сигналов в скоупе ~65 монет.
// Пороги витрины (не стратегии): «сколько процентов за окно считаем движением».
// Спайк-окно 2м — историческое родное окно сканера, на нём же считается MOVE.
const SPIKE_WINDOW_MIN = 2;
const SPIKE_PCT = 5;
// Ориентиры стопа/цели, которые витрина рисует к сетапу (не приказ на вход).
const SETUP_SL_PCT = 2;
const SETUP_TP_PCT = 3;

const SIGNAL_WINDOWS = [
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
// 5 мин (было 2): Vol× — косметика, 5-мин свежести хватает. Главный источник
// 429-бурстов — РОТАЦИЯ топ-листа (новая монета → холодный candleSnapshot);
// длиннее TTL = монета, мелькнувшая в топе, переиспользует кэш вместо нового
// тяжёлого запроса. Это разгружает общий лимит HL, по которому рикошетом
// тормозились торговые чтения (get-positions/balance ловили 429-кулдаун). 2026-06-16.
const VOL_MULT_TTL_MS = 300_000;

// Сколько монет обогащать тяжёлыми candleSnapshot (volMult) + 1h-свечами (htf).
// Дашборд рендерит только HM_MAX_ROWS=8 строк, а раньше enrich-или top-20 → ~12
// тяжёлых запросов на цикл уходили впустую и бурстом ловили 429. Кап = 8 видимых
// + буфер на расхождение серверной (tier/ratio) и фронтовой (momScore) сортировок
// + активные монеты добавляются сверху безусловно (см. ниже). Env-tunable.
const ENRICH_CAP = parseInt(process.env.HOT_MOVERS_ENRICH_CAP || '12', 10);
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
      { label: "dash/volMult", timeoutMs: 4000, maxRetries: 2, priority: HL_PRIORITY.LOW },
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

// ─── HTF-тренд (1h EMA20/200) для гейта fade-сигналов ────────────────────────
// Fade («против движения») валиден только как контр-тренд к старшему тренду.
// Считаем 1h-тренд тем же классификатором, что Candy Girl (classifyTrend), и
// прокидываем 'up'|'down'|'none' на сигнал. computeMomentum (фронт) и
// evaluateSetup (сервер/ntfy) гасят actionable у fade ПО тренду.
// 1h-свечи кэшируются 5 мин в candleCache → доп. _htfCache (60с) лишь срезает
// повторный расчёт EMA на каждый WS-кадр (TTL движков 3с).
const HTF_FAST = config.trading.candyGirlFast1h;
const HTF_SLOW = config.trading.candyGirlSlow1h;
const HTF_SLOPE = config.trading.candyGirlSlopeLookback;
const HTF_LOOKBACK_HOURS = HTF_SLOW + HTF_SLOPE + 5;
const HTF_TTL_MS = 60_000;
const _htfCache = new Map(); // coin → { ts, trend }

export async function getHtfTrend(coin, price, now = Date.now()) {
  const cached = _htfCache.get(coin);
  if (cached && now - cached.ts < HTF_TTL_MS) return cached.trend;
  try {
    const candles1h = await getHourlyCandles(coin, HTF_LOOKBACK_HOURS, now, HL_PRIORITY.LOW);
    const { trend } = classifyTrend(candles1h, price, {
      fast: HTF_FAST,
      slow: HTF_SLOW,
      slopeLookback: HTF_SLOPE,
    });
    _htfCache.set(coin, { ts: now, trend });
    return trend;
  } catch {
    _htfCache.set(coin, { ts: now, trend: "none" });
    return "none";
  }
}

async function enrichHtfTrend(items, now) {
  const results = await Promise.allSettled(
    items.map((it) => getHtfTrend(it.coin, it.price, now)),
  );
  results.forEach((r, i) => {
    items[i].htfTrend = r.status === "fulfilled" ? r.value : "none";
  });
  return items;
}

// enrich=false → строит Hot Movers БЕЗ тяжёлых candleSnapshot (Vol× / HTF-тренд).
// Это путь always-on WS-броадкаста: он крутится каждые 2с пока открыта любая
// вкладка, и его candleSnapshot-шторм выжирал весовой бюджет HL → 429 рикошетом
// в торговые чтения (get-positions/balance). Без enrich payload делает 0 запросов
// к HL (всё из state.latestHunter + priceHistory + oiHistory). Vol×/HTF остаются
// доступны по запросу через /api/signals (enrich=true) для отдельной страницы. 2026-06-17.
async function buildMoversPayload(limit = 12, { enrich = true } = {}) {
  try {
    const data = Array.isArray(state.latestHunter) ? state.latestHunter : [];
    const now = state.latestHunterAt || Date.now();
    const trendLookback = config.trading.trendLookbackMin;
    const trendMaxRise = config.trading.hunterTrendMaxRisePct;
    // Активные монеты для подсветки в Hot Movers: позиция бота + все ручные
    // (HANDS-OFF) позиции. Юзер торгует руками часами — хочет видеть свою
    // монету выделенной во всех лентах (2026-06-09).
    const activeCoin = getActivePosition()?.coin ?? null;
    const activeCoins = new Set(state.manualPositionCoins);
    if (activeCoin) activeCoins.add(activeCoin);
    // Усыновлённые (adopt) позы — отдельный мульти-слот, при adopt монета уходит
    // из manualPositionCoins и не равна main-slot. Без явного пина её строка
    // приходила пустой («—») и не дотягивалась окнами (2026-06-18, см. scout.js).
    for (const p of getActiveAdoptPositions()) activeCoins.add(p.coin);

    const ticksNeeded = Math.max(
      2,
      Math.ceil((SPIKE_WINDOW_MIN * 60_000) / TICK_INTERVAL_MS),
    );

    // Маппер одной монеты в signal-строку. Окна/тренд считаются из priceHistory
    // (независимо от scout-данных) — поэтому строку можно построить даже для
    // монеты, которой нет в scout-вселенной, лишь бы был price-буфер.
    const mapSignal = (item) => {
      // Считаем спайки по всем окнам.
      const windows = SIGNAL_WINDOWS.map((w) => {
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
      const native2m = windows.find((w) => w.mins === SPIKE_WINDOW_MIN);
      return {
        coin: item.coin,
        price: item.price,
        spikePct: native2m?.spikePct ?? null, // обратная совместимость: старое поле = 2m
        windows,
        best,
        trendPct,
        bufLen,
      };
    };

    const enriched = data.map(mapSignal);

    // 🛟 Удерживаемая монета (позиция бота / ручная) могла выпасть из scout-
    // вселенной (low-cap, scope 61↔60) → её не было в `data` → строка в дашборде
    // благовала всеми «—» (фронт синтезировал пустую строку). Это «пропадание
    // активной строки», которое чинили много раз: предыдущие фиксы дотягивали
    // активную монету ТОЛЬКО если она уже в `data`. Здесь добиваем настоящую
    // строку из price-буфера, даже когда scout её не видит (2026-06-16).
    const enrichedCoins = new Set(enriched.map((e) => e.coin));
    for (const coin of activeCoins) {
      if (enrichedCoins.has(coin)) continue;
      const price = getLatestPrice(coin);
      if (price == null) continue; // нет даже price-истории — пусть фронт фолбэкнет
      enriched.push(mapSignal({ coin, price }));
      enrichedCoins.add(coin);
    }

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
            sl = m.price * (1 + SETUP_SL_PCT / 100);
            tp = m.price * (1 - SETUP_TP_PCT / 100);
          } else {
            sl = m.price * (1 - SETUP_SL_PCT / 100);
            tp = m.price * (1 + SETUP_TP_PCT / 100);
          }
        }
      }

      const dItem  = data.find((d) => d.coin === m.coin);
      const oiNow  = dItem?.oiUsd ?? null;
      const vol24h = dItem?.volume24hUsd ?? null;
      // OI / 24h-объём: характер монеты, НЕ таймер. Высокий ратио = позиции
      // залегли при низком обороте (крауд/неликвид → топливо для сквиза). На HL
      // OI>Vol — норма (медиана ~3×), значим только верхний хвост (≳9, верхние
      // 10%). Фронт зажигает пассивный чип по порогу. 2026-06-29.
      const oiVolRatio = oiNow > 0 && vol24h > 0 ? oiNow / vol24h : null;
      const oiP5   = getOiNMinAgo(m.coin, 5, now);
      const oiP15  = getOiNMinAgo(m.coin, 15, now);
      // Гвард oiNow > 0 (не только базы): при мигающем OI==0 у тонких перпов
      // (#IP и ~54 др.) деление выдавало нонсенс −100%/−200%. OI не падает >100%.
      const oiDelta5m  = oiNow > 0 && oiP5  != null && oiP5  > 0 ? ((oiNow - oiP5)  / oiP5)  * 100 : null;
      const oiDelta15m = oiNow > 0 && oiP15 != null && oiP15 > 0 ? ((oiNow - oiP15) / oiP15) * 100 : null;

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
        slPct: sl != null ? SETUP_SL_PCT : null,
        tpPct: tp != null ? SETUP_TP_PCT : null,
        bufferLen: m.bufLen,
        bufferNeeded: ticksNeeded,
        isActive: activeCoins.has(m.coin),
        oiDelta5m,
        oiDelta15m,
        oiUsd: oiNow,
        vol24hUsd: vol24h,
        oiVolRatio,
        // Спарклайн: даунсэмпл цены за 20 мин в ≤24 точки (last-цена корзины).
        // Из in-memory буфера — НИ ОДНОГО запроса к HL, поэтому едет и в cheap
        // WS-броадкасте (каждые 2с). Фронт рисует SVG, если точек ≥2.
        spark: getPriceSpark(m.coin, 20, 24, now),
        htfTrend: null, // заполняется enrichHtfTrend (1h EMA-тренд) для fade-гейта
      };
    });

    // htfTrend (1h EMA-тренд): ВСЕГДА, и в cheap WS-броадкасте (каждые 2с) —
    // нужен на карточке пассивным тегом направления, чтобы не входить против
    // старшего тренда (главный леак). Дёшево: per-coin кэш 60с (HTF_TTL_MS) +
    // LOW-приоритет, top-N + активные. Тот же приём, что у enrichFadeHot.
    {
      const htfTargets = top.slice(0, ENRICH_CAP);
      const htfSet = new Set(htfTargets.map((m) => m.coin));
      for (const m of top) {
        if (m.isActive && !htfSet.has(m.coin)) {
          htfTargets.push(m);
          htfSet.add(m.coin);
        }
      }
      await enrichHtfTrend(htfTargets, now);
    }

    // Vol× тяжелее (нет дешёвого пре-гейта) — только enriched (/api/signals).
    // + активные монеты, даже если упали за кап — чтобы Vol× позиции не висел «…».
    if (enrich) {
      const toEnrich = top.slice(0, ENRICH_CAP);
      const enrichSet = new Set(toEnrich.map((m) => m.coin));
      for (const m of top) {
        if (m.isActive && !enrichSet.has(m.coin)) {
          toEnrich.push(m);
          enrichSet.add(m.coin);
        }
      }
      await enrichVolMult(toEnrich);
    }

    // Fade-high-ER forward-вердикт: считаем ВСЕГДА (и в cheap WS-броадкасте) —
    // дешёвый пре-гейт по ходу 30м делает его near-zero-cost в спокойном рынке
    // (0 монет проходят → 0 fetch), а сам сигнал нужен на always-on карточке, не
    // только на /api/signals. Кап = ENRICH_CAP видимых строк.

    // Breadth-слив: синхронный делевередж лидеров движения (OI↓ у многих) →
    // fade против движения = лов ножа. Клиент гасит actionable у таких вердиктов.
    const marketFlush = computeBreadthFlush(top);
    // Тост на дашборде по фронту flush (edge-trigger + кулдаун внутри). Этот роут
    // поллит открытый дашборд → сигнал приходит ровно когда ты смотришь. Без телефона.
    reportBreadthFlush(marketFlush);

    return {
      ts: state.latestHunterAt || 0,
      thresholds: {
        spikePct: SPIKE_PCT,
        spikeWindowMin: SPIKE_WINDOW_MIN,
        slPct: SETUP_SL_PCT,
        tpPct: SETUP_TP_PCT,
        trendLookbackMin: trendLookback,
        trendMaxRisePct: trendMaxRise,
        windows: SIGNAL_WINDOWS.map((w) => ({
          mins: w.mins,
          threshold: w.threshold,
          label: w.label,
        })),
      },
      universeSize: data.length,
      activeCoin,
      marketFlush,
      count: top.length,
      signals: top,
    };
  } catch (err) {
    logger.warn(`[Movers] build failed: ${err.message}`);
    return null;
  }
}

// Кэш Hot Movers: WS-броадкаст зовёт каждые 2с — считаем не чаще TTL, чтобы
// тяжёлую сборку (окна по вселенной + enrichVolMult) не гонять на каждый кадр.
// Тот же кэш обслуживает HTTP /api/signals (дедуп compute).
// Раздельный кэш для enriched/cheap — у них разная стоимость и разные
// потребители (broadcast зовёт cheap, /api/signals — enriched).
const _moversCache = {
  true:  { ts: 0, limit: null, payload: null },
  false: { ts: 0, limit: null, payload: null },
};
const MOVERS_CACHE_TTL_MS = 3000;

export async function getMoversPayloadCached(limit = 12, enrich = true) {
  const now = Date.now();
  const slot = _moversCache[enrich ? "true" : "false"];
  if (
    slot.payload &&
    slot.limit === limit &&
    now - slot.ts < MOVERS_CACHE_TTL_MS
  ) {
    return slot.payload;
  }
  const payload = await buildMoversPayload(limit, { enrich });
  if (payload) {
    slot.ts = now;
    slot.limit = limit;
    slot.payload = payload;
  }
  return payload;
}

// ─── /api/whatif — кнопка-тормоз «а что если» по одной монете ────────────────
// Юзер вводит монету (+опц. направление) → применяем боевое правило fade-high-ER
// + гейт режима к ней по запросу и говорим: гладит эдж задуманный вход или по
// шапке. НЕ генератор сигналов — дисциплинарный чек против существующего эджа.
// Дефолт (нет fired-сетапа) = «сиди на руках». Read-only, тяжёлый 15m-fetch
// только на явный запрос (не в броадкасте), поэтому без пре-гейта.
// Учёба на ТВОЕЙ истории: из последних закрытых сделок считаем, насколько
// глубоко уходят в минус убыточные трипы (avg |MAE|) и payoff (avg win / avg
// loss). Большой MAE у лузеров = «стопа не было». Это не про монету — это
// зеркало привычки (главный леак, см. trading_coaching_payoff_leak в памяти).
function computeSelfLeak(limit = 60) {
  try {
    const rows = getHistory(limit);
    if (!Array.isArray(rows) || rows.length < 5) return null;
    const losers = rows.filter((r) => r.realized_pnl < 0);
    const winners = rows.filter((r) => r.realized_pnl > 0);
    if (losers.length === 0) return null;
    const maeVals = losers.map((r) => r.mae_pct).filter((v) => v != null && Number.isFinite(v));
    const avgLoserMae = maeVals.length
      ? maeVals.reduce((a, b) => a + Math.abs(b), 0) / maeVals.length : null;
    const avgWin = winners.length
      ? winners.reduce((a, b) => a + b.realized_pnl, 0) / winners.length : null;
    const avgLoss = losers.length
      ? losers.reduce((a, b) => a + Math.abs(b.realized_pnl), 0) / losers.length : null;
    const payoff = avgWin != null && avgLoss > 0 ? avgWin / avgLoss : null;
    const winRate = (winners.length / rows.length) * 100;

    let note;
    if (avgLoserMae != null && avgLoserMae >= 6)
      note = `Твои минусовые трипы в среднем доходят до −${avgLoserMae.toFixed(1)}% (MAE) — это «стоп не стоял». Поставь стоп ДО входа.`;
    else if (payoff != null && payoff < 1)
      note = `Payoff ${payoff.toFixed(2)}× — средний плюс меньше среднего минуса. Тяни прибыль / режь убыток быстрее.`;
    else
      note = `Дисциплина по истории в норме: payoff ${payoff != null ? payoff.toFixed(2) + "×" : "—"}, MAE лузеров −${avgLoserMae != null ? avgLoserMae.toFixed(1) : "—"}%.`;

    return {
      n: rows.length,
      winRate: Math.round(winRate),
      avgLoserMaePct: avgLoserMae != null ? Math.round(avgLoserMae * 10) / 10 : null,
      payoff: payoff != null ? Math.round(payoff * 100) / 100 : null,
      note,
    };
  } catch {
    return null;
  }
}

export async function handleWhatIf(req, res) {
  try {
    const coin = String(req.query.coin || "")
      .trim().toUpperCase()
      .replace(/-PERP$/i, "").replace(/USDT$|USDC$/i, "").replace(/^@/, "");
    if (!coin) return res.status(400).json({ error: "coin required" });

    let userSide = req.query.side ? String(req.query.side).trim().toUpperCase() : null;
    if (userSide !== "LONG" && userSide !== "SHORT") userSide = null;

    // Validate against the loaded universe BEFORE any HL fetch — fail fast on a
    // typo / non-existent coin instead of spending a candleSnapshot on it. Guard
    // on getUniverse().length so a not-yet-loaded universe (cold start) falls
    // through to the fetch path rather than rejecting every coin.
    if (getUniverse().length > 0 && !findAsset(coin)) {
      return res.status(404).json({ error: `No Hyperliquid market for #${coin}`, coin });
    }

    const now = Date.now();
    let candles = null;
    try {
      candles = await getFifteenMinCandles(coin, 100 * 15, now);
    } catch { candles = null; }
    if (!candles || candles.length < 30) {
      return res.status(404).json({
        error: `No 15m candles for #${coin} — it may not be listed on Hyperliquid`,
        coin,
      });
    }

    const price = getLatestPrice(coin) ?? candles[candles.length - 1]?.close ?? null;

    // Coach: честный РАЗБОР графика (тренд/уровни/RSI/план), независимо от
    // fade-эджа. 1h-свечи для старшего тренда (ema 20/50 → нужно ≥51). Падение
    // тут не критично — coach просто будет null, остальной вердикт остаётся.
    let coach = null;
    try {
      // 1h-серия для старшего тренда (ema 20/50 → нужно ≥51 свечи).
      const [coach15m, candles1h, volMult] = await Promise.all([
        getFifteenMinCandles(coin, 100 * 15, now),
        getHourlyCandles(coin, 60, now, HL_PRIORITY.LOW),
        fetchVolMult(coin),
      ]);

      // Order-flow вход: OI-дельта 15м, объём, funding — из живого state/буфера.
      const liveItem = (Array.isArray(state.latestHunter) ? state.latestHunter : [])
        .find((it) => it.coin === coin);
      const curOi = liveItem?.oiUsd ?? null;
      const oiAgo = getOiNMinAgo(coin, 15, now);
      const oiDeltaPct = curOi != null && oiAgo != null && oiAgo > 0
        ? ((curOi - oiAgo) / oiAgo) * 100 : null;
      const past30 = getPriceNMinAgo(coin, 30, now);
      const priceMovePct = past30 != null && past30 > 0 ? ((price - past30) / past30) * 100 : null;
      const flow = { oiDeltaPct, volMult, funding: liveItem?.fundingRate ?? null, priceMovePct };

      coach = analyzeChart({
        candles15m: coach15m || candles, candles1h, price, userSide,
        equity: getCachedAccountValueSync(),
        riskBudgetPct: 1, // 1% депо на сделку — учим риск-сначала
        flow,
      });
      if (coach?.ok) coach.learn = computeSelfLeak(); // учёба на твоей истории
    } catch (e) {
      logger.debug(`[Dashboard] coach analyze failed #${coin}: ${e.message}`);
    }

    res.json({
      coin, price, userSide,
      coach,   // разбор графика (см. chartCoach.js) — единственное наполнение модалки
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/whatif error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
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
