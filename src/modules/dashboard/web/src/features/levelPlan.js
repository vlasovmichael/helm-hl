// ─────────────────────────────────────────────────
//  Level plan — где цена относительно зон и какая сделка от зоны годна.
//
//  Вход от поддержки — лонг у её верхнего края, от сопротивления — шорт у
//  нижнего. Стоп за той же зоной, цель у следующей, решает число RR.
//  Порог RR 1.5: ниже него сделка при винрейте оператора минусовая после комиссий.
// ─────────────────────────────────────────────────

export const MIN_RR = 1.5;
export const ROUND_TRIP_BP = 8.64; // круг тейкером на HL
const BUFFER_ATR = 0.25; // стоп прячется за зону на эту долю ATR
// Стоп уже этого — риск вырождается в буфер, и отношение перестаёт быть отношением.
export const MIN_STOP_PCT = 0.15;
// Цена у зоны: до края не дальше ATR и не дальше четверти пути до зоны напротив.
const NEAR_ATR = 1;
const NEAR_GAP = 0.25;
const LEV_CAP = 10;
// Пробой принят, когда столько закрытых баров подряд стоят за краем зоны.
export const ACCEPT_BARS = 2;
// Дольше этого за краем — это уже не пробой, а зона по другую сторону цены.
const FRESH_BARS = 8;

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const fmtPx = (p) =>
  !Number.isFinite(p) ? "—" : p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);

const pct = (a, b) => (Math.abs(a - b) / b) * 100;
const usd = (v) => `$${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

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

const rrTag = (p) =>
  !p ? "no zone" : p.incomplete ? "no target zone" : `R:R ${p.netRr.toFixed(2)}${p.ok ? "" : p.tooTight ? " · stop too tight" : " · too low"}`;

function pickButton(p, label) {
  if (!p) return "";
  return `<button class="btn btn--sm btn--${p.side}" type="button" data-zone="${esc(p.stopZone.name)}" data-kind="${p.kind}">${esc(label)} · ${esc(rrTag(p))}</button>`;
}

/** Подпись пробоя: где триггер и сколько закрытий уже за ним. */
function breakLabel(p) {
  const dir = p.side === "long" ? "above" : "below";
  const via = p.thin ? " · thin volume" : "";
  return p.accepted
    ? `Broke ${dir} ${p.stopZone.name}${via}`
    : `Break ${dir} ${p.stopZone.name} ${fmtPx(p.trigger)}${via}`;
}

/** Одна строка над графиком: что делать сейчас. */
export function renderRead(node, read) {
  if (!node) return;
  if (read.kind === "empty") {
    node.innerHTML = `<div class="lv-verdict lv-verdict--none"><b>No zones</b><span>Nothing cleared the strength floor in this window. Try another timeframe.</span></div>`;
    return;
  }
  const dist = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
  let cls = "lv-verdict--none";
  let head = "Price is between zones — wait";
  let say = `Down to ${read.s1?.name ?? "support"}: ${dist(read.toSPct)} · up to ${read.r1?.name ?? "resistance"}: ${dist(read.toRPct)}. No setup until price comes to a zone or closes ${ACCEPT_BARS} bars past one.`;
  const at = read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null;
  const broke = [read.breakUp, read.breakDown].find((p) => p?.accepted && !p.incomplete);
  if (broke) {
    const dir = broke.side === "long" ? "above" : "below";
    cls = broke.ok ? "lv-verdict--go" : "lv-verdict--no";
    head = `Price broke ${dir} ${broke.stopZone.name} — ${broke.side} on the break, R:R ${broke.netRr.toFixed(2)}`;
    say = `${broke.held} closed bars ${dir} ${fmtPx(broke.trigger)}. Stop ${fmtPx(broke.stop)} back inside ${broke.stopZone.name}, target ${fmtPx(broke.target)} at ${broke.targetZone.name}${broke.thin ? ", through thin volume" : ""}.${broke.ok ? "" : ` Below ${MIN_RR} the trade does not pay.`}`;
  } else if (at) {
    const zone = at.stopZone.name;
    const where = read.kind === "support" ? `at support ${zone}` : `at resistance ${zone}`;
    if (at.incomplete) {
      head = `Price is ${where} — no target`;
      say = "There is no zone beyond it to aim at, so the ratio cannot be counted.";
    } else if (at.ok) {
      cls = "lv-verdict--go";
      head = `Price is ${where} — ${at.side} setup, R:R ${at.netRr.toFixed(2)}`;
      say = `Entry ${fmtPx(at.entry)}, stop ${fmtPx(at.stop)} behind ${zone}, target ${fmtPx(at.target)} at ${at.targetZone.name}. The ratio pays; the chart does not say price will turn here.`;
    } else {
      cls = "lv-verdict--no";
      head = `Price is ${where} — skip, R:R ${at.netRr.toFixed(2)}`;
      say = at.tooTight
        ? `The stop is under ${MIN_STOP_PCT}% away — any wick takes it.`
        : `The next zone ${at.targetZone.name} is too close for the stop behind ${zone}. Below ${MIN_RR} the trade does not pay.`;
    }
  }
  node.innerHTML = `<div class="lv-verdict ${cls}">
    <b>${esc(head)}</b>
    <span>${esc(say)}</span>
    <div class="lv-picks">${pickButton(read.long, `Long from ${read.s1?.name}`)}${pickButton(read.short, `Short from ${read.r1?.name}`)}</div>
    <div class="lv-picks">${read.breakUp ? pickButton(read.breakUp, breakLabel(read.breakUp)) : ""}${read.breakDown ? pickButton(read.breakDown, breakLabel(read.breakDown)) : ""}</div>
  </div>`;
}

/**
 * Чей ход: монеты или рынка. Свой ход — остаток после беты к BTC на длинном окне.
 * Меньше половины хода — ход рыночный.
 */
export function marketRead(ctx) {
  if (!ctx?.windows?.length || !Number.isFinite(ctx.beta)) return null;
  const last = ctx.windows[ctx.windows.length - 1];
  const own = last.coin - ctx.beta * last.btc;
  const market = Math.abs(own) < Math.abs(last.coin) * 0.5;
  return { window: last.label, own, market };
}

const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%` : "—");

/** Строка контекста под выводом: ход BTC и монеты, корреляция и свой ход. */
export function renderContext(node, data) {
  if (!node) return;
  const ctx = data?.btc;
  if (!ctx) {
    node.innerHTML = data?.coin === "BTC" ? "" : `<div class="lv-note">BTC context is unavailable right now.</div>`;
    return;
  }
  const read = marketRead(ctx);
  const moves = (key) => ctx.windows.map((w) => `${w.label} ${signed(w[key])}`).join(" · ");
  const head = read
    ? read.market
      ? `Mostly the market: own move over ${read.window} ${signed(read.own)}`
      : `Mostly its own move: ${signed(read.own)} over ${read.window} beyond what BTC explains`
    : "";
  node.innerHTML = `<div class="lv-context">
    <div class="lv-context-row mono"><span class="label">BTC</span>${esc(moves("btc"))}</div>
    <div class="lv-context-row mono"><span class="label">${esc(data.coin)}</span>${esc(moves("coin"))}</div>
    <div class="lv-context-row"><span class="label">Link</span><span class="mono">corr ${ctx.corr.toFixed(2)} · beta ${ctx.beta.toFixed(2)}</span>${head ? `<b>${esc(head)}</b>` : ""}</div>
  </div>`;
}

const OI_MODES = {
  "new-longs": "price up, OI up — new longs",
  "short-covering": "price up, OI down — shorts closing",
  "new-shorts": "price down, OI up — new shorts",
  "long-exit": "price down, OI down — longs closing",
  build: "price flat, OI up — positions building",
  unwind: "price flat, OI down — positions unwinding",
  flat: "OI unchanged",
};

const big = (v) =>
  !Number.isFinite(v) ? "—" : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);

/** Строка OI: живое значение, ход за окна и кто действовал. */
export function renderOi(node, coin, oi) {
  if (!node) return;
  if (!oi) {
    node.innerHTML = `<div class="lv-note">Open interest is unavailable right now.</div>`;
    return;
  }
  const moves = oi.windows.map((w) => `${w.label} ${w.oiPct == null ? "—" : signed(w.oiPct)}`).join(" · ");
  const modes = oi.windows
    .filter((w) => w.mode)
    .map((w) => `${w.label}: ${OI_MODES[w.mode]}`)
    .join(" · ");
  const time = new Date(oi.at).toLocaleTimeString("en-GB");
  node.innerHTML = `<div class="lv-context">
    <div class="lv-context-row mono"><span class="label">OI</span>${esc(`${big(oi.oi)} ${coin} · $${big(oi.oiUsd)} · ${moves}`)}</div>
    <div class="lv-context-row"><span class="label">Who</span>${modes ? `<b>${esc(modes)}</b>` : `<span>No OI history for these windows yet.</span>`}</div>
    <div class="lv-context-row"><span class="label">Live</span><span>updated ${esc(time)} · OI counts both sides at once: this says who acted, not where price goes.</span></div>
  </div>`;
}

/**
 * Размер позиции от риска: убыток на стопе = доля депо.
 * Комиссия круга входит в убыток, иначе реальный минус больше заявленного.
 */
export function sizing({ equity, riskPct, plan, costBp = ROUND_TRIP_BP }) {
  if (!(equity > 0) || !(riskPct > 0) || !plan || plan.incomplete) return null;
  const riskUsd = (equity * riskPct) / 100;
  const perUnitLoss = plan.riskPct / 100 + costBp / 10_000;
  const notional = riskUsd / perUnitLoss;
  const qty = notional / plan.entry;
  const profitUsd = notional * (plan.rewardPct / 100 - costBp / 10_000);
  return { riskUsd, notional, qty, profitUsd, leverage: notional / equity };
}

const cell = (label, value, sub, cls = "") => `<div class="lv-num${cls ? " " + cls : ""}">
    <div class="label">${esc(label)}</div>
    <div class="lv-num-val mono">${esc(value)}</div>
    ${sub ? `<div class="lv-num-sub mono">${esc(sub)}</div>` : ""}
  </div>`;

/** Карточка плана: числа сделки и размер от риска. */
export function renderPlan(node, plan, { equity, riskPct }) {
  if (!node) return;
  if (!plan) {
    node.innerHTML = `<div class="lv-empty">Click a zone on the chart: support plans a long, resistance plans a short.</div>`;
    return;
  }
  if (plan.incomplete) {
    node.innerHTML = `<div class="lv-empty">No zone beyond ${esc(plan.stopZone.name)} to aim at — no target, no ratio.</div>`;
    return;
  }
  const side = plan.side === "long" ? "Long" : "Short";
  const isBreak = plan.kind === "break";
  const dir = plan.side === "long" ? "above" : "below";
  const entryHead = isBreak ? `${side} on break of ${plan.stopZone.name}` : `${side} from ${plan.stopZone.name}`;
  const entrySub = isBreak
    ? plan.accepted
      ? `at market · ${plan.held} closes ${dir} ${fmtPx(plan.trigger)}`
      : `after ${ACCEPT_BARS} closed bars ${dir} ${fmtPx(plan.trigger)}`
    : plan.atMarket
      ? "at market"
      : "limit order, waits for the zone";
  const stopSub = isBreak ? `back inside ${plan.stopZone.name}` : `behind ${plan.stopZone.name}`;
  const targetSub = plan.thin ? `at ${plan.targetZone.name} · through thin volume` : `at ${plan.targetZone.name}`;
  const nums = `<div class="lv-nums">
    ${cell(entryHead, fmtPx(plan.entry), entrySub)}
    ${cell("Stop", fmtPx(plan.stop), `−${plan.riskPct.toFixed(2)}% · ${stopSub}`, "lv-num--stop")}
    ${cell("Target", fmtPx(plan.target), `+${plan.rewardPct.toFixed(2)}% · ${targetSub}`, "lv-num--target")}
    ${cell("Net R:R", plan.netRr.toFixed(2), `floor ${MIN_RR} · fees ${ROUND_TRIP_BP} bp`, plan.ok ? "lv-num--go" : "lv-num--no")}
  </div>`;
  const z = sizing({ equity, riskPct, plan });
  const size = z
    ? `<div class="lv-nums">
        ${cell("Position size", usd(z.notional), `${z.qty.toPrecision(4)} coins`)}
        ${cell("Leverage", `${z.leverage.toFixed(1)}×`, z.leverage > LEV_CAP ? `above the ${LEV_CAP}× cap` : "", z.leverage > LEV_CAP ? "lv-num--no" : "")}
        ${cell("Loss at stop", `−${usd(z.riskUsd)}`, "fees included", "lv-num--stop")}
        ${cell("Profit at target", `+${usd(z.profitUsd)}`, "after fees", "lv-num--target")}
      </div>`
    : `<div class="lv-note">Fill in account and risk to get the position size.</div>`;
  // Правило из журнала оператора, а не из теории, поэтому висит рядом с лонгом.
  const warn =
    plan.side === "long"
      ? `<div class="lv-warn">Longs ran at a loss across the journal while shorts did not. Taking one needs a reason beyond this chart.</div>`
      : "";
  node.innerHTML = nums + size + warn;
}

/** Таблица зон: то же, что на графике, с расстоянием до цены. */
export function renderZones(node, data) {
  if (!node) return;
  if (!data?.zones?.length) {
    node.innerHTML = `<div class="lv-empty">No zones cleared the strength floor in this window.</div>`;
    return;
  }
  const rows = [...data.zones].sort((a, b) => b.price - a.price);
  node.innerHTML = `
    <table class="table table--compact">
      <thead><tr>
        <th>Zone</th><th>Price</th><th class="num">Distance</th><th class="num">Touches</th>
        <th>Built from</th><th class="num">Strength</th>
      </tr></thead>
      <tbody>${rows
        .map((z) => {
          const above = z.price > data.price;
          return `<tr class="${above ? "lv-row--above" : "lv-row--below"}">
            <td class="mono strong">${esc(z.name)}</td>
            <td class="mono">${fmtPx(z.price)}</td>
            <td class="num mono ${above ? "down" : "up"}">${above ? "+" : "−"}${pct(z.price, data.price).toFixed(2)}%</td>
            <td class="num mono">${z.touches}</td>
            <td class="muted">${esc(z.sources.join(" + "))}</td>
            <td class="num mono">${z.strength}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

/** Расшифровка источников: читатель должен знать, из чего зона, а не верить ей. */
export const SOURCE_NOTE =
  "swing — a bar whose high or low stands above five bars on each side · pdh/pdl — previous UTC day high and low · poc/vah/val — volume profile point of control and value area edges · round — round number. Nearby levels merge into one zone when they sit within 0.35 ATR.";
