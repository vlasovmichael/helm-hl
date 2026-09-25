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
  if (!ahead) return { side, entry, stopZone: zone, incomplete: true };

  const stop = isLong ? zone.lo - buf : zone.hi + buf;
  const target = isLong ? ahead.lo : ahead.hi;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const cost = entry * (ROUND_TRIP_BP / 10_000);
  const netRr = risk > 0 ? Math.max(0, reward - cost) / (risk + cost) : 0;
  const riskPct = pct(stop, entry);
  const tooTight = riskPct < MIN_STOP_PCT;
  return {
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
  let kind = "middle";
  if (toS <= near && toS <= toR) kind = "support";
  else if (toR <= near) kind = "resistance";
  return { kind, s1, r1, long, short, toSPct: s1 ? pct(s1.hi, data.price) : null, toRPct: r1 ? pct(r1.lo, data.price) : null };
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
  return `<button class="btn btn--sm btn--${p.side}" type="button" data-zone="${esc(p.stopZone.name)}">${esc(label)} · ${esc(rrTag(p))}</button>`;
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
  let say = `Down to ${read.s1?.name ?? "support"}: ${dist(read.toSPct)} · up to ${read.r1?.name ?? "resistance"}: ${dist(read.toRPct)}. No setup until price comes to a zone.`;
  const at = read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null;
  if (at) {
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
  const entrySub = plan.atMarket ? "at market" : "limit order, waits for the zone";
  const nums = `<div class="lv-nums">
    ${cell(`${side} from ${plan.stopZone.name}`, fmtPx(plan.entry), entrySub)}
    ${cell("Stop", fmtPx(plan.stop), `−${plan.riskPct.toFixed(2)}% · behind ${plan.stopZone.name}`, "lv-num--stop")}
    ${cell("Target", fmtPx(plan.target), `+${plan.rewardPct.toFixed(2)}% · at ${plan.targetZone.name}`, "lv-num--target")}
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
