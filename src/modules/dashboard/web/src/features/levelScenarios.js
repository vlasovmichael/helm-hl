// ─────────────────────────────────────────────────
//  Level scenarios — два плана у ближайших зон: отскок вверх и отказ вниз.
//
//  Сценарий — геометрия, а не прогноз: вход у края зоны, стоп за ней, цель у
//  следующей. Частота «цель до стопа» считается по свечам окна с теми же
//  расстояниями из каждого бара и показывает, что делал рынок, а не что будет.
// ─────────────────────────────────────────────────

import { buildPlan, greenEntries, MIN_RR, MIN_STOP_PCT, ROUND_TRIP_BP, esc, fmtPx } from "./levelPlan.js";

export const HORIZON_BARS = 24;
export const FIB_RATIOS = [0, 0.382, 0.5, 0.618, 1, 1.414, 1.618];

/**
 * Фибо от последнего импульса окна: от первого по времени экстремума ко
 * второму. Уровни ретрейса ложатся назад от конца импульса.
 */
export function fibLevels(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > candles[hi].high) hi = i;
    if (candles[i].low < candles[lo].low) lo = i;
  }
  const up = lo < hi;
  const from = up ? candles[lo].low : candles[hi].high;
  const to = up ? candles[hi].high : candles[lo].low;
  const span = to - from;
  if (!(Math.abs(span) > 0)) return null;
  return {
    up,
    from,
    to,
    fromTime: candles[up ? lo : hi].time,
    toTime: candles[up ? hi : lo].time,
    // Ретрейс 0.618 = от конца импульса назад на 61.8% размаха.
    levels: FIB_RATIOS.map((r) => ({ ratio: r, price: to - span * r })),
  };
}

/**
 * Сколько раз в окне цель с тем же расстоянием бралась до стопа.
 * Путь внутри бара неизвестен: бар, задевший обе линии, засчитан стопу.
 * Соседние старты перекрываются, поэтому интервал берётся по n / горизонт.
 */
export function baseRate(candles, { side, riskPct, rewardPct, horizon = HORIZON_BARS }) {
  if (!Array.isArray(candles) || !(riskPct > 0) || !(rewardPct > 0)) return null;
  const isLong = side === "long";
  let wins = 0;
  let losses = 0;
  let open = 0;
  const winBars = [];
  for (let i = 0; i + horizon < candles.length; i++) {
    const entry = candles[i].close;
    const stop = entry * (1 + (isLong ? -riskPct : riskPct) / 100);
    const target = entry * (1 + (isLong ? rewardPct : -rewardPct) / 100);
    let out = 0;
    for (let j = i + 1; j <= i + horizon; j++) {
      const c = candles[j];
      const hitStop = isLong ? c.low <= stop : c.high >= stop;
      const hitTarget = isLong ? c.high >= target : c.low <= target;
      if (hitStop) {
        out = -1;
        break;
      }
      if (hitTarget) {
        out = 1;
        winBars.push(j - i);
        break;
      }
    }
    if (out > 0) wins++;
    else if (out < 0) losses++;
    else open++;
  }
  const n = wins + losses + open;
  if (!n) return null;
  const hit = wins / n;
  const [ciLo, ciHi] = wilson(hit, Math.max(1, Math.round(n / horizon)));
  return { n, wins, losses, open, hit, ciLo, ciHi, horizon, winBars: median(winBars) };
}

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/**
 * За сколько баров цена в окне обычно проходила такое расстояние в нужную
 * сторону: медиана по стартам, где касание случилось. Задаёт длину стрелки.
 */
export function barsToTouch(candles, { up, pct, horizon = HORIZON_BARS * 2 }) {
  if (!Array.isArray(candles) || !(pct >= 0)) return null;
  const bars = [];
  for (let i = 0; i + 1 < candles.length; i++) {
    const level = candles[i].close * (1 + ((up ? 1 : -1) * pct) / 100);
    const end = Math.min(candles.length - 1, i + horizon);
    for (let j = i + 1; j <= end; j++) {
      if (up ? candles[j].high >= level : candles[j].low <= level) {
        bars.push(j - i);
        break;
      }
    }
  }
  return median(bars);
}

/** Доля побед, при которой сделка с этим стопом и целью выходит в ноль после комиссий. */
export function breakevenHit({ riskPct, rewardPct, costBp = ROUND_TRIP_BP }) {
  const cost = costBp / 100;
  const denom = riskPct + rewardPct;
  return denom > 0 ? (riskPct + cost) / denom : null;
}

function wilson(p, n, z = 1.96) {
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * Два сценария: A — лонг от ближайшей годной поддержки, B — шорт от ближайшего
 * годного сопротивления. Нет годного входа — план от рыночной цены с пометкой.
 */
export function buildScenarios(data) {
  if (!data?.zones?.length || !Number.isFinite(data.price)) return [];
  return ["long", "short"].map((side) => {
    const ready = greenEntries(data, side)[0];
    const plan = ready || buildPlan(data, { side, entry: data.price });
    const out = {
      id: side === "long" ? "A" : "B",
      side,
      plan,
      // Годного входа у зоны нет: план от рынка показывается числами, но не рисуется.
      noTrade: !ready,
    };
    if (plan && !plan.incomplete) {
      out.rate = baseRate(data.candles, {
        side,
        riskPct: plan.riskPct,
        rewardPct: plan.rewardPct,
      });
      out.needHit = breakevenHit({ riskPct: plan.riskPct, rewardPct: plan.rewardPct });
      out.tooTight = plan.riskPct < MIN_STOP_PCT;
      if (ready) {
        out.entryBars = barsToTouch(data.candles, {
          up: plan.entry > data.price,
          pct: Math.abs(ready.distPct),
        });
      }
    }
    return out;
  });
}

/**
 * Размер позиции от риска: убыток на стопе = доля депо, а не наоборот.
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

/**
 * Зоны, которые стоит видеть на графике: по две ближайших с каждой стороны
 * плюс те, что держат стоп или цель сценариев.
 */
export function keyZones(data, scenarios, perSide = 2) {
  if (!data?.zones?.length) return [];
  const above = data.zones.filter((z) => z.price > data.price).sort((a, b) => a.price - b.price);
  const below = data.zones.filter((z) => z.price <= data.price).sort((a, b) => b.price - a.price);
  const keep = new Set([...above.slice(0, perSide), ...below.slice(0, perSide)]);
  for (const s of scenarios) {
    if (s.plan?.stopZone) keep.add(s.plan.stopZone);
    if (s.plan?.targetZone) keep.add(s.plan.targetZone);
  }
  return data.zones.filter((z) => keep.has(z));
}

const LEV_CAP = 10;
const pctTxt = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
const usd = (v) => `$${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
const TF_HOURS = { "15m": 0.25, "1h": 1, "4h": 4 };

/** Длительность в часах или днях: число баров без таймфрейма ничего не говорит. */
export function spanText(bars, tf) {
  const h = bars * (TF_HOURS[tf] ?? 1);
  if (h < 1.5) return `${Math.round(h * 60)} minutes`;
  if (h < 48) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

/** Полоса «сколько было» против метки «сколько нужно»: одна SVG без inline-стилей. */
function meter(hit, need) {
  const w = Math.max(0, Math.min(100, hit * 100));
  const n = Math.max(0, Math.min(100, need * 100));
  return `<svg class="lv-meter" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
    <rect class="lv-meter-track" x="0" y="1" width="100" height="6" rx="3"></rect>
    <rect class="lv-meter-fill" x="0" y="1" width="${w.toFixed(1)}" height="6" rx="3"></rect>
    <line class="lv-meter-need" x1="${n.toFixed(1)}" x2="${n.toFixed(1)}" y1="0" y2="8"></line>
  </svg>`;
}

function oddsBlock(s, tf) {
  if (!s.rate || s.needHit == null) return "";
  const { hit, ciLo, ciHi, n, horizon, winBars } = s.rate;
  const tone = ciLo > s.needHit ? "go" : ciHi < s.needHit ? "no" : "flat";
  const say = {
    go: "The window paid for this geometry: target came first more often than break-even needs.",
    no: "The window did not pay for it: the stop came first too often.",
    flat: "Too close to call — in this window it is indistinguishable from a coin flip.",
  }[tone];
  return `<div class="lv-odds lv-odds--${tone}">
    <div class="lv-odds-row">
      <span>Target before stop, within ${spanText(horizon, tf)}</span>
      <b class="mono">${(hit * 100).toFixed(0)}%</b>
    </div>
    ${meter(hit, s.needHit)}
    <div class="lv-odds-row lv-odds-row--sub">
      <span>needed to break even after fees</span>
      <span class="mono">${(s.needHit * 100).toFixed(0)}% · range ${(ciLo * 100).toFixed(0)}–${(ciHi * 100).toFixed(0)}%</span>
    </div>
    <p class="lv-odds-say">${say}</p>
    ${winBars ? `<p class="lv-odds-foot">When the target came first, it took about ${spanText(winBars, tf)}.</p>` : ""}
    <p class="lv-odds-foot">Every bar of the last ${spanText(n + horizon, tf)} replayed with the same stop and target distance. It describes the window, not tomorrow.</p>
  </div>`;
}

const TITLE = { long: "Bounce off support", short: "Rejection at resistance" };

function scenarioCard(s, activeKey, price, tf) {
  const p = s.plan;
  const key = `${s.side}:${p?.entry}`;
  const on = key === activeKey;
  const head = `<div class="lv-sc-head">
      <span class="badge badge--${s.side}">${s.side}</span>
      <b>${s.id} · ${TITLE[s.side]}</b>
    </div>`;
  if (!p || p.incomplete) {
    return `<div class="lv-sc lv-sc--off">${head}
      <p class="lv-sc-sub">No zone ${p?.missing === "stop" ? "behind the entry for a stop" : "ahead for a target"} — no plan on this side.</p>
    </div>`;
  }
  const dist = ((p.entry - price) / price) * 100;
  if (s.noTrade) {
    return `<div class="lv-sc lv-sc--off">${head}
      <p class="lv-sc-sub"><b>No trade on this side now.</b> From the market the nearest zones give a net R:R of ${p.netRr.toFixed(2)} — the target is ${p.rewardPct.toFixed(2)}% away and the stop ${p.riskPct.toFixed(2)}%. No zone edge on this side clears ${MIN_RR} either. Wait for price to reach a zone, or read a higher timeframe.</p>
    </div>`;
  }
  const when = s.entryBars ? ` Price usually covered that distance in about ${spanText(s.entryBars, tf)}.` : "";
  const how = `${s.side === "long" ? "Limit buy" : "Limit sell"} ${pctTxt(dist)} from price. It fills only if price comes to the zone.${when}`;
  const cell = (label, value, sub, cls = "") => `<div class="lv-sc-cell${cls ? " " + cls : ""}">
      <span class="label">${label}</span><b class="mono">${value}</b>${sub ? `<small class="mono">${sub}</small>` : ""}
    </div>`;
  return `<button type="button" class="lv-sc lv-sc--${s.side}${on ? " is-on" : ""}" data-sc="${s.id}" aria-pressed="${on}">
    ${head}
    <p class="lv-sc-sub">${esc(how)}</p>
    <div class="lv-sc-grid">
      ${cell("Entry", fmtPx(p.entry), "")}
      ${cell("Stop", fmtPx(p.stop), pctTxt(-p.riskPct), "lv-sc-cell--stop")}
      ${cell("Target", fmtPx(p.target), pctTxt(p.rewardPct), "lv-sc-cell--target")}
      ${cell("Net R:R", p.netRr.toFixed(2), p.ok ? "clears 1.5" : "below 1.5", p.ok ? "lv-sc-cell--go" : "lv-sc-cell--no")}
    </div>
    ${oddsBlock(s, tf)}
  </button>`;
}

export function renderScenarios(node, scenarios, activeKey, data) {
  if (!node) return;
  if (!scenarios.length) {
    node.innerHTML = `<div class="lv-empty">No zones — nothing to build a scenario from.</div>`;
    return;
  }
  node.innerHTML = `<div class="lv-sc-pair">${scenarios
    .map((s) => scenarioCard(s, activeKey, data.price, data.tf))
    .join("")}</div>
    <div class="lv-warn">Both sides are shown on purpose. A strong trend in the window lifts one side's number and sinks the other's — that is the trend of the last weeks, not a forecast. Fibonacci and level retests were tested on five years of data and earned about the fees.</div>`;
}

export function renderSizing(node, plan, { equity, riskPct }) {
  if (!node) return;
  if (!plan || plan.incomplete) {
    node.innerHTML = `<div class="lv-empty">Pick a scenario or enter a price to size the trade.</div>`;
    return;
  }
  const z = sizing({ equity, riskPct, plan });
  if (!z) {
    node.innerHTML = `<div class="lv-empty">Fill in account size and risk per trade.</div>`;
    return;
  }
  const hot = z.leverage > LEV_CAP;
  const cell = (label, value, sub, cls = "") => `<div class="lv-num${cls ? " " + cls : ""}">
      <div class="label">${label}</div>
      <div class="lv-num-val mono">${value}</div>
      ${sub ? `<div class="lv-num-sub mono">${sub}</div>` : ""}
    </div>`;
  node.innerHTML = `<div class="lv-nums">
      ${cell("Position size", usd(z.notional), `${z.qty.toPrecision(4)} coins`)}
      ${cell("Leverage", `${z.leverage.toFixed(1)}×`, hot ? `above the ${LEV_CAP}× cap` : "", hot ? "lv-num--no" : "")}
      ${cell("Loss at stop", `−${usd(z.riskUsd)}`, "fees included", "lv-num--stop")}
      ${cell("Profit at target", `+${usd(z.profitUsd)}`, "after fees", "lv-num--target")}
    </div>`;
}
