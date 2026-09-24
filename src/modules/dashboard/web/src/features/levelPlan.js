// ─────────────────────────────────────────────────
//  Level plan — стоп, цель и плечо риска от механических зон.
//
//  Считает ровно одно решение: входить или нет. Стоп ставится за ближайшую
//  зону против позиции, цель — у ближайшей зоны по позиции, и дальше всё
//  решает число RR, а не вид графика.
//
//  🚨 Порог RR не украшение: при винрейте оператора сделка с RR ниже 1.5
//  имеет отрицательное матожидание после комиссий.
// ─────────────────────────────────────────────────

export const MIN_RR = 1.5;
export const ROUND_TRIP_BP = 8.64; // круг тейкером на HL
const BUFFER_ATR = 0.25; // стоп прячется за зону на эту долю ATR

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const fmtPx = (p) =>
  !Number.isFinite(p) ? "—" : p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);

const pct = (a, b) => (Math.abs(a - b) / b) * 100;

// Округление до того же шага, каким цена показана: сырой float в поле ввода и
// в заявке читается как мусор и не совпадает с числом на графике.
const roundPx = (p) =>
  !Number.isFinite(p)
    ? p
    : p >= 1000
      ? Math.round(p * 10) / 10
      : p >= 1
        ? Math.round(p * 1e4) / 1e4
        : Number(p.toPrecision(4));

/**
 * Строит план входа. Возвращает null, если с одной из сторон зоны нет:
 * без уровня для стопа или цели считать нечего, и угадывать их нельзя.
 */
export function buildPlan(data, { side, entry }) {
  if (!data || !Number.isFinite(entry) || entry <= 0) return null;
  const buf = (data.atr || 0) * BUFFER_ATR;

  const below = data.zones.filter((z) => z.hi < entry).sort((a, b) => b.price - a.price)[0];
  const above = data.zones.filter((z) => z.lo > entry).sort((a, b) => a.price - b.price)[0];

  const isLong = side === "long";
  const stopZone = isLong ? below : above;
  const targetZone = isLong ? above : below;
  if (!stopZone || !targetZone) {
    return { side, entry, incomplete: true, missing: stopZone ? "target" : "stop" };
  }

  // Стоп за дальний край зоны, цель — у ближнего: зона имеет ширину, и вход
  // в неё ещё не пробой.
  const stop = isLong ? stopZone.lo - buf : stopZone.hi + buf;
  const target = isLong ? targetZone.lo : targetZone.hi;

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const cost = entry * (ROUND_TRIP_BP / 10_000);
  const rr = risk > 0 ? reward / risk : 0;
  const netRr = risk > 0 ? Math.max(0, reward - cost) / (risk + cost) : 0;

  return {
    side,
    entry,
    stop,
    target,
    stopZone,
    targetZone,
    risk,
    reward,
    rr,
    netRr,
    cost,
    riskPct: pct(stop, entry),
    rewardPct: pct(target, entry),
    ok: netRr >= MIN_RR,
  };
}

// Стоп уже этого — риск вырождается в буфер, и отношение перестаёт быть отношением.
export const MIN_STOP_PCT = 0.15;

/**
 * Входы у краёв зон, где отношение проходит порог. Ближние к цене — первыми.
 * 🚨 Список симметричен по сторонам: зеркальный вход с другой стороны зоны даёт
 * то же число. Это геометрия, а не выбор направления.
 */
export function greenEntries(data, side) {
  if (!data?.zones?.length || !Number.isFinite(data.price)) return [];
  const isLong = side === "long";
  const out = [];
  for (const zone of data.zones) {
    // Вход чуть ЗА краем зоны: ровно на границе она не попадёт в опору.
    const entry = roundPx(isLong ? zone.hi * (1 + 1e-6) : zone.lo * (1 - 1e-6));
    // 🚨 Лимитка стоит по свою сторону рынка: покупка ниже цены, продажа выше.
    // Иначе ордер исполнится сразу по рынку, и план посчитан не про этот вход.
    if (isLong ? entry >= data.price : entry <= data.price) continue;
    // План строится от округлённой цены: в поле, на графике и в ордере одно число.
    const plan = buildPlan(data, { side, entry });
    if (!plan || plan.incomplete || !plan.ok || plan.riskPct < MIN_STOP_PCT) continue;
    out.push({ ...plan, entry, distPct: ((entry - data.price) / data.price) * 100 });
  }
  return out.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
}

function verdictBlock(plan) {
  if (plan.incomplete) {
    return `<div class="lv-verdict lv-verdict--none">
      <b>No trade</b>
      <span>No mechanical zone ${plan.missing === "stop" ? "behind the entry for a stop" : "ahead of the entry for a target"}. Without a level on both sides the ratio cannot be computed — and a guessed level is not a level.</span>
    </div>`;
  }
  const ok = plan.ok;
  return `<div class="lv-verdict ${ok ? "lv-verdict--go" : "lv-verdict--no"}">
    <b>${ok ? "Ratio clears the floor" : "No trade"}</b>
    <span>${
      ok
        ? `Net ratio ${plan.netRr.toFixed(2)} is at or above the ${MIN_RR} floor. The floor is a threshold, not a signal: it says the geometry is payable, not that the direction is right.`
        : `Net ratio ${plan.netRr.toFixed(2)} is below the ${MIN_RR} floor. Do not move the stop closer to make it fit — that is how the floor stops meaning anything.`
    }</span>
  </div>`;
}

function numbers(plan) {
  if (plan.incomplete) return "";
  const row = (label, value, sub, cls = "") =>
    `<div class="lv-num${cls ? " " + cls : ""}">
      <div class="label">${esc(label)}</div>
      <div class="lv-num-val mono">${esc(value)}</div>
      ${sub ? `<div class="lv-num-sub mono">${esc(sub)}</div>` : ""}
    </div>`;
  return `<div class="lv-nums">
    ${row("Entry", fmtPx(plan.entry), "")}
    ${row("Stop", fmtPx(plan.stop), `−${plan.riskPct.toFixed(2)}% · behind ${plan.stopZone.sources.join("+")}`, "lv-num--stop")}
    ${row("Target", fmtPx(plan.target), `+${plan.rewardPct.toFixed(2)}% · at ${plan.targetZone.sources.join("+")}`, "lv-num--target")}
    ${row("Net R:R", plan.netRr.toFixed(2), `gross ${plan.rr.toFixed(2)} · fees ${ROUND_TRIP_BP} bp`, plan.ok ? "lv-num--go" : "lv-num--no")}
  </div>`;
}

/** Правило выведено из журнала оператора, а не из теории, поэтому висит рядом. */
function longWarning(side) {
  if (side !== "long") return "";
  return `<div class="lv-warn">Longs ran at a loss across the journal while shorts did not. Taking one needs a reason beyond this chart.</div>`;
}

export function renderPlan(node, plan, side) {
  if (!node) return;
  if (!plan) {
    node.innerHTML = `<div class="lv-empty">Enter a price to build the plan.</div>`;
    return;
  }
  node.innerHTML = verdictBlock(plan) + numbers(plan) + longWarning(side);
}

/**
 * Готовые входы у зон. Считаются сами при каждой загрузке: цена по рынку почти
 * всегда даёт негодную геометрию, и без этого списка страница выглядит так,
 * будто входа нет вообще.
 */
export function renderSuggestions(node, data, side) {
  if (!node) return;
  if (!data) {
    node.innerHTML = "";
    return;
  }
  const list = greenEntries(data, side);
  if (!list.length) {
    node.innerHTML = `<div class="lv-empty">No entry on this side clears the ${MIN_RR} floor with a stop wider than ${MIN_STOP_PCT}% of price.</div>`;
    return;
  }
  const rows = list
    .map(
      (p) => `<tr>
        <td class="mono strong">${fmtPx(p.entry)}</td>
        <td class="num mono muted">${p.distPct >= 0 ? "+" : "−"}${Math.abs(p.distPct).toFixed(2)}%</td>
        <td class="num mono">${p.riskPct.toFixed(2)}%</td>
        <td class="num mono">${p.rewardPct.toFixed(2)}%</td>
        <td class="num mono strong">${p.netRr.toFixed(2)}</td>
        <td class="muted">${esc(p.stopZone.sources.join("+"))}</td>
        <td><button class="btn btn--sm btn--${side === "long" ? "long" : "short"}" type="button" data-entry="${p.entry}">Use</button></td>
      </tr>`,
    )
    .join("");
  node.innerHTML = `
    <div class="lv-note">These are resting limit prices, not the price right now. A long waits
      below the market and a short waits above it, so the order fills only if price comes back to
      the zone — the distance column says how far that is. Nothing happens until it does.</div>
    <table class="table table--compact">
      <thead><tr>
        <th>Entry</th><th class="num">Distance</th><th class="num">Stop</th>
        <th class="num">Target</th><th class="num">Net R:R</th><th>Stop behind</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="lv-warn">The same list exists for the other side at nearly the same ratios — the number is built from distances, so it is mirror-symmetric. It says the geometry pays, never which way price goes.</div>`;
}

/** Таблица зон: то же, что на графике, но с расстоянием до цены. */
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
        <th>Price</th><th class="num">Distance</th><th class="num">Touches</th>
        <th>Built from</th><th class="num">Strength</th>
      </tr></thead>
      <tbody>${rows
        .map((z) => {
          const above = z.price > data.price;
          const d = pct(z.price, data.price);
          return `<tr class="${above ? "lv-row--above" : "lv-row--below"}">
            <td class="mono strong">${fmtPx(z.price)}</td>
            <td class="num mono ${above ? "down" : "up"}">${above ? "+" : "−"}${d.toFixed(2)}%</td>
            <td class="num mono">${z.touches}</td>
            <td class="muted">${esc(z.sources.join(" + "))}</td>
            <td class="num mono">${z.strength}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

/** Расшифровка источников: читатель должен знать, из чего линия, а не верить ей. */
export const SOURCE_NOTE =
  "swing — a bar whose high or low stands above five bars on each side · pdh/pdl — previous UTC day high and low · poc/vah/val — volume profile point of control and value area edges · round — round number. Nearby levels merge into one zone when they sit within 0.35 ATR.";
