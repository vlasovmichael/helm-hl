// ─────────────────────────────────────────────────
//  Levels — механические уровни поддержки и сопротивления
// ─────────────────────────────────────────────────
// Уровень считается машиной по фиксированному правилу, поэтому два запроса на
// одних свечах дают одни и те же линии. Источники: фрактальные свинги, границы
// прошлой сессии UTC, профиль объёма (POC/VAH/VAL) и круглые числа. Тонкие
// коридоры профиля и связь с BTC идут рядом как контекст, зонами не становятся.
//
// 🚨 Уровень здесь — не сигнал входа: ни один из источников не проверен
// форвардом. Он нужен как место для стопа и цели, чтобы плечо риска считалось
// числом, а не глазом.

import { getFifteenMinCandles, getHourlyCandles, getFourHourCandles, getDeepCandles } from "../../candleCache.js";
import { EMA_PERIOD, ema } from "../web/src/features/levelMath.js";
import { findAsset, getUniverse } from "../../../core/universe.js";
import { recordLevelRead } from "../../levelReads.js";
import { levelsOi } from "./levelsOi.js";

// Окно на таймфрейм: столько баров хватает для свингов и профиля, но не
// заставляет HL отдавать историю, которую всё равно никто не смотрит.
const FRAMES = {
  "15m": { bars: 288, load: (coin) => getFifteenMinCandles(coin, 288 * 15) },
  "1h": { bars: 480, load: (coin) => getHourlyCandles(coin, 480) },
  "4h": { bars: 360, load: (coin) => getFourHourCandles(coin, 360 * 4) },
};

// Прогрев EMA до окна: через три периода вклад затравки меньше процента.
const EMA_WARM_BARS = EMA_PERIOD * 3;
const SWING_WING = 5; // баров по каждую сторону от вершины фрактала
const PROFILE_BINS = 64;
const VALUE_AREA = 0.7; // доля объёма внутри области стоимости, стандарт профиля
const MERGE_ATR = 0.35; // ближе этой доли ATR уровни считаются одной зоной
const TOUCH_GAP_BARS = 3; // столько баров вне зоны разделяют два касания
const THIN_SHARE = 0.5; // бин тоньше этой доли меньшей из соседних полок — тонкий объём
const THIN_MIN_BINS = 3; // коридор уже этого — шум профиля, а не провал
// Окна хода для строки BTC: в барах своего ТФ.
const MOVE_WINDOWS = {
  "15m": [["1h", 4], ["4h", 16]],
  "1h": [["1h", 1], ["4h", 4]],
  "4h": [["4h", 1], ["24h", 6]],
};
const HOUR_MS = 3_600_000;
// Те же окна для OI, в миллисекундах: история OI живёт не в барах, а в снимках.
const OI_WINDOWS = {
  "15m": [["1h", HOUR_MS], ["4h", 4 * HOUR_MS]],
  "1h": [["1h", HOUR_MS], ["4h", 4 * HOUR_MS]],
  "4h": [["4h", 4 * HOUR_MS], ["24h", 24 * HOUR_MS]],
};

/** Средний размах бара — единица допуска для склейки зон и ширины полосы. */
function atr(candles, period = 14) {
  const tail = candles.slice(-period);
  if (!tail.length) return 0;
  const sum = tail.reduce((acc, c) => acc + (c.high - c.low), 0);
  return sum / tail.length;
}

/** Фрактальные вершины: бар выше (ниже) своих соседей по SWING_WING с каждой стороны. */
function swings(candles) {
  const out = [];
  for (let i = SWING_WING; i < candles.length - SWING_WING; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - SWING_WING; j <= i + SWING_WING; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ price: c.high, kind: "swing", at: c.time });
    if (isLow) out.push({ price: c.low, kind: "swing", at: c.time });
  }
  return out;
}

/** Максимум, минимум и закрытие прошлых суток UTC. */
function priorDay(candles) {
  if (!candles.length) return [];
  const lastTs = candles[candles.length - 1].time;
  const dayMs = 86_400_000;
  const todayStart = Math.floor(lastTs / dayMs) * dayMs;
  const prev = candles.filter((c) => c.time >= todayStart - dayMs && c.time < todayStart);
  if (!prev.length) return [];
  const high = Math.max(...prev.map((c) => c.high));
  const low = Math.min(...prev.map((c) => c.low));
  return [
    { price: high, kind: "pdh", at: todayStart },
    { price: low, kind: "pdl", at: todayStart },
  ];
}

/**
 * Профиль объёма: объём бара раскладывается поровну по его диапазону.
 * POC — самый наторгованный бин, VAH/VAL — границы области стоимости.
 */
function volumeProfile(candles) {
  const withVol = candles.filter((c) => Number.isFinite(c.vol) && c.vol > 0);
  if (withVol.length < 20) return { levels: [], bins: [], step: 0 };

  const lo = Math.min(...withVol.map((c) => c.low));
  const hi = Math.max(...withVol.map((c) => c.high));
  if (!(hi > lo)) return { levels: [], bins: [], step: 0 };

  const step = (hi - lo) / PROFILE_BINS;
  const bins = new Array(PROFILE_BINS).fill(0);
  for (const c of withVol) {
    const from = Math.max(0, Math.floor((c.low - lo) / step));
    const to = Math.min(PROFILE_BINS - 1, Math.floor((c.high - lo) / step));
    const share = c.vol / (to - from + 1);
    for (let i = from; i <= to; i++) bins[i] += share;
  }

  const total = bins.reduce((a, b) => a + b, 0);
  let poc = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[poc]) poc = i;

  // Область стоимости растёт от POC в сторону более объёмного соседа.
  let lower = poc;
  let upper = poc;
  let acc = bins[poc];
  while (acc < total * VALUE_AREA && (lower > 0 || upper < bins.length - 1)) {
    const down = lower > 0 ? bins[lower - 1] : -1;
    const up = upper < bins.length - 1 ? bins[upper + 1] : -1;
    if (up >= down) acc += bins[++upper];
    else acc += bins[--lower];
  }

  const mid = (i) => lo + step * (i + 0.5);
  return {
    step,
    levels: [
      { price: mid(poc), kind: "poc" },
      { price: mid(upper), kind: "vah" },
      { price: mid(lower), kind: "val" },
    ],
    bins: bins.map((v, i) => ({ price: mid(i), vol: v })),
  };
}

/**
 * Тонкие коридоры: провал между двумя соседними полками профиля. Полка — локальная
 * вершина не ниже среднего бина; тонкий бин — тоньше THIN_SHARE меньшей из двух полок.
 * Края профиля не в счёт: там объём тонкий по построению.
 */
export function thinCorridors(bins, step) {
  if (!bins?.length || !(step > 0)) return [];
  const vols = bins.map((b) => b.vol);
  const total = vols.reduce((a, b) => a + b, 0);
  const mean = total / vols.length;
  const peaks = [];
  for (let i = 0; i < vols.length; i++) {
    const left = i > 0 ? vols[i - 1] : -Infinity;
    const right = i < vols.length - 1 ? vols[i + 1] : -Infinity;
    if (vols[i] >= mean && vols[i] >= left && vols[i] > right) peaks.push(i);
  }
  const out = [];
  for (let k = 1; k < peaks.length; k++) {
    const a = peaks[k - 1];
    const b = peaks[k];
    const floor = Math.min(vols[a], vols[b]) * THIN_SHARE;
    let from = -1;
    for (let i = a + 1; i <= b; i++) {
      const thin = i < b && vols[i] < floor;
      if (thin && from < 0) from = i;
      if (!thin && from >= 0) {
        if (i - from >= THIN_MIN_BINS) {
          const share = vols.slice(from, i).reduce((x, y) => x + y, 0) / total;
          out.push({ lo: bins[from].price - step / 2, hi: bins[i - 1].price + step / 2, share });
        }
        from = -1;
      }
    }
  }
  return out;
}

/**
 * Ход монеты и BTC по окнам, корреляция и бета доходностей баров.
 * Бары сводятся по времени: пропуск у одной стороны не сдвигает другую.
 */
export function btcLink(coinBars, btcBars, windows) {
  const btcAt = new Map(btcBars.map((c) => [c.time, c.close]));
  const pairs = [];
  for (let i = 1; i < coinBars.length; i++) {
    const a0 = coinBars[i - 1];
    const a1 = coinBars[i];
    const b0 = btcAt.get(a0.time);
    const b1 = btcAt.get(a1.time);
    if (a0.close > 0 && b0 > 0 && b1 > 0) pairs.push([a1.close / a0.close - 1, b1 / b0 - 1]);
  }
  if (pairs.length < 20) return null;
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const change = (bars, k) => {
    const last = bars[bars.length - 1]?.close;
    const prev = bars[bars.length - 1 - k]?.close;
    return last > 0 && prev > 0 ? (last / prev - 1) * 100 : NaN;
  };
  return {
    corr: sxy / Math.sqrt(sxx * syy),
    beta: sxy / syy,
    windows: windows.map(([label, k]) => ({ label, coin: change(coinBars, k), btc: change(btcBars, k) })),
  };
}

/** Круглые числа в окне цены: шаг — ближайшая степень десяти от размаха. */
function roundNumbers(lo, hi) {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const step = Math.pow(10, Math.floor(Math.log10(span)));
  const out = [];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    out.push({ price: p, kind: "round" });
  }
  return out.length <= 12 ? out : [];
}

/**
 * Склейка близких уровней в зоны и подсчёт касаний.
 * Касание — отдельный заход цены в полосу зоны; заходы подряд не считаются
 * дважды, между ними должно быть TOUCH_GAP_BARS баров вне полосы.
 */
function toZones(raw, candles, tol) {
  const sorted = [...raw].filter((l) => Number.isFinite(l.price)).sort((a, b) => a.price - b.price);
  const zones = [];
  for (const lvl of sorted) {
    const last = zones[zones.length - 1];
    if (last && lvl.price - last.price <= tol) {
      last.price = (last.price * last.sources.length + lvl.price) / (last.sources.length + 1);
      if (!last.sources.includes(lvl.kind)) last.sources.push(lvl.kind);
    } else {
      zones.push({ price: lvl.price, sources: [lvl.kind] });
    }
  }

  const half = tol / 2;
  for (const z of zones) {
    const band = [z.price - half, z.price + half];
    let touches = 0;
    let outside = TOUCH_GAP_BARS;
    for (const c of candles) {
      const inside = c.high >= band[0] && c.low <= band[1];
      if (inside) {
        if (outside >= TOUCH_GAP_BARS) touches++;
        outside = 0;
      } else outside++;
    }
    z.touches = touches;
    z.lo = band[0];
    z.hi = band[1];
  }
  return zones;
}

/** Сила зоны: касания плюс вес за то, что её подтверждает несколько источников. */
function strength(z) {
  return z.touches + (z.sources.length - 1) * 2;
}

export async function handleLevels(req, res) {
  // 🚨 Регистр тикера брать из вселенной, а не приводить к верхнему: у k-монет
  // имя в API со строчной k, и candleSnapshot на KPEPE отдаёт пустоту.
  const asked = String(req.query.coin || "BTC").trim().replace(/[^A-Za-z0-9:_-]/g, "");
  const asset = findAsset(asked);
  const coin = asset ? asset.name : asked.toUpperCase();
  const tf = FRAMES[req.query.tf] ? req.query.tf : "1h";

  if (!asset && getUniverse().length) {
    return res.status(404).json({ error: `Unknown ticker "${asked}" — not listed on Hyperliquid.` });
  }

  let candles;
  try {
    candles = await FRAMES[tf].load(asset ? asset.name : asked);
  } catch {
    return res.status(502).json({ error: "Exchange did not return candles. Try again in a moment." });
  }
  const need = SWING_WING * 2 + 20;
  if (!Array.isArray(candles) || candles.length < need) {
    const got = Array.isArray(candles) ? candles.length : 0;
    return res
      .status(404)
      .json({ error: `Not enough history: ${got} of ${need} candles on ${tf}. Try a shorter timeframe.` });
  }

  const price = candles[candles.length - 1].close;
  const a = atr(candles);
  const tol = a * MERGE_ATR || price * 0.001;
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));

  const profile = volumeProfile(candles);
  const raw = [...swings(candles), ...priorDay(candles), ...profile.levels, ...roundNumbers(lo, hi)];
  const zones = toZones(raw, candles, tol)
    .map((z) => ({ ...z, strength: strength(z) }))
    .filter((z) => z.strength >= 2)
    .sort((x, y) => x.price - y.price);

  let btc = null;
  if (coin !== "BTC") {
    try {
      const btcBars = await FRAMES[tf].load("BTC");
      if (Array.isArray(btcBars)) btc = btcLink(candles, btcBars, MOVE_WINDOWS[tf]);
    } catch {
      btc = null;
    }
  }

  const [oi, seed] = await Promise.all([levelsOi(coin, OI_WINDOWS[tf]), emaSeed(coin, tf, candles)]);

  const body = {
    coin,
    tf,
    price,
    atr: a,
    tol,
    rule: {
      swingWing: SWING_WING,
      bins: PROFILE_BINS,
      valueArea: VALUE_AREA,
      mergeAtr: MERGE_ATR,
      touchGapBars: TOUCH_GAP_BARS,
    },
    candles: candles.map((c) => ({
      time: Math.floor(c.time / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
    emaSeed: seed,
    profile: profile.bins,
    thin: thinCorridors(profile.bins, profile.step),
    zones,
    btc,
    oi,
  };
  recordLevelRead(body, candles[candles.length - 1].time);
  res.json(body);
}

/** EMA на входе в окно, по истории до его первого бара; null — истории не хватило. */
async function emaSeed(coin, tf, window) {
  try {
    const deep = await getDeepCandles(coin, tf, FRAMES[tf].bars + EMA_WARM_BARS);
    const before = (deep || []).filter((c) => c.time < window[0].time).map((c) => c.close);
    if (before.length < EMA_PERIOD) return null;
    return ema(before).at(-1);
  } catch {
    return null;
  }
}

/** Только OI: страница перечитывает его чаще, чем свечи. */
export async function handleLevelsOi(req, res) {
  const asked = String(req.query.coin || "BTC").trim().replace(/[^A-Za-z0-9:_-]/g, "");
  const asset = findAsset(asked);
  const coin = asset ? asset.name : asked.toUpperCase();
  const tf = OI_WINDOWS[req.query.tf] ? req.query.tf : "1h";
  const oi = await levelsOi(coin, OI_WINDOWS[tf]);
  res.json({ coin, tf, oi });
}
