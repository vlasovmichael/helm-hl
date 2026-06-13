// ─────────────────────────────────────────────────
//  Price Chart — свечи + объём + entry/current линии + live-свеча + маркеры
//  сделок. Лениво инициализируется при первом рендере (initPriceChart внутри).
//  Приватное состояние; handlePriceChartUpdate зовёт WS, applyPriceChartTheme —
//  applyTheme, initPriceChartUi (биндинг кнопок ТФ) — bootstrap.
// ─────────────────────────────────────────────────

import { cssVar } from "../utils/format.js";
import { fetchJson } from "../net/api.js";
import { subscribeOrderBook } from "../net/orderbook.js";

let priceChart = null;
let priceSeries = null;
let volumeSeries = null;
let entryPriceLine = null;
let currentPriceLine = null;
let liveCandle = null; // {time, open, high, low, close}
let currentInterval = "5m";
const INTERVAL_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
let idleChartCoin = null;
let idleChartTimer = null;
let posChartTimer = null;
let lastPosCandlesAt = 0;
let currentCoinInPos = null;
let lastPos = null;
let chartViewKey = null; // coin+interval — для сохранения зума при тех же данных

// ── Price Chart Logic ────────────────────────────

function manualToPos(mp) {
  if (!mp) return null;
  const sizeUsd = Number.isFinite(mp.sizeUsd) ? mp.sizeUsd : 0;
  const entry = Number.isFinite(mp.entryPrice) ? mp.entryPrice : 0;
  const live = Number.isFinite(mp.currentPrice) ? mp.currentPrice : null;
  const pnlPrice = Number.isFinite(mp.unrealizedPnl) ? mp.unrealizedPnl : 0;
  const cleanCoin = String(mp.coin || "")
    .replace(/-PERP$/i, "")
    .replace(/^@/, "");
  return {
    coin: cleanCoin,
    side: (mp.side || "SHORT").toUpperCase(),
    sizeUsd,
    entryPrice: entry,
    currentPrice: live,
    currentPnl: {
      price: pnlPrice,
      funding: 0,
      entryFee: 0,
      exitFeeMarket: 0,
      exitFeeMaker: 0,
      netMarket: pnlPrice,
      netMaker: pnlPrice,
    },
    _manual: true,
  };
}

export async function handlePriceChartUpdate(pos, manualPositions) {
  const card = document.getElementById("price-card");
  // Price-chart card удалён из дашборды (свечи смотрим в TradingView).
  // Этот guard глушит всю свечную подсистему: idle-чарт, fetch свечей,
  // orderbook-подписку — всё ниже по течению вызывается только отсюда.
  if (!card) return;
  card.style.display = "block";

  // Если бот-позиции нет, но есть ручная — показываем её на графике
  if (!pos && Array.isArray(manualPositions) && manualPositions.length > 0) {
    pos = manualToPos(manualPositions[0]);
  }

  if (!pos) {
    lastPos = null;
    currentCoinInPos = null;
    if (posChartTimer) {
      clearInterval(posChartTimer);
      posChartTimer = null;
    }
    await renderIdleChart();
    return;
  }

  // Позиция появилась → выключаем idle-режим
  if (idleChartTimer) {
    clearInterval(idleChartTimer);
    idleChartTimer = null;
  }
  idleChartCoin = null;

  // Периодический re-fetch реальных свечей с биржи, пока позиция открыта —
  // иначе график живёт на синтетике от livePrice и со временем "замерзает".
  if (!posChartTimer) {
    posChartTimer = setInterval(() => {
      if (lastPos && Date.now() - lastPosCandlesAt > 25_000) {
        const price = Number.isFinite(lastPos.currentPrice)
          ? lastPos.currentPrice
          : lastPos.entryPrice;
        fetchAndRenderCandles(lastPos, price);
      }
    }, 30_000);
  }

  lastPos = pos;
  document.getElementById("price-title").textContent =
    `Price Performance: #${pos.coin}`;

  let currentPrice = pos.entryPrice;
  if (Number.isFinite(pos.currentPrice) && pos.currentPrice > 0) {
    currentPrice = pos.currentPrice;
  } else if (pos.currentPnl && pos.sizeUsd > 0 && pos.entryPrice > 0) {
    // Фолбэк когда livePrice не пришёл: вывести из unrealized pnl.
    // SHORT: pnl>0 ⇒ цена упала; LONG: pnl>0 ⇒ цена выросла.
    const qty = pos.sizeUsd / pos.entryPrice;
    const sideSign = (pos.side || "SHORT").toUpperCase() === "SHORT" ? -1 : 1;
    currentPrice = pos.entryPrice + sideSign * (pos.currentPnl.price / qty);
  }

  document.getElementById("price-meta").textContent =
    `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

  if (currentCoinInPos !== pos.coin) {
    currentCoinInPos = pos.coin;
    subscribeOrderBook(pos.coin);
    await fetchAndRenderCandles(pos, currentPrice);
  } else if (priceSeries) {
    tickLiveCandle(currentPrice, pos);
    updateCurrentLine(currentPrice);
  }
}

async function getLatestActivityCoin() {
  try {
    const act = await fetchJson("/api/activity?hours=720&limit=1");
    return act?.events?.[0]?.coin || "BTC";
  } catch {
    return "BTC";
  }
}

async function refreshIdleTick() {
  const coin = await getLatestActivityCoin();
  if (coin !== idleChartCoin) {
    idleChartCoin = coin;
    chartViewKey = null; // принудительно перецентрировать график на новой монете
    document.getElementById("price-title").textContent =
      `Price Performance: #${coin}`;
    subscribeOrderBook(coin);
  }
  await fetchAndRenderIdleCandles(idleChartCoin);
}

async function renderIdleChart() {
  // Определяем актуальную монету каждый раз — последнюю сделку из истории
  const coin = await getLatestActivityCoin();
  if (coin !== idleChartCoin) {
    idleChartCoin = coin;
    chartViewKey = null;
  }

  document.getElementById("price-title").textContent =
    `Price Performance: #${coin}`;

  subscribeOrderBook(coin);
  await fetchAndRenderIdleCandles(coin);

  if (!idleChartTimer) {
    idleChartTimer = setInterval(refreshIdleTick, 30_000);
  }
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
    const open = parseFloat(c.o);
    const close = parseFloat(c.c);
    const bullish = close >= open;
    out.push({
      time,
      value: v,
      color: bullish ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Окно истории под markers зависит от выбранного TF графика.
// Берём с запасом — lightweight-charts отрисует только то, что в видимой области.
const MARKER_WINDOW_HOURS = {
  "1m": 4,
  "5m": 16,
  "15m": 48,
  "1h": 168,
  "4h": 720,
  "1d": 720,
};

async function applyTradeMarkers(coin) {
  if (!priceSeries || !coin) return;
  try {
    const hours = MARKER_WINDOW_HOURS[currentInterval] || 168;
    const payload = await fetchJson(
      `/api/trade-markers?coin=${encodeURIComponent(coin)}&hours=${hours}`,
    );
    const events = Array.isArray(payload?.events) ? payload.events : [];
    if (events.length === 0) {
      priceSeries.setMarkers([]);
      return;
    }
    const markers = events
      .map((ev) => {
        const time = Math.floor(ev.ts / 1000);
        if (ev.kind === "entry") {
          const isShort = ev.side === "short";
          return {
            time,
            position: isShort ? "aboveBar" : "belowBar",
            color: isShort ? "#ef4444" : "#22c55e",
            shape: isShort ? "arrowDown" : "arrowUp",
            text: `${ev.active ? "⏵ " : ""}${(ev.side || "short").toUpperCase()} @${ev.price?.toFixed?.(4) ?? ""}`,
          };
        }
        // close
        const pnlPos = ev.pnl > 0;
        return {
          time,
          position: "inBar",
          color: pnlPos ? "#22c55e" : ev.pnl < 0 ? "#ef4444" : "#a3a3a3",
          shape: "circle",
          text: `${pnlPos ? "+" : ""}$${(ev.pnl ?? 0).toFixed(2)} · ${ev.reason || ""}`,
        };
      })
      .sort((a, b) => a.time - b.time);
    // dedup на тот же time (lightweight-charts требует строго возрастающие)
    const dedup = [];
    let lastTime = -Infinity;
    for (const m of markers) {
      if (m.time <= lastTime) m.time = lastTime + 1;
      lastTime = m.time;
      dedup.push(m);
    }
    priceSeries.setMarkers(dedup);
  } catch (err) {
    console.debug("[PriceChart] markers fetch failed:", err.message);
  }
}

// ── Local loaders ────────────────────────────────
// Спиннер показываем на первичной загрузке (видим по умолчанию из HTML) и при
// смене таймфрейма / диапазона. Фоновый refresh спиннер не дёргает — только
// прячет (no-op, если уже спрятан), иначе график мигал бы на каждом тике.
function showPriceChartLoader() {
  const el = document.getElementById("price-chart-loader");
  if (el) el.classList.remove("hidden");
}
function hidePriceChartLoader() {
  const el = document.getElementById("price-chart-loader");
  if (el) el.classList.add("hidden");
}
// Performance (equity chart) — оверлей #chart-loader.
function showChartLoader() {
  const el = document.getElementById("chart-loader");
  if (el) el.classList.remove("hidden");
}
function hideChartLoader() {
  const el = document.getElementById("chart-loader");
  if (el) el.classList.add("hidden");
}

async function fetchAndRenderIdleCandles(coin) {
  if (!coin) return;
  try {
    const candles = await fetchJson(
      `/api/candles?coin=${coin}&interval=${currentInterval}`,
    );
    if (!Array.isArray(candles) || candles.length === 0) return;

    const data = candles
      .map((c) => ({
        time: Math.floor(c.t / 1000),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
      }))
      .filter((d) => Number.isFinite(d.open) && Number.isFinite(d.close))
      .sort((a, b) => a.time - b.time);

    await initPriceChart();
    priceSeries.setData(data);
    if (volumeSeries) volumeSeries.setData(buildVolumeData(candles));
    const last = data[data.length - 1];
    liveCandle = {
      time: last.time,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    };

    // В idle-режиме убираем линии entry/now
    if (entryPriceLine) {
      priceSeries.removePriceLine(entryPriceLine);
      entryPriceLine = null;
    }
    if (currentPriceLine) {
      priceSeries.removePriceLine(currentPriceLine);
      currentPriceLine = null;
    }

    document.getElementById("price-meta").textContent =
      `$${last.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

    const newKey = `idle:${coin}:${currentInterval}`;
    if (chartViewKey !== newKey) {
      priceChart.timeScale().fitContent();
      chartViewKey = newKey;
    }
    applyTradeMarkers(coin);
    hidePriceChartLoader();
  } catch (err) {
    console.error("[PriceChart/idle] fetch error:", err);
  }
}

async function fetchAndRenderCandles(pos, currentPrice) {
  try {
    const candles = await fetchJson(
      `/api/candles?coin=${pos.coin}&interval=${currentInterval}`,
    );
    if (!Array.isArray(candles) || candles.length === 0) return;
    lastPosCandlesAt = Date.now();

    const data = candles
      .map((c) => ({
        time: Math.floor(c.t / 1000),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
      }))
      .filter((d) => Number.isFinite(d.open) && Number.isFinite(d.close))
      .sort((a, b) => a.time - b.time);

    await initPriceChart();
    priceSeries.setData(data);
    if (volumeSeries) volumeSeries.setData(buildVolumeData(candles));
    const last = data[data.length - 1];
    liveCandle = {
      time: last.time,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    };
    setEntryLine(pos.entryPrice);
    setCurrentLine(currentPrice);
    const newKey = `pos:${pos.coin}:${currentInterval}`;
    if (chartViewKey !== newKey) {
      priceChart.timeScale().fitContent();
      chartViewKey = newKey;
    }
    applyTradeMarkers(pos.coin);
    hidePriceChartLoader();
  } catch (err) {
    console.error("[PriceChart] fetch error:", err);
  }
}

async function initPriceChart() {
  const container = document.getElementById("price-chart");
  if (!container) return;
  if (priceChart) return; // не пересоздаём, иначе теряется зум/пан

  // lightweight-charts грузим лениво (отдельный чанк) — нужен только здесь, на index.
  const { createChart } = await import("lightweight-charts");

  const css = (n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = css("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const gridColor = css("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = css("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

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
}

function setEntryLine(price) {
  if (!priceSeries || !Number.isFinite(price)) return;
  if (entryPriceLine) priceSeries.removePriceLine(entryPriceLine);
  entryPriceLine = priceSeries.createPriceLine({
    price,
    color: "#71717A",
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: "Entry",
  });
}

function setCurrentLine(price) {
  if (!priceSeries || !Number.isFinite(price)) return;
  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim() || "#635BFF";
  if (currentPriceLine) priceSeries.removePriceLine(currentPriceLine);
  currentPriceLine = priceSeries.createPriceLine({
    price,
    color: accent,
    lineWidth: 1,
    lineStyle: 0,
    axisLabelVisible: true,
    title: "Now",
  });
}

function updateCurrentLine(price) {
  if (!currentPriceLine || !Number.isFinite(price))
    return setCurrentLine(price);
  currentPriceLine.applyOptions({ price });
}

function tickLiveCandle(price, pos) {
  if (!priceSeries || !Number.isFinite(price)) return;
  const step = INTERVAL_SECONDS[currentInterval] || 60;
  const now = Math.floor(Date.now() / 1000);
  const bucket = now - (now % step);

  if (!liveCandle || bucket > liveCandle.time + step) {
    // окно сильно сдвинулось — рефетчим (подтянем все пропущенные свечи)
    fetchAndRenderCandles(pos, price);
    return;
  }

  if (bucket > liveCandle.time) {
    // новый bucket — стартуем свечу с close предыдущей
    liveCandle = {
      time: bucket,
      open: liveCandle.close,
      high: price,
      low: price,
      close: price,
    };
  } else {
    liveCandle.high = Math.max(liveCandle.high, price);
    liveCandle.low = Math.min(liveCandle.low, price);
    liveCandle.close = price;
  }
  priceSeries.update(liveCandle);
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

export function initPriceChartUi() {
document.querySelectorAll("#price-intervals .range-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    if (b.dataset.iv === currentInterval) return;
    document
      .querySelectorAll("#price-intervals .range-btn")
      .forEach((r) => r.classList.remove("active"));
    b.classList.add("active");
    currentInterval = b.dataset.iv;
    liveCandle = null;
    chartViewKey = null; // смена ТФ → fitContent под новые данные
    showPriceChartLoader();
    if (lastPos) {
      const px =
        Number.isFinite(lastPos.currentPrice) && lastPos.currentPrice > 0
          ? lastPos.currentPrice
          : lastPos.entryPrice;
      await fetchAndRenderCandles(lastPos, px);
    } else if (idleChartCoin) {
      await fetchAndRenderIdleCandles(idleChartCoin);
    } else {
      hidePriceChartLoader(); // нечего грузить — не оставляем спиннер висеть
    }
  }),
);
}
