// ─────────────────────────────────────────────────
//  Price Chart (lean) — свечи + объём для одной монеты. Дефолт BTC; клик по
//  строке Hot Movers зовёт setChartCoin(coin) и переключает график. Без линий
//  позиции/маркеров сделок/ордербука — это «монитор цены», не торговый оверлей.
//  Лениво грузит lightweight-charts (отдельный чанк), полит /api/candles.
// ─────────────────────────────────────────────────

import { cssVar } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

let priceChart = null;
let priceSeries = null;
let volumeSeries = null;
let currentInterval = "5m";
let currentCoin = "BTC";
let pollTimer = null;
let chartViewKey = null; // coin+interval — fitContent только при смене

// Цены идут с биржи реже, чем interval; 15s-поллинг дёргает /api/candles,
// который кэширует ответ (TTL по interval) → HL не штормит.
const POLL_MS = 15_000;

function tvSymbol(coin) {
  const sym = String(coin).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `BINANCE:${sym}USDT`;
}

function buildCandleData(candles) {
  return candles
    .map((c) => ({
      time: Math.floor(c.t / 1000),
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
    }))
    .filter((d) => Number.isFinite(d.open) && Number.isFinite(d.close))
    .sort((a, b) => a.time - b.time);
}

function buildVolumeData(candles) {
  const seen = new Set();
  const out = [];
  for (const c of candles) {
    const time = Math.floor(c.t / 1000);
    if (seen.has(time)) continue;
    seen.add(time);
    const v = parseFloat(c.v);
    if (!Number.isFinite(v)) continue;
    const bullish = parseFloat(c.c) >= parseFloat(c.o);
    out.push({
      time,
      value: v,
      color: bullish ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function syncBtcBtn() {
  document
    .getElementById("price-chart-btc")
    ?.classList.toggle("active", currentCoin === "BTC");
}

function showLoader() {
  document.getElementById("price-chart-loader")?.classList.remove("hidden");
}
function hideLoader() {
  document.getElementById("price-chart-loader")?.classList.add("hidden");
}

function setMeta(price) {
  const el = document.getElementById("price-chart-meta");
  if (el && Number.isFinite(price)) {
    el.textContent = `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }
}

async function loadCandles() {
  if (!priceSeries) return;
  try {
    const candles = await fetchJson(
      `/api/candles?coin=${encodeURIComponent(currentCoin)}&interval=${currentInterval}`,
    );
    if (!Array.isArray(candles) || candles.length === 0) {
      hideLoader();
      return;
    }
    const data = buildCandleData(candles);
    if (!data.length) {
      hideLoader();
      return;
    }
    priceSeries.setData(data);
    if (volumeSeries) volumeSeries.setData(buildVolumeData(candles));
    setMeta(data[data.length - 1].close);

    const key = `${currentCoin}:${currentInterval}`;
    if (chartViewKey !== key) {
      priceChart.timeScale().fitContent();
      chartViewKey = key;
    }
    hideLoader();
  } catch (err) {
    console.debug("[PriceChart] fetch error:", err.message);
    hideLoader();
  }
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(loadCandles, POLL_MS);
}

// Переключить монету графика (зовёт Hot Movers по клику + setup-scanner и т.д.).
export function setChartCoin(coin) {
  const clean = String(coin || "")
    .replace(/-PERP$/i, "")
    .replace(/^@/, "")
    .trim();
  if (!clean || clean === currentCoin) return;
  currentCoin = clean;
  chartViewKey = null; // принудительный fitContent на новой монете
  const label = document.getElementById("price-chart-coin");
  if (label) label.textContent = clean;
  const tv = document.getElementById("price-chart-tv");
  if (tv)
    tv.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(clean))}`;
  syncBtcBtn();
  showLoader();
  loadCandles();
}

export function applyPriceChartTheme() {
  if (!priceChart) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = cssVar("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const gridColor = cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF");
  priceChart.applyOptions({
    layout: { background: { type: "solid", color: bgColor }, textColor },
    grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
    rightPriceScale: { borderColor: gridColor },
    timeScale: { borderColor: gridColor },
  });
}

function bindIntervalButtons() {
  document.querySelectorAll("#price-intervals .range-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.iv === currentInterval) return;
      document
        .querySelectorAll("#price-intervals .range-btn")
        .forEach((r) => r.classList.remove("active"));
      b.classList.add("active");
      currentInterval = b.dataset.iv;
      chartViewKey = null; // смена ТФ → fitContent под новые данные
      showLoader();
      await loadCandles();
    }),
  );
}

export async function initPriceChart() {
  const container = document.getElementById("price-chart");
  if (!container || priceChart) return;

  // lightweight-charts грузим лениво (отдельный чанк) — нужен только здесь.
  const { createChart } = await import("lightweight-charts");

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = cssVar("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const gridColor = cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

  priceChart = createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: "solid", color: bgColor },
      textColor,
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: gridColor },
      horzLines: { color: gridColor },
    },
    rightPriceScale: { borderColor: gridColor },
    timeScale: {
      borderColor: gridColor,
      timeVisible: true,
      secondsVisible: false,
      barSpacing: 10,
      minBarSpacing: 4,
      rightOffset: 4,
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      },
    },
    localization: {
      timeFormatter: (time) => {
        const d = new Date(time * 1000);
        const dd = String(d.getDate()).padStart(2, "0");
        const mo = String(d.getMonth() + 1).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        return `${dd}.${mo} ${hh}:${mi}`;
      },
    },
    crosshair: { mode: 0 },
    handleScroll: true,
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  priceSeries = priceChart.addCandlestickSeries({
    upColor: "#22C55E",
    downColor: "#EF4444",
    borderUpColor: "#22C55E",
    borderDownColor: "#EF4444",
    wickUpColor: "#22C55E",
    wickDownColor: "#EF4444",
  });
  priceSeries
    .priceScale()
    .applyOptions({ scaleMargins: { top: 0.12, bottom: 0.28 } });

  volumeSeries = priceChart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "vol",
    color: "#22C55E",
    priceLineVisible: false,
    lastValueVisible: false,
  });
  priceChart.priceScale("vol").applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
    borderVisible: false,
    visible: false,
  });

  if (!window.__priceChartResizeBound) {
    window.__priceChartResizeBound = true;
    window.addEventListener("resize", () => {
      if (priceChart && container)
        priceChart.resize(container.clientWidth, container.clientHeight);
    });
  }

  // TV-ссылка в шапке (глубокий анализ) — на текущую монету графика.
  const tv = document.getElementById("price-chart-tv");
  if (tv)
    tv.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(currentCoin))}`;

  bindIntervalButtons();
  document
    .getElementById("price-chart-btc")
    ?.addEventListener("click", () => setChartCoin("BTC"));
  syncBtcBtn();
  await loadCandles();
  startPoll();
}
