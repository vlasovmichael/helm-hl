// ─────────────────────────────────────────────────
//  Levels chart — свечи, зоны прямоугольниками и коробка плана.
//  Фигуры — SVG-слой поверх графика, пересчитываемый при сдвиге и масштабе.
//  Клик ловит сам график: слой пропускает мышь, иначе по зонам не тащится шкала.
// ─────────────────────────────────────────────────

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SVG_NS = "http://www.w3.org/2000/svg";

function themeColors() {
  return {
    bg: cssVar("--card-bg") || "#0d1117",
    text: cssVar("--text-secondary") || "#8b949e",
    grid: cssVar("--border") || "rgba(127,127,127,0.18)",
    up: cssVar("--pnl-up") || "#0ecb81",
    down: cssVar("--pnl-down") || "#f6465d",
  };
}

// Пустые бары справа от последней свечи: в них стоит коробка плана.
const FUTURE_BARS = 30;
const VISIBLE_BARS = 160;
const HIT_PX = 5; // допуск клика по тонкой зоне

let chart = null;
let candles = null;
let overlay = null;
let host = null;
let bars = [];
let scene = { zones: [], plan: null, thin: [] };
let axisLines = [];
let onPick = () => {};

const fmtPx = (p) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));

export async function drawLevels(container, data, pick) {
  if (!container || !Array.isArray(data?.candles) || !data.candles.length) return false;
  onPick = pick;

  if (!chart || !container.contains(chart.chartElement())) {
    container.innerHTML = "";
    host = container;
    const { createChart, CandlestickSeries } = await import("lightweight-charts");
    const c = themeColors();
    chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: "solid", color: c.bg },
        textColor: c.text,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: c.grid, timeVisible: true, secondsVisible: false, rightOffset: FUTURE_BARS },
      crosshair: { mode: 0 },
    });
    candles = chart.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderUpColor: c.up,
      borderDownColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
      priceFormat: { type: "custom", formatter: fmtPx },
      // Стоп и цель плана должны влезать в шкалу, иначе коробка уезжает за край.
      autoscaleInfoProvider: (base) => {
        const r = base();
        const p = scene.plan;
        if (!r || !p || p.incomplete) return r;
        return {
          ...r,
          priceRange: {
            minValue: Math.min(r.priceRange.minValue, p.stop, p.target),
            maxValue: Math.max(r.priceRange.maxValue, p.stop, p.target),
          },
        };
      },
    });

    overlay = document.createElementNS(SVG_NS, "svg");
    overlay.classList.add("lv-overlay");
    overlay.setAttribute("aria-hidden", "true");
    container.appendChild(overlay);

    chart.subscribeClick((e) => {
      const z = e.point && zoneAt(e.point);
      if (z) onPick(z);
    });
    chart.subscribeCrosshairMove((e) => {
      host.classList.toggle("is-zone-hover", Boolean(e.point && zoneAt(e.point)));
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(renderOverlay);
    new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      renderOverlay();
    }).observe(container);
  }

  bars = data.candles;
  candles.setData(bars);
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, bars.length - 1 - VISIBLE_BARS),
    to: bars.length - 1 + FUTURE_BARS,
  });
  return true;
}

/** Зоны, тонкие коридоры профиля и выбранный план. Цена зоны и плана подписана на шкале справа. */
export function drawScene(zones, plan, thin = []) {
  if (!candles) return;
  scene = { zones, plan, thin };
  for (const l of axisLines) candles.removePriceLine(l);
  axisLines = [];
  const c = themeColors();
  const label = (price, color, title) =>
    axisLines.push(candles.createPriceLine({ price, color, lineVisible: false, axisLabelVisible: true, title }));
  for (const z of zones) label(z.price, z.name.startsWith("R") ? c.down : c.up, z.name);
  if (plan && !plan.incomplete) {
    label(plan.entry, cssVar("--text-primary") || "#e6edf3", "entry");
    label(plan.stop, c.down, "stop");
    label(plan.target, c.up, "target");
  }
  chart.priceScale("right").applyOptions({ autoScale: true });
  requestAnimationFrame(renderOverlay);
}

/** Зона начинается с первой свечи, которая в неё зашла. */
function firstTouch(z) {
  const i = bars.findIndex((b) => b.high >= z.lo && b.low <= z.hi);
  return i < 0 ? 0 : i;
}

function zoneAt(point) {
  for (const z of scene.zones) {
    const top = candles.priceToCoordinate(z.hi);
    const bottom = candles.priceToCoordinate(z.lo);
    const left = chart.timeScale().logicalToCoordinate(firstTouch(z));
    if (top == null || bottom == null) continue;
    if (point.y >= top - HIT_PX && point.y <= bottom + HIT_PX && point.x >= (left ?? 0)) return z;
  }
  return null;
}

function node(tag, attrs, cls) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (cls) n.setAttribute("class", cls);
  return n;
}

const tier = (s) => (s >= 8 ? "strong" : s >= 4 ? "mid" : "weak");

function renderOverlay() {
  if (!overlay || !chart) return;
  overlay.replaceChildren();
  const ts = chart.timeScale();
  const x = (i) => ts.logicalToCoordinate(i);
  const y = (p) => candles.priceToCoordinate(p);
  const right = x(bars.length - 1 + FUTURE_BARS);
  if (right == null) return;
  const plan = scene.plan && !scene.plan.incomplete ? scene.plan : null;

  // Коридоры под зонами: это фон, клик по ним не ловится.
  const left0 = Math.max(0, x(0) ?? 0);
  for (const t of scene.thin) {
    const top = y(t.hi);
    const bottom = y(t.lo);
    if (top == null || bottom == null) continue;
    overlay.appendChild(
      node("rect", { x: left0, y: top, width: Math.max(0, right - left0), height: Math.max(2, bottom - top) }, "lv-thin"),
    );
    const label = node("text", { x: right - 8, y: top + 14 }, "lv-thin-name");
    label.textContent = "thin";
    overlay.appendChild(label);
  }

  for (const z of scene.zones) {
    const top = y(z.hi);
    const bottom = y(z.lo);
    if (top == null || bottom == null) continue;
    const left = Math.max(0, x(firstTouch(z)) ?? 0);
    const side = z.name.startsWith("R") ? "res" : "sup";
    const on = plan && (plan.stopZone === z || plan.targetZone === z) ? " is-on" : "";
    overlay.appendChild(
      node(
        "rect",
        { x: left, y: top, width: Math.max(0, right - left), height: Math.max(2, bottom - top) },
        `lv-zone lv-zone--${side} lv-zone--${tier(z.strength)}${on}`,
      ),
    );
    const t = node("text", { x: left + 6, y: top - 4 }, `lv-zone-name lv-zone-name--${side}`);
    t.textContent = z.name;
    overlay.appendChild(t);
  }

  if (plan) drawBox(plan, x(bars.length + 1), right - 8, y);
}

/** Коробка сделки: зелёная от входа до цели, красная от входа до стопа. */
function drawBox(plan, x0, x1, y) {
  const ye = y(plan.entry);
  const ys = y(plan.stop);
  const yt = y(plan.target);
  if ([x0, ye, ys, yt].some((v) => v == null) || x1 <= x0) return;
  const rect = (ya, yb, cls) =>
    overlay.appendChild(
      node("rect", { x: x0, y: Math.min(ya, yb), width: x1 - x0, height: Math.abs(yb - ya) }, cls),
    );
  rect(ye, yt, "lv-box lv-box--win");
  rect(ye, ys, "lv-box lv-box--loss");
  overlay.appendChild(node("line", { x1: x0, x2: x1, y1: ye, y2: ye }, "lv-box-entry"));

  const up = plan.target > plan.entry;
  const label = (yy, text, cls, below) => {
    const t = node("text", { x: x0 + 6, y: yy + (below ? 14 : -6) }, `lv-box-label ${cls}`);
    t.textContent = text;
    overlay.appendChild(t);
  };
  label(yt, `target +${plan.rewardPct.toFixed(2)}%`, "lv-box-label--win", !up);
  label(ys, `stop −${plan.riskPct.toFixed(2)}%`, "lv-box-label--loss", up);
  label(ye, `${plan.side} · R:R ${plan.netRr.toFixed(2)}`, "lv-box-label--entry", !up);
}

/** Перекраска под тему: bindTheme зовёт это при смене. */
export function applyLevelsTheme() {
  if (!chart) return;
  const c = themeColors();
  chart.applyOptions({
    layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
    grid: { horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid },
  });
  drawScene(scene.zones, scene.plan, scene.thin);
}
