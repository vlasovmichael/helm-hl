// ─────────────────────────────────────────────────
//  Зоны уровней: чистое правило страницы levels, без сети и базы.
//  Его же гоняет ретро в tools/, чтобы вердикт относился к странице.
// ─────────────────────────────────────────────────

export const SWING_WING = 5; // баров по каждую сторону от вершины фрактала
export const PROFILE_BINS = 64;
export const VALUE_AREA = 0.7; // доля объёма внутри области стоимости, стандарт профиля
export const MERGE_ATR = 0.35; // ближе этой доли ATR уровни считаются одной зоной
export const TOUCH_GAP_BARS = 3; // столько баров вне зоны разделяют два касания
const THIN_SHARE = 0.5; // бин тоньше этой доли меньшей из соседних полок — тонкий объём
const THIN_MIN_BINS = 3; // коридор уже этого — шум профиля, а не провал

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

/** Зоны окна свечей по правилу страницы; тем же правилом считает ретро. */
export function levelZones(candles) {
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
  return { price, atr: a, tol, profile, zones };
}
