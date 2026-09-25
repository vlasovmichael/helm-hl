// ─────────────────────────────────────────────────
//  Математика уровней: зоны, планы отскока и пробоя, чтение цены.
//  Без DOM и без импортов: её же гоняет сервер (levelReads), где dev-пакетов нет.
// ─────────────────────────────────────────────────

export const MIN_RR = 1.5;
export const ROUND_TRIP_BP = 8.64; // круг тейкером на HL
const BUFFER_ATR = 0.25; // стоп прячется за зону на эту долю ATR
// Стоп уже этого — риск вырождается в буфер, и отношение перестаёт быть отношением.
export const MIN_STOP_PCT = 0.15;
// Цена у зоны: до края не дальше ATR и не дальше четверти пути до зоны напротив.
const NEAR_ATR = 1;
const NEAR_GAP = 0.25;
// Пробой принят, когда столько закрытых баров подряд стоят за краем зоны.
export const ACCEPT_BARS = 2;
// Дольше этого за краем — это уже не пробой, а зона по другую сторону цены.
const FRESH_BARS = 8;

export const pct = (a, b) => (Math.abs(a - b) / b) * 100;

// Цена в плане округляется до шага показа: в поле, на графике и в ордере одно число.
const roundPx = (p) =>
  !Number.isFinite(p)
    ? p
    : p >= 1000
      ? Math.round(p * 10) / 10
      : p >= 1
        ? Math.round(p * 1e4) / 1e4
        : Number(p.toPrecision(4));

/** Имена зон: R1 — ближайшая над ценой, S1 — ближайшая под ней. */
export function nameZones(data) {
  const above = data.zones.filter((z) => z.price > data.price).sort((a, b) => a.price - b.price);
  const below = data.zones.filter((z) => z.price <= data.price).sort((a, b) => b.price - a.price);
  above.forEach((z, i) => (z.name = `R${i + 1}`));
  below.forEach((z, i) => (z.name = `S${i + 1}`));
  return { above, below };
}

/**
 * План от зоны. Сторона следует из того, где зона: под ценой — лонг, над — шорт.
 * Если цена уже внутри зоны, вход по рынку.
 */
export function planFromZone(data, zone) {
  if (!data || !zone) return null;
  const side = zone.price <= data.price ? "long" : "short";
  const isLong = side === "long";
  const entry = roundPx(isLong ? Math.min(zone.hi, data.price) : Math.max(zone.lo, data.price));
  const buf = (data.atr || 0) * BUFFER_ATR;
  const ahead = data.zones
    .filter((z) => z !== zone && (isLong ? z.lo > entry : z.hi < entry))
    .sort((a, b) => (isLong ? a.price - b.price : b.price - a.price))[0];
  if (!ahead) return { kind: "bounce", side, entry, stopZone: zone, incomplete: true };

  const stop = isLong ? zone.lo - buf : zone.hi + buf;
  const target = isLong ? ahead.lo : ahead.hi;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const cost = entry * (ROUND_TRIP_BP / 10_000);
  const netRr = risk > 0 ? Math.max(0, reward - cost) / (risk + cost) : 0;
  const riskPct = pct(stop, entry);
  const tooTight = riskPct < MIN_STOP_PCT;
  return {
    kind: "bounce",
    side,
    entry,
    stop,
    target,
    stopZone: zone,
    targetZone: ahead,
    rr: risk > 0 ? reward / risk : 0,
    netRr,
    riskPct,
    rewardPct: pct(target, entry),
    atMarket: entry === roundPx(data.price),
    tooTight,
    ok: netRr >= MIN_RR && !tooTight,
  };
}

/** Закрытые бары подряд за уровнем, считая от последнего закрытого. Живой бар не в счёт. */
export function closesBeyond(candles, level, side) {
  let n = 0;
  for (let i = (candles?.length ?? 0) - 2; i >= 0; i--) {
    const c = candles[i].close;
    if (side === "long" ? c > level : c < level) n++;
    else break;
  }
  return n;
}

/** Коридор тонкого объёма, который покрывает путь от триггера к цели хотя бы наполовину. */
function thinOnPath(data, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const span = hi - lo;
  if (!(span > 0)) return null;
  return (
    (data.thin || []).find((t) => Math.min(hi, t.hi) - Math.max(lo, t.lo) >= span * 0.5) || null
  );
}

/**
 * План пробоя зоны вверх (long) или вниз (short). Вход после ACCEPT_BARS закрытий
 * за краем, стоп — возврат внутрь зоны, цель — следующая зона за ней.
 */
export function breakPlan(data, zone, side) {
  if (!data || !zone) return null;
  const isLong = side === "long";
  const trigger = roundPx(isLong ? zone.hi : zone.lo);
  const held = closesBeyond(data.candles, trigger, side);
  const accepted = held >= ACCEPT_BARS && held <= FRESH_BARS;
  const entry = accepted ? roundPx(data.price) : trigger;
  const buf = (data.atr || 0) * BUFFER_ATR;
  const ahead = data.zones
    .filter((z) => z !== zone && (isLong ? z.lo > entry : z.hi < entry))
    .sort((a, b) => (isLong ? a.price - b.price : b.price - a.price))[0];
  const base = { kind: "break", side, trigger, held, accepted, entry, stopZone: zone };
  if (!ahead) return { ...base, incomplete: true };

  const stop = isLong ? zone.lo - buf : zone.hi + buf;
  const target = isLong ? ahead.lo : ahead.hi;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const cost = entry * (ROUND_TRIP_BP / 10_000);
  const netRr = risk > 0 ? Math.max(0, reward - cost) / (risk + cost) : 0;
  const riskPct = pct(stop, entry);
  const tooTight = riskPct < MIN_STOP_PCT;
  return {
    ...base,
    stop,
    target,
    targetZone: ahead,
    thin: thinOnPath(data, trigger, target),
    rr: risk > 0 ? reward / risk : 0,
    netRr,
    riskPct,
    rewardPct: pct(target, entry),
    atMarket: accepted,
    tooTight,
    ok: netRr >= MIN_RR && !tooTight,
  };
}

/** Какую зону пробивать: только что пробитую, если пробой свежий, иначе ближайшую впереди. */
function breakZone(data, near, far, side) {
  if (near) {
    const edge = side === "long" ? near.hi : near.lo;
    const held = closesBeyond(data.candles, edge, side);
    if (held >= 1 && held <= FRESH_BARS) return near;
  }
  return far;
}

/**
 * Где цена: у поддержки, у сопротивления или посередине. От ближней зоны
 * сразу считается план; посередине сетапа нет.
 */
export function readPrice(data) {
  if (!data?.zones?.length) return { kind: "empty" };
  const { above, below } = nameZones(data);
  const s1 = below[0] || null;
  const r1 = above[0] || null;
  const toS = s1 ? Math.max(0, data.price - s1.hi) : Infinity;
  const toR = r1 ? Math.max(0, r1.lo - data.price) : Infinity;
  const gap = s1 && r1 ? Math.max(0, r1.lo - s1.hi) : Infinity;
  const near = Math.min((data.atr || 0) * NEAR_ATR, gap * NEAR_GAP);
  const long = s1 ? planFromZone(data, s1) : null;
  const short = r1 ? planFromZone(data, r1) : null;
  const upZone = breakZone(data, s1, r1, "long");
  const downZone = breakZone(data, r1, s1, "short");
  const breakUp = upZone ? breakPlan(data, upZone, "long") : null;
  const breakDown = downZone ? breakPlan(data, downZone, "short") : null;
  let kind = "middle";
  if (toS <= near && toS <= toR) kind = "support";
  else if (toR <= near) kind = "resistance";
  return { kind, s1, r1, long, short, breakUp, breakDown, toSPct: s1 ? pct(s1.hi, data.price) : null, toRPct: r1 ? pct(r1.lo, data.price) : null };
}

/** Зоны на графике: по две с каждой стороны цены и те, что держат план. */
export function shownZones(data, plan) {
  if (!data?.zones?.length) return [];
  const { above, below } = nameZones(data);
  const keep = new Set([...above.slice(0, 2), ...below.slice(0, 2)]);
  if (plan?.stopZone) keep.add(plan.stopZone);
  if (plan?.targetZone) keep.add(plan.targetZone);
  return data.zones.filter((z) => keep.has(z));
}

/** Сценарии страницы по порядку: отскок от S1 и R1, пробой вверх и вниз. */
export function scenarios(read) {
  return [read.long, read.short, read.breakUp, read.breakDown].filter((p) => p && !p.incomplete);
}

export const scenarioKey = (p) => (p ? `${p.kind}:${p.stopZone.name}:${p.side}` : "");

export const EMA_PERIOD = 200;

/**
 * EMA закрытий по барам. С seed линия идёт с первого бара; без него затравка —
 * SMA первых period закрытий, а до неё значений нет (null).
 */
export function ema(closes, period = EMA_PERIOD, seed = null) {
  const out = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let v = Number.isFinite(seed) ? seed : null;
  let start = 0;
  if (v === null) {
    if (closes.length < period) return out;
    v = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
    out[period - 1] = v;
    start = period;
  }
  for (let i = start; i < closes.length; i++) {
    v += k * (closes[i] - v);
    out[i] = v;
  }
  return out;
}
