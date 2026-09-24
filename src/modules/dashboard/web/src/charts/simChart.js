// ─────────────────────────────────────────────────
//  Свечи тренажёра стакана. Времени у модели нет: свеча получает порядковый
//  номер как минуту, и шкала показывает очерёдность, а не часы.
// ─────────────────────────────────────────────────

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function themeColors() {
  return {
    bg: cssVar("--card-bg") || "#0d1117",
    text: cssVar("--text-secondary") || "#8b949e",
    grid: cssVar("--border") || "rgba(127,127,127,0.18)",
    up: cssVar("--pnl-up") || "#0ecb81",
    down: cssVar("--pnl-down") || "#f6465d",
    warn: cssVar("--warn") || "#d29922",
  };
}

const BASE_TS = 1_700_000_000;

let chart = null;
let series = null;
let formingLine = null;

export async function mountSimChart(container) {
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
    rightPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid, visible: false, rightOffset: 4 },
    crosshair: { mode: 0 },
  });
  series = chart.addSeries(CandlestickSeries, {
    upColor: c.up,
    downColor: c.down,
    borderUpColor: c.up,
    borderDownColor: c.down,
    wickUpColor: c.up,
    wickDownColor: c.down,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });
  new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  }).observe(container);
}

/** candles: [{ n, o, h, l, c }]; forming — незакрытая свеча или null. */
export function drawSimCandles(candles, forming) {
  if (!series) return;
  const all = forming ? [...candles, forming] : candles;
  series.setData(
    all.map((k) => ({ time: BASE_TS + k.n * 60, open: k.o, high: k.h, low: k.l, close: k.c })),
  );
  if (formingLine) series.removePriceLine(formingLine);
  formingLine = forming
    ? series.createPriceLine({
        price: forming.c,
        color: themeColors().warn,
        lineStyle: 2,
        lineWidth: 1,
        axisLabelVisible: true,
        title: "forming",
      })
    : null;
  chart.timeScale().fitContent();
}

export function applySimTheme() {
  if (!chart) return;
  const c = themeColors();
  chart.applyOptions({
    layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
    grid: { horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid },
  });
}
