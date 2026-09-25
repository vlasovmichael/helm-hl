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
import { SWING_WING, PROFILE_BINS, VALUE_AREA, MERGE_ATR, TOUCH_GAP_BARS, levelZones, thinCorridors } from "./levelZones.js";

export { thinCorridors };

// Окно на таймфрейм: столько баров хватает для свингов и профиля, но не
// заставляет HL отдавать историю, которую всё равно никто не смотрит.
const FRAMES = {
  "15m": { bars: 288, load: (coin) => getFifteenMinCandles(coin, 288 * 15) },
  "1h": { bars: 480, load: (coin) => getHourlyCandles(coin, 480) },
  "4h": { bars: 360, load: (coin) => getFourHourCandles(coin, 360 * 4) },
};

// Прогрев EMA до окна: через три периода вклад затравки меньше процента.
const EMA_WARM_BARS = EMA_PERIOD * 3;

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

  const { price, atr: a, tol, profile, zones } = levelZones(candles);

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
