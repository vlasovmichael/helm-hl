// ─────────────────────────────────────────────────
//  Levels chart — свечи и механические уровни поверх них.
//  Линии зон и линии плана (вход, стоп, цель) живут раздельно: план
//  перерисовывается на каждый ввод, зоны — только при смене монеты или ТФ.
// ─────────────────────────────────────────────────

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function themeColors() {
  return {
    bg: cssVar("--card-bg") || "#0d1117",
    text: cssVar("--text-secondary") || "#8b949e",
    grid: cssVar("--border") || "rgba(127,127,127,0.18)",
    up: cssVar("--pnl-up") || "#0ecb81",
    down: cssVar("--pnl-down") || "#f6465d",
  };
}

let chart = null;
let candles = null;
let zoneLines = [];
let planLines = [];

const fmtPx = (p) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));

/** Подпись зоны: чем её подтвердили и сколько раз цена в неё заходила. */
const zoneTitle = (z) => `${z.sources.join("+")} ×${z.touches}`;

export async function drawLevels(container, data) {
  if (!container || !Array.isArray(data?.candles) || !data.candles.length) return false;

  if (!chart || !container.contains(chart.chartElement())) {
    container.innerHTML = "";
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
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: c.grid, timeVisible: true, secondsVisible: false, rightOffset: 4 },
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
    });
    new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }).observe(container);
  }

  candles.setData(data.candles);
  drawZones(data);
  chart.timeScale().fitContent();
  return true;
}

/** Зоны рисуются ценовыми линиями: горизонталь — и есть весь смысл уровня. */
function drawZones(data) {
  for (const l of zoneLines) candles.removePriceLine(l);
  zoneLines = [];
  const c = themeColors();
  for (const z of data.zones) {
    const above = z.price > data.price;
    zoneLines.push(
      candles.createPriceLine({
        price: z.price,
        color: above ? c.down : c.up,
        // Толщина несёт силу зоны: больше касаний и источников — заметнее линия.
        lineWidth: z.strength >= 8 ? 2 : 1,
        lineStyle: z.strength >= 8 ? 0 : 2,
        axisLabelVisible: true,
        title: zoneTitle(z),
      }),
    );
  }
}

/** Линии плана. plan = null снимает их: без числа рисовать нечего. */
export function drawPlan(plan) {
  if (!candles) return;
  for (const l of planLines) candles.removePriceLine(l);
  planLines = [];
  if (!plan) return;
  const c = themeColors();
  const rows = [
    { price: plan.entry, color: cssVar("--text-primary") || "#e6edf3", title: "entry" },
    { price: plan.stop, color: c.down, title: "stop" },
    { price: plan.target, color: c.up, title: "target" },
  ];
  for (const r of rows) {
    if (!Number.isFinite(r.price)) continue;
    planLines.push(
      candles.createPriceLine({
        price: r.price,
        color: r.color,
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: r.title,
      }),
    );
  }
}

/** Перекраска под тему: bindTheme зовёт это при смене. */
export function applyLevelsTheme() {
  if (!chart) return;
  const c = themeColors();
  chart.applyOptions({
    layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid },
  });
}

export function clearLevels() {
  if (!chart) return;
  chart.remove();
  chart = null;
  candles = null;
  zoneLines = [];
  planLines = [];
}
