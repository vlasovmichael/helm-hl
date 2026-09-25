// ─────────────────────────────────────────────────
//  Level plan — где цена относительно зон и какая сделка от зоны годна.
//
//  Вход от поддержки — лонг у её верхнего края, от сопротивления — шорт у
//  нижнего. Стоп за той же зоной, цель у следующей, решает число RR.
//  Порог RR 1.5: ниже него сделка при винрейте оператора минусовая после комиссий.
// ─────────────────────────────────────────────────

import { segmented, stat } from "../core/ui.js";
import {
  ACCEPT_BARS,
  MIN_RR,
  MIN_STOP_PCT,
  ROUND_TRIP_BP,
  pct,
  scenarioKey,
  scenarios,
} from "./levelMath.js";

export * from "./levelMath.js";

const LEV_CAP = 10;

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const fmtPx = (p) =>
  !Number.isFinite(p) ? "—" : p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);

const usd = (v) => `$${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

function scenarioLabel(p) {
  const dir = p.side === "long" ? "above" : "below";
  const what =
    p.kind === "break"
      ? `${p.side === "long" ? "Long" : "Short"} ${p.accepted ? "after break" : "on break"} ${dir} ${p.stopZone.name}`
      : `${p.side === "long" ? "Long" : "Short"} from ${p.stopZone.name}`;
  return `${what} · R:R ${p.netRr.toFixed(2)}`;
}

/** Выбор сценария — сегментный ряд: один выбран, остальные рядом для сравнения. */
export function renderScenarios(node, read, plan) {
  if (!node) return;
  const list = read.kind === "empty" ? [] : scenarios(read);
  node.innerHTML = list.length
    ? segmented({
        name: "scenario",
        value: scenarioKey(plan),
        wide: true,
        options: list.map((p) => ({ value: scenarioKey(p), label: scenarioLabel(p), tone: p.side })),
      })
    : "";
}

/** Где цена относительно ближайших зон, одной фразой с расстоянием. */
function where(read, price) {
  const dist = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
  const s = read.s1 ? `${read.s1.name} ${dist(read.toSPct)} below` : "no support below";
  const r = read.r1 ? `${read.r1.name} ${dist(read.toRPct)} above` : "no resistance above";
  return `Price ${fmtPx(price)} · support ${s} · resistance ${r}.`;
}

/** Вывод над планом: заголовок — что делать, строка под ним — почему. */
export function renderRead(node, read, price) {
  if (!node) return;
  if (read.kind === "empty") {
    node.innerHTML = `<div class="lv-verdict lv-verdict--none"><b>No zones</b><span>Nothing cleared the strength floor in this window. Try another timeframe.</span></div>`;
    return;
  }
  let cls = "lv-verdict--none";
  let head = "Wait — price is between zones";
  let say = `No setup until price comes to a zone or closes ${ACCEPT_BARS} bars past one.`;
  const at = read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null;
  const broke = [read.breakUp, read.breakDown].find((p) => p?.accepted && !p.incomplete);
  if (broke) {
    const dir = broke.side === "long" ? "above" : "below";
    const side = broke.side === "long" ? "Long" : "Short";
    cls = broke.ok ? "lv-verdict--go" : "lv-verdict--no";
    head = broke.ok
      ? `${side} the break ${dir} ${broke.stopZone.name} · R:R ${broke.netRr.toFixed(2)}`
      : `Skip the break ${dir} ${broke.stopZone.name} · R:R ${broke.netRr.toFixed(2)}`;
    say = `${broke.held} closed bars ${dir} ${fmtPx(broke.trigger)}.${broke.thin ? " The path to the target runs through thin volume." : ""}${broke.ok ? "" : ` Below ${MIN_RR} the trade does not pay.`}`;
  } else if (at) {
    const zone = at.stopZone.name;
    const side = at.side === "long" ? "Long" : "Short";
    const kind = read.kind === "support" ? "support" : "resistance";
    if (at.incomplete) {
      head = `No target beyond ${zone}`;
      say = `Price is at ${kind} ${zone}, but there is no zone past it to aim at, so the ratio cannot be counted.`;
    } else if (at.ok) {
      cls = "lv-verdict--go";
      head = `${side} from ${kind} ${zone} · R:R ${at.netRr.toFixed(2)}`;
      say = "The ratio pays. The chart does not say price will turn here — the stop does the work if it does not.";
    } else {
      cls = "lv-verdict--no";
      head = `Skip ${side.toLowerCase()} from ${zone} · R:R ${at.netRr.toFixed(2)}`;
      say = at.tooTight
        ? `The stop is under ${MIN_STOP_PCT}% away — any wick takes it.`
        : `The next zone ${at.targetZone.name} is too close for a stop behind ${zone}. Below ${MIN_RR} the trade does not pay.`;
    }
  }
  node.innerHTML = `<div class="lv-verdict ${cls}">
    <b>${esc(head)}</b>
    <span>${esc(where(read, price))} ${esc(say)}</span>
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

const grid = (tiles) => `<div class="data-grid">${tiles.join("")}</div>`;

/** Числа плана: вход, стоп, цель и чистое R:R. */
export function renderPlan(node, plan) {
  if (!node) return;
  if (!plan) {
    node.innerHTML = `<div class="lv-empty">Click a zone on the chart: support plans a long, resistance plans a short.</div>`;
    return;
  }
  if (plan.incomplete) {
    node.innerHTML = `<div class="lv-empty">No zone beyond ${esc(plan.stopZone.name)} to aim at — no target, no ratio.</div>`;
    return;
  }
  const isBreak = plan.kind === "break";
  const dir = plan.side === "long" ? "above" : "below";
  const entrySub = isBreak
    ? plan.accepted
      ? `at market · ${plan.held} closes ${dir} ${fmtPx(plan.trigger)}`
      : `after ${ACCEPT_BARS} closed bars ${dir} ${fmtPx(plan.trigger)}`
    : plan.atMarket
      ? "at market"
      : "limit order, waits for the zone";
  const stopSub = isBreak ? `back inside ${plan.stopZone.name}` : `behind ${plan.stopZone.name}`;
  const targetSub = plan.thin ? `at ${plan.targetZone.name} · through thin volume` : `at ${plan.targetZone.name}`;
  node.innerHTML = grid([
    stat({ label: `Entry · ${plan.side}`, value: fmtPx(plan.entry), sub: entrySub }),
    stat({ label: "Stop", value: fmtPx(plan.stop), sub: `−${plan.riskPct.toFixed(2)}% · ${stopSub}`, tone: "negative" }),
    stat({ label: "Target", value: fmtPx(plan.target), sub: `+${plan.rewardPct.toFixed(2)}% · ${targetSub}`, tone: "positive" }),
    stat({
      label: "Net R:R",
      value: plan.netRr.toFixed(2),
      sub: `floor ${MIN_RR} · fees ${ROUND_TRIP_BP} bp`,
      tone: plan.ok ? "positive" : "negative",
      primary: true,
    }),
  ]);
}

/** Размер позиции от риска и правило журнала для лонгов. */
export function renderSize(node, plan, { equity, riskPct }) {
  if (!node) return;
  if (!plan || plan.incomplete) {
    node.innerHTML = "";
    return;
  }
  const z = sizing({ equity, riskPct, plan });
  const size = z
    ? grid([
        stat({ label: "Position size", value: usd(z.notional), sub: `${z.qty.toPrecision(4)} coins` }),
        stat({
          label: "Leverage",
          value: `${z.leverage.toFixed(1)}×`,
          sub: z.leverage > LEV_CAP ? `above the ${LEV_CAP}× cap` : `cap ${LEV_CAP}×`,
          tone: z.leverage > LEV_CAP ? "negative" : "",
        }),
        stat({ label: "Loss at stop", value: `−${usd(z.riskUsd)}`, sub: "fees included", tone: "negative" }),
        stat({ label: "Profit at target", value: `+${usd(z.profitUsd)}`, sub: "after fees", tone: "positive" }),
      ])
    : `<div class="lv-note">Fill in account and risk to get the position size.</div>`;
  // Правило из журнала оператора, а не из теории, поэтому висит рядом с лонгом.
  const warn =
    plan.side === "long"
      ? `<div class="lv-warn">Longs ran at a loss across the journal while shorts did not. Taking one needs a reason beyond this chart.</div>`
      : "";
  node.innerHTML = size + warn;
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
