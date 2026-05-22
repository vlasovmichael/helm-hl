// ─────────────────────────────────────────────────
//  HL Scanner Dashboard — Frontend
// ─────────────────────────────────────────────────

function formatUptime(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (minutes < 10080) {
    const d = Math.floor(minutes / 1440);
    const h = Math.round((minutes % 1440) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const w = Math.floor(minutes / 10080);
  const d = Math.round((minutes % 10080) / 1440);
  return d > 0 ? `${w}w ${d}d` : `${w}w`;
}

const REFRESH_MS = 10_000;
let equityChart = null;
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
let lastSuccessAt = 0;
let currentRangeHours = 24;
let currentPnlPeriod = "today";
let lastPnlSummary = null;
let lastInsights = null;
let currentInsightsTab = "per-coin";
let perCoinSort = { key: "pnl", dir: "desc" };
let socket = null;
const lastAnimatedValues = new Map();
let currentCoinInPos = null;
let lastPos = null;
let chartViewKey = null; // coin+interval — для сохранения зума при тех же данных

// ── WebSocket ───────────────────────────────────

let wsState = "connecting"; // 'live' | 'stale' | 'reconnecting' | 'connecting'
let wsRetryDelay = 1000; // ms, exp backoff: 1s → 2s → 4s → 8s → cap 10s
const WS_RETRY_MAX = 10_000;
let wsReconnectTimer = null;

function setWsState(next) {
  if (wsState === next) return;
  wsState = next;
  renderWsPill();
}

function renderWsPill() {
  const pill = document.getElementById("ws-pill");
  if (!pill) return;
  pill.classList.remove("live", "stale", "offline");
  if (wsState === "live") {
    pill.classList.add("live");
    pill.textContent = "WS live";
  } else if (wsState === "stale") {
    pill.classList.add("stale");
    const age = Math.floor((Date.now() - lastSuccessAt) / 1000);
    pill.textContent = `WS stale ${age}s`;
  } else if (wsState === "reconnecting") {
    pill.classList.add("offline");
    pill.textContent = "WS reconnecting…";
  } else {
    pill.classList.add("offline");
    pill.textContent = "WS connecting…";
  }
}

function initWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    wsRetryDelay = 1000;
    setWsState("connecting"); // станет 'live' после первого msg
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "status") {
        renderHeader(msg.data);
        renderPosition(msg.data.activePosition);
        renderManualPositions(msg.data.manualPositions);
        renderBans(msg.data);
        renderChillBoy(msg.data.chillBoy);
        renderChillBoyCard(msg.data.chillBoy);
        handlePriceChartUpdate(
          msg.data.activePosition,
          msg.data.manualPositions,
        );
        lastSuccessAt = Date.now();
        setWsState("live");
        renderFooter();
      } else if (msg.type === "logs:init") {
        ingestLogs(msg.entries || [], true);
      } else if (msg.type === "log") {
        ingestLogs([msg.entry], false);
      }
    } catch (err) {
      console.error("[WS] Error:", err);
    }
  };

  socket.onerror = () => {
    // onerror всегда сопровождается onclose — закроем явно, чтобы reconnect стартовал быстрее.
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  socket.onclose = () => {
    setWsState("reconnecting");
    wsReconnectTimer = setTimeout(initWebSocket, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
  };
}

// ── Number Animation (Rabbit Style) ────────────────

function updateAnimatedNumber(elId, newValueStr) {
  const el = document.getElementById(elId);
  if (!el) return;
  const prev = lastAnimatedValues.get(elId) || "";
  if (prev === newValueStr) return;

  const oldStr = prev || newValueStr;
  lastAnimatedValues.set(elId, newValueStr);

  el.innerHTML = "";
  const maxLength = Math.max(oldStr.length, newValueStr.length);
  const oldPadded = oldStr.padStart(maxLength, " ");
  const newPadded = newValueStr.padStart(maxLength, " ");

  for (let i = 0; i < maxLength; i++) {
    const charOld = oldPadded[i];
    const charNew = newPadded[i];

    if (charOld === charNew) {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    } else if (/[0-9]/.test(charNew)) {
      const reel = document.createElement("div");
      reel.className = "digit-reel";
      const digits = /[0-9]/.test(charOld) ? [charOld, charNew] : [charNew];
      digits.forEach((d) => {
        const s = document.createElement("span");
        s.textContent = d;
        reel.appendChild(s);
      });
      el.appendChild(reel);
      if (digits.length > 1) {
        requestAnimationFrame(() => {
          reel.style.transform = `translateY(-1.1em)`;
        });
      }
    } else {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    }
  }
}

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

async function handlePriceChartUpdate(pos, manualPositions) {
  const card = document.getElementById("price-card");
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

    initPriceChart();
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

    initPriceChart();
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

function initPriceChart() {
  const container = document.getElementById("price-chart");
  if (!container) return;
  if (priceChart) return; // не пересоздаём, иначе теряется зум/пан

  const css = (n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = css("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const gridColor = css("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = css("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

  priceChart = LightweightCharts.createChart(container, {
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
  priceChart
    .priceScale("vol")
    .applyOptions({
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

// ── Performance Chart (EQUITY) — Lightweight Charts area-series ──

let equitySeries = null;
let equityData = []; // [{time, value}]

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyChartTheme() {
  if (!equityChart) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const accent = cssVar("--accent") || "#635BFF";
  const textMuted = cssVar("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const grid = cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

  equityChart.applyOptions({
    layout: {
      background: { type: "solid", color: bgColor },
      textColor: textMuted,
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: "transparent" },
      horzLines: { color: grid },
    },
    rightPriceScale: { borderColor: grid },
    timeScale: { borderColor: grid },
  });

  if (equitySeries) {
    equitySeries.applyOptions({
      lineColor: accent,
      topColor: hexToRgba(accent, 0.28),
      bottomColor: hexToRgba(accent, 0),
    });
  }
}

function initEquityChart() {
  const container = document.getElementById("equity-chart");
  if (!container) return;
  if (equityChart) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const accent = cssVar("--accent") || "#635BFF";
  const textMuted = cssVar("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const grid = cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

  equityChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: "solid", color: bgColor },
      textColor: textMuted,
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: "transparent" },
      horzLines: { color: grid },
    },
    rightPriceScale: {
      borderColor: grid,
      scaleMargins: { top: 0.15, bottom: 0.05 },
    },
    timeScale: {
      borderColor: grid,
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      },
    },
    crosshair: { mode: 0 },
    handleScroll: true,
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: {
      priceFormatter: (v) => `$${Number(v).toFixed(2)}`,
      timeFormatter: (time) => {
        const d = new Date(time * 1000);
        const dd = String(d.getDate()).padStart(2, "0");
        const mo = String(d.getMonth() + 1).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        return `${dd}.${mo} ${hh}:${mi}`;
      },
    },
  });

  equitySeries = equityChart.addAreaSeries({
    lineColor: accent,
    topColor: hexToRgba(accent, 0.28),
    bottomColor: hexToRgba(accent, 0),
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });

  if (!window.__equityChartResizeBound) {
    window.__equityChartResizeBound = true;
    window.addEventListener("resize", () => {
      if (equityChart && container)
        equityChart.resize(container.clientWidth, container.clientHeight);
    });
  }
}

function renderEquityPill() {
  const pill = document.getElementById("equity-pill");
  if (!pill || !equityData.length) return;
  const first = equityData[0].value;
  const last = equityData[equityData.length - 1].value;
  const delta = last - first;
  const pct = first > 0 ? (delta / first) * 100 : 0;
  const valEl = document.getElementById("equity-pill-value");
  const dEl = document.getElementById("equity-pill-delta");
  if (valEl) valEl.textContent = fmtUsd(last);
  if (dEl) {
    const sign = delta >= 0 ? "+" : "-";
    dEl.textContent = `${sign}${fmtUsd(Math.abs(delta))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  }
  pill.classList.toggle("positive", delta >= 0);
  pill.classList.toggle("negative", delta < 0);
  pill.hidden = false;
}

// ── Theme & Helpers ──────────────────────────────

const THEME_KEY = "hl-scanner-theme";
function getStoredTheme() {
  return localStorage.getItem(THEME_KEY) || "auto";
}
function applyTheme(mode) {
  const root = document.documentElement;
  const resolved =
    mode === "auto"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  root.setAttribute("data-theme", resolved);
  document
    .querySelectorAll(".theme-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.theme === mode));
  if (equityChart) {
    applyChartTheme();
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}
function fmtUsd(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n || 0);
}
function fmtPct(n) {
  return `${(n || 0).toFixed(2)}%`;
}
function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (currentRangeHours <= 24) {
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// ── Renderers ───────────────────────────────────

function renderHeader(status) {
  updateAnimatedNumber("equity-value", fmtUsd(status.equity));
  const profit = status.sessionProfit;
  const deltaEl = document.getElementById("equity-delta");
  if (status.sessionStartEquity > 0) {
    const pct = (profit / status.sessionStartEquity) * 100;
    deltaEl.textContent = `${profit >= 0 ? "+" : "-"}${fmtUsd(Math.abs(profit))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) session`;
    deltaEl.className = `delta ${profit >= 0 ? "positive" : "negative"}`;
  }
  document.getElementById("mode-pill").textContent = status.mode;
  document.getElementById("uptime-val").textContent =
    `Uptime: ${formatUptime(status.uptimeMin)}`;
  document.getElementById("available-val").textContent =
    `Available: ${fmtUsd(status.available)}`;
}

function renderPosition(pos) {
  const container = document.getElementById("position-container");
  if (!pos) {
    container.innerHTML =
      '<div class="empty-state">No active positions — bot is IDLE</div>';
    return;
  }
  const pnl = pos.currentPnl;
  let pnlBlock = "";
  if (pnl) {
    const cls = (v) => (v >= 0 ? "positive" : "negative");
    const sgn = (v) => (v >= 0 ? "+" : "−");
    pnlBlock = `
      <div class="data-grid" style="margin-top:0.75rem">
        <div class="grid-item"><div class="item-label">Net (Mkt)</div><div class="item-value ${cls(pnl.netMarket)}">${sgn(pnl.netMarket)}$${Math.abs(pnl.netMarket).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Net (Mkr)</div><div class="item-value ${cls(pnl.netMaker)}">${sgn(pnl.netMaker)}$${Math.abs(pnl.netMaker).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Price PnL</div><div class="item-value ${cls(pnl.price)}">${sgn(pnl.price)}$${Math.abs(pnl.price).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Funding</div><div class="item-value ${cls(pnl.funding)}">${sgn(pnl.funding)}$${Math.abs(pnl.funding).toFixed(4)}</div></div>
      </div>`;
  }
  const side = (pos.side || "SHORT").toUpperCase();
  const sideCls = side === "SHORT" ? "negative" : "positive";
  container.innerHTML = `
    <div class="data-grid">
      <div class="grid-item"><div class="item-label">Coin · Side</div><div class="item-value highlight">#${pos.coin} <span class="${sideCls}" style="font-size:11px; font-weight:700; padding:2px 6px; border-radius:4px; margin-left:4px;">${side}</span></div></div>
      <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(pos.sizeUsd)}</div></div>
      <div class="grid-item"><div class="item-label">Entry</div><div class="item-value">$${pos.entryPrice}</div></div>
      <div class="grid-item"><div class="item-label">APY · Held</div><div class="item-value">${fmtPct(pos.entryApy)} · ${pos.heldHours.toFixed(1)}h</div></div>
    </div>${pnlBlock}`;
}

function renderManualPositions(list) {
  const container = document.getElementById("manual-positions-container");
  if (!container) return;
  if (!Array.isArray(list) || list.length === 0) {
    container.innerHTML = "";
    return;
  }
  const cls = (v) => (v >= 0 ? "positive" : "negative");
  const sgn = (v) => (v >= 0 ? "+" : "−");
  const blocks = list
    .map((p) => {
      const sideCls = p.side === "SHORT" ? "negative" : "positive";
      const liq = p.liquidationPrice != null ? `$${p.liquidationPrice}` : "—";
      const lev = p.leverage != null ? `${p.leverage}x` : "—";
      const cur = p.currentPrice != null ? `$${p.currentPrice}` : "—";
      return `
      <div style="margin-top:0.75rem; padding:0.75rem; border:1px dashed var(--border); border-radius:8px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:0.5rem;">
          <span style="background:rgba(234,179,8,0.12); color:var(--yellow,#eab308); border:1px solid rgba(234,179,8,0.3); padding:2px 8px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:700;">HANDS-OFF · MANUAL</span>
          <span class="item-value highlight">#${p.coin}</span>
          <span class="item-value ${sideCls}">${p.side}</span>
        </div>
        <div class="data-grid">
          <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(p.sizeUsd)} · ${lev}</div></div>
          <div class="grid-item"><div class="item-label">Entry · Now</div><div class="item-value">$${p.entryPrice} · ${cur}</div></div>
          <div class="grid-item"><div class="item-label">uPnL</div><div class="item-value ${cls(p.unrealizedPnl)}">${sgn(p.unrealizedPnl)}$${Math.abs(p.unrealizedPnl).toFixed(4)}</div></div>
          <div class="grid-item"><div class="item-label">Liq</div><div class="item-value">${liq}</div></div>
        </div>
        <div style="margin-top:0.5rem; font-size:11px; color:var(--text-muted, #888);">Открыта вручную — бот не управляет. Закрой на бирже, чтобы продолжил работу.</div>
      </div>`;
    })
    .join("");
  container.innerHTML = blocks;
}

function renderBans(status) {
  // Compact strip над Near Misses: показываем только если есть активные баны.
  const strip = document.getElementById("bans-strip");
  if (!strip) return;
  if (!status.runtimeBans?.length) {
    strip.innerHTML = "";
    strip.classList.remove("bans-strip");
    return;
  }
  strip.classList.add("bans-strip");
  strip.innerHTML =
    '<div style="font-size:10px; color:var(--text-muted,#888); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">Runtime bans</div>' +
    status.runtimeBans
      .map(
        (c) =>
          `<div style="display:inline-block; background:rgba(239,68,68,0.1); color:var(--red); border:1px solid rgba(239,68,68,0.2); padding:3px 8px; border-radius:5px; font-size:10px; font-family:var(--font-mono); font-weight:600; margin:0 6px 4px 0;">#${c}</div>`,
      )
      .join("");
}

function renderHotMovers(payload) {
  const tbody = document.getElementById("hot-movers-tbody");
  const meta = document.getElementById("hot-movers-meta");
  if (!tbody || !meta) return;
  const signals = Array.isArray(payload?.signals) ? payload.signals : [];
  const th = payload?.thresholds || {};

  // Sort by max |spikePct| across all windows, desc. Items with no history go last.
  const enriched = signals
    .map((s) => {
      const windows = Array.isArray(s.windows) ? s.windows : [];
      let maxAbs = -Infinity;
      for (const w of windows) {
        if (w.spikePct != null && Math.abs(w.spikePct) > maxAbs) {
          maxAbs = Math.abs(w.spikePct);
        }
      }
      return { s, windows, maxAbs };
    })
    .filter((x) => x.maxAbs > -Infinity)
    .sort((a, b) => b.maxAbs - a.maxAbs)
    .slice(0, 20);

  meta.textContent = payload?.ts
    ? `scope ${payload.universeSize} · top ${enriched.length} by max |move| · updated ${fmtTime(payload.ts)}`
    : "—";

  if (!enriched.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty-state">Waiting for price history…</td></tr>';
    return;
  }

  const fmtPrice = (p) => {
    if (p == null) return "—";
    if (p >= 100) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toPrecision(4);
  };
  const fmtPct = (v) => {
    if (v == null) return "—";
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  };
  // Tier+sign → CSS-класс ячейки. Использует существующие num-pos/neg-* классы
  // (зелёный/красный тинт + жирность по силе). Hunter-порог визуально виден в
  // самой Hot Movers таблице — отдельная карточка не нужна.
  const tierCellCls = (w) => {
    if (!w || w.spikePct == null) return "num-muted";
    const tier = w.tier;
    if (!tier || tier === "NEUTRAL") return "";
    const pos = w.spikePct > 0;
    if (tier === "STRONG") return pos ? "num-pos-strong" : "num-neg-strong";
    if (tier === "NORMAL") return pos ? "num-pos" : "num-neg";
    if (tier === "WEAK") return pos ? "num-pos-weak" : "num-neg-weak";
    return "";
  };
  const pctCellTiered = (w) => {
    if (!w || w.spikePct == null) return ['<span class="num-inline-muted">—</span>', ""];
    const v = w.spikePct;
    const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "·";
    const cls = tierCellCls(w);
    const inner = cls
      ? `${arrow} ${fmtPct(v)}`
      : `<span class="${v > 0 ? "num-inline-pos" : "num-inline-neg"}">${arrow} ${fmtPct(v)}</span>`;
    return [inner, cls];
  };
  const findWin = (windows, mins) => windows.find((w) => w.mins === mins);
  const winByLabel = (windows, label) => windows.find((w) => w.label === label);

  // Direction для подсветки всей строки: берём окно с лучшим тиром (STRONG>NORMAL>WEAK),
  // tiebreak — наибольший |spike|. pump → SHORT-fade (красный), dump → LONG-fade (зелёный).
  const TIER_RANK = { STRONG: 3, NORMAL: 2, WEAK: 1 };
  const bestDirection = (windows) => {
    let best = null;
    for (const w of windows) {
      if (!w.tier || w.tier === "NEUTRAL" || w.spikePct == null) continue;
      const rank = TIER_RANK[w.tier] || 0;
      const abs = Math.abs(w.spikePct);
      if (!best || rank > best.rank || (rank === best.rank && abs > best.abs)) {
        best = { rank, abs, sign: w.spikePct > 0 ? "pump" : "dump" };
      }
    }
    return best?.sign ?? null;
  };

  tbody.innerHTML = enriched
    .map((x, idx) => {
      const s = x.s;
      const w2 = findWin(x.windows, 2) || winByLabel(x.windows, "2m");
      const w5 = findWin(x.windows, 5) || winByLabel(x.windows, "5m");
      const w15 = findWin(x.windows, 15) || winByLabel(x.windows, "15m");
      const w60 = findWin(x.windows, 60) || winByLabel(x.windows, "1h");
      const trendLbl = th.trendLookbackMin ? `${th.trendLookbackMin}m` : "";
      const trendPct = s.trendPct;
      const trendInner =
        trendPct == null
          ? '<span class="num-inline-muted">—</span>'
          : `<span class="${trendPct > 0 ? "num-inline-pos" : "num-inline-neg"}">${trendPct > 0 ? "▲" : "▼"} ${fmtPct(trendPct)}</span> <span class="num-inline-muted">/ ${trendLbl}</span>`;

      const dir = bestDirection(x.windows);
      const rowCls = [
        s.isActive ? "is-active" : "",
        dir === "pump" ? "row-short row-fade-short" : "",
        dir === "dump" ? "row-long row-fade-long" : "",
      ].filter(Boolean).join(" ");

      const cells = [w2, w5, w15, w60].map((w) => {
        const [inner, cls] = pctCellTiered(w);
        return `<td${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
      }).join("");

      return `<tr class="${rowCls}">
        <td>${idx + 1}</td>
        <td><span class="signals-price">#${escapeHtml(s.coin)}</span></td>
        <td><span class="signals-price">${fmtPrice(s.price)}</span></td>
        ${cells}
        <td>${trendInner}</td>
      </tr>`;
    })
    .join("");
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (r.status === 401) window.location.href = "/login";
  return r.json();
}

async function tick() {
  const [historyR, activityR, taxR, pnlR, moversR, insightsR] = await Promise.allSettled([
    fetchJson(`/api/history?hours=${currentRangeHours}`),
    fetchJson(`/api/activity?hours=${currentRangeHours}&limit=10`),
    fetchJson("/api/tax-summary"),
    fetchJson("/api/pnl-summary"),
    fetchJson("/api/signals?limit=200"),
    fetchJson("/api/insights"),
  ]);
  if (moversR.status === "fulfilled") renderHotMovers(moversR.value);
  if (pnlR.status === "fulfilled") {
    lastPnlSummary = pnlR.value;
    renderPnlSummary();
  }
  if (insightsR.status === "fulfilled") {
    lastInsights = insightsR.value;
    renderInsights();
  }
  if (historyR.status === "fulfilled" && historyR.value?.points) {
    const pts = historyR.value.points;
    const seen = new Set();
    const data = [];
    for (const p of pts) {
      const t = Math.floor(p.ts / 1000);
      if (seen.has(t)) continue;
      seen.add(t);
      data.push({ time: t, value: Number(p.equity) });
    }
    data.sort((a, b) => a.time - b.time);
    equityData = data;
    if (equitySeries) equitySeries.setData(data);
    renderEquityPill();
    hideChartLoader();
  }
  if (activityR.status === "fulfilled") renderActivity(activityR.value);
  if (taxR.status === "fulfilled") renderTax(taxR.value);
  lastSuccessAt = Date.now();
  renderFooter();
}

let lastActivityEvents = [];

function renderActivity(activity) {
  const container = document.getElementById("activity-container");
  const events = (activity?.events || []).filter((e) => e && e.coin);
  lastActivityEvents = events;
  if (!events.length) {
    container.innerHTML = '<div class="empty-state">No events</div>';
    return;
  }
  container.innerHTML = events
    .map((e, idx) => {
      const isManual = e.kind === "manual_close" || e.strategy_id === "manual";
      const kindLabel =
        e.kind === "manual_close" ? "CLOSE" : e.kind.toUpperCase();
      const kindClass = e.kind === "manual_close" ? "close" : e.kind;
      const manualBadge = isManual
        ? '<span class="manual-badge" style="background:rgba(234,179,8,0.12); color:var(--yellow,#eab308); border:1px solid rgba(234,179,8,0.3); padding:1px 6px; border-radius:4px; font-size:9px; font-family:var(--font-mono); font-weight:700; margin-left:6px;">MANUAL</span>'
        : "";
      const pnlVal = e.pnl || 0;
      const canOpen = e.kind === "close" || e.kind === "manual_close" || e.kind === "open";
      const clickable = canOpen ? "clickable" : "";
      const idxAttr = canOpen ? `data-activity-idx="${idx}"` : "";
      return `
      <div class="activity-item ${clickable}" ${idxAttr}>
        <div><span class="activity-kind ${kindClass}">${kindLabel}</span><span class="activity-coin">#${e.coin}</span>${manualBadge}</div>
        <div class="activity-pnl ${pnlVal >= 0 ? "positive" : "negative"}">${pnlVal >= 0 ? "+" : ""}${pnlVal.toFixed(4)}</div>
      </div>`;
    })
    .join("");
}

// ── Trade detail modal ─────────────────────────────────────────────────
function openTradeModal(html) {
  const modal = document.getElementById("trade-modal");
  const body = document.getElementById("trade-modal-body");
  if (!modal || !body) return;
  body.innerHTML = html;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeTradeModal() {
  const modal = document.getElementById("trade-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

function tmHeader({ coin, side, kindLabel, strat, isManual, when }) {
  const sideClass = side === "LONG" ? "long" : side === "SHORT" ? "short" : "";
  const sideChip = side
    ? `<span class="tm-side-chip ${sideClass}">${side === "LONG" ? "▲" : "▼"} ${side}</span>`
    : "";
  // strategyDisplayName('manual') уже отдаёт '🖐 Manual' — не дублируем эмодзи.
  const stratText = isManual && !/manual/i.test(strat) ? `${strat} · 🖐 Manual` : strat;
  return `
    <div class="tm-header">
      <div class="tm-coin-badge">${coin.slice(0, 4)}</div>
      <div class="tm-header-text">
        <div class="tm-title">${kindLabel} #${coin} ${sideChip}</div>
        <div class="tm-sub">${stratText} · ${when}</div>
      </div>
    </div>
  `;
}

function tmPnlHero(pnl) {
  const cls = pnl >= 0 ? "positive" : "negative";
  const sign = pnl >= 0 ? "+" : "−";
  return `
    <div class="tm-pnl-hero">
      <div class="tm-pnl-hero-label">Realized PnL</div>
      <div class="tm-pnl-hero-value ${cls}">${sign}$${Math.abs(pnl).toFixed(4)}</div>
    </div>
  `;
}

function tradeModalHtmlFromActivity(e) {
  const kindLabel = e.kind === "open" ? "OPEN" : "CLOSE";
  const isManual = e.kind === "manual_close" || e.strategy_id === "manual";
  const strat = strategyDisplayName(e.strategy_id);
  const pnl = e.pnl || 0;
  const when = new Date(e.ts).toLocaleString();
  const side = e.side ? e.side.toUpperCase() : null;

  const cells = [];
  if (e.entryPrice != null) cells.push(`<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(e.entryPrice)}</div></div>`);
  if (e.closePrice != null) cells.push(`<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(e.closePrice)}</div></div>`);
  if (e.sizeUsd != null) cells.push(`<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${e.sizeUsd.toFixed(2)}</div></div>`);
  if (e.reason) cells.push(`<div class="tm-cell"><div class="tm-cell-label">Reason</div><div class="tm-cell-value">${e.reason}</div></div>`);

  return `
    ${tmHeader({ coin: e.coin, side, kindLabel, strat, isManual, when })}
    ${e.kind !== "open" ? tmPnlHero(pnl) : ""}
    ${cells.length ? `<div class="tm-grid">${cells.join("")}</div>` : ""}
    ${e.id ? `<div class="tm-section" id="tm-detail-slot"><div class="tm-section-title">Детали</div><div class="tm-sub">Загружаю…</div></div>` : ""}
  `;
}

function tradeDetailHtml(t) {
  if (!t) return '<div class="tm-sub">Детали недоступны</div>';
  const strat = strategyDisplayName(t.strategy_id);
  const direction = (t.side || t.direction || "long").toUpperCase();
  const entryPx = t.entry_price;
  const closePx = t.close_price;
  const pnl = t.realized_pnl || 0;
  const fee = t.fee_paid || 0;
  const grossPnl = pnl + fee;
  const holdMs = t.closed_at && t.entry_time ? t.closed_at - t.entry_time : null;
  const holdStr =
    holdMs == null
      ? "—"
      : holdMs < 60_000
      ? `${Math.round(holdMs / 1000)}s`
      : holdMs < 3600_000
      ? `${Math.round(holdMs / 60_000)}m`
      : `${(holdMs / 3600_000).toFixed(1)}h`;
  const sl = t.sl_price;
  const tp = t.tp_price;
  const opened = t.entry_time ? new Date(t.entry_time).toLocaleString() : "—";
  const closed = t.closed_at ? new Date(t.closed_at).toLocaleString() : "—";
  const isManual = t.strategy_id === "manual";

  const cells = [
    `<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(entryPx)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(closePx)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${(t.size_usd || 0).toFixed(2)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Hold</div><div class="tm-cell-value">${holdStr}</div></div>`,
  ];
  if (sl != null) cells.push(`<div class="tm-cell"><div class="tm-cell-label">Stop Loss</div><div class="tm-cell-value">$${fmtPx(sl)}</div></div>`);
  if (tp != null) cells.push(`<div class="tm-cell"><div class="tm-cell-label">Take Profit</div><div class="tm-cell-value">$${fmtPx(tp)}</div></div>`);
  cells.push(`<div class="tm-cell"><div class="tm-cell-label">Gross PnL</div><div class="tm-cell-value ${grossPnl >= 0 ? "positive" : "negative"}">${grossPnl >= 0 ? "+" : "−"}$${Math.abs(grossPnl).toFixed(4)}</div></div>`);
  cells.push(`<div class="tm-cell"><div class="tm-cell-label">Fees</div><div class="tm-cell-value muted">−$${Math.abs(fee).toFixed(4)}</div></div>`);
  if (t.reason) cells.push(`<div class="tm-cell full"><div class="tm-cell-label">Close reason</div><div class="tm-cell-value">${t.reason}</div></div>`);

  return `
    ${tmHeader({ coin: t.coin, side: direction, kindLabel: "TRADE", strat, isManual, when: `id ${t.id}` })}
    ${tmPnlHero(pnl)}
    <div class="tm-grid">${cells.join("")}</div>
    <div class="tm-section">
      <div class="tm-section-title">Timeline</div>
      <div class="tm-grid">
        <div class="tm-cell"><div class="tm-cell-label">Opened</div><div class="tm-cell-value muted">${opened}</div></div>
        <div class="tm-cell"><div class="tm-cell-label">Closed</div><div class="tm-cell-value muted">${closed}</div></div>
      </div>
    </div>
  `;
}

function fmtPx(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7;
  return v.toFixed(digits);
}

async function onActivityClick(e) {
  const row = e.target.closest("[data-activity-idx]");
  if (!row) return;
  const idx = parseInt(row.getAttribute("data-activity-idx"), 10);
  const evt = lastActivityEvents[idx];
  if (!evt) return;
  openTradeModal(tradeModalHtmlFromActivity(evt));
  if (evt.id) {
    try {
      const r = await fetchJson(`/api/trade/${evt.id}`);
      const slot = document.getElementById("tm-detail-slot");
      if (slot && r?.trade) slot.outerHTML = `<div class="tm-section">${tradeDetailHtml(r.trade)}</div>`;
    } catch (err) {
      const slot = document.getElementById("tm-detail-slot");
      if (slot) slot.innerHTML = '<div class="tm-sub">Не удалось загрузить детали</div>';
    }
  }
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#trade-modal [data-close]")) {
    closeTradeModal();
    return;
  }
  if (e.target.closest("#activity-container")) onActivityClick(e);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTradeModal();
});

function fmtMoney(v, signed = true) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  const sign = signed ? (v >= 0 ? "+" : "−") : "";
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtMoneyAbs(v) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  return `${v < 0 ? "−" : ""}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function strategyDisplayName(sid) {
  if (sid === "carry") return "Carry";
  if (sid === "hunter" || sid === "hunter_short") return "Hunter SHORT";
  if (sid === "hunter_long") return "Hunter LONG";
  if (sid === "trend_follow") return "Chill Boy";
  if (sid === "fade") return "Fade";
  if (sid === "manual") return "🖐 Manual";
  return sid || "Unknown";
}

function renderPnlSummary() {
  if (!lastPnlSummary || !lastPnlSummary.periods) return;
  const p = lastPnlSummary.periods[currentPnlPeriod];
  if (!p) return;

  // p.* теперь = combined stats (bot + manual). p.manual/p.bot — только для split-вывода.
  const manualPnl = p.manual?.pnl || 0;
  const manualCount = p.manual?.count || 0;

  const totalEl = document.getElementById("pnl-total");
  totalEl.textContent = fmtMoney(p.totalPnl || 0);
  totalEl.classList.toggle("positive", (p.totalPnl || 0) > 0);
  totalEl.classList.toggle("negative", (p.totalPnl || 0) < 0);

  const wr = p.count > 0 ? `${p.winRate.toFixed(0)}% win` : "—";
  const manualNote =
    manualCount > 0
      ? ` · 🖐 ${manualCount} manual (${fmtMoney(manualPnl)})`
      : "";
  document.getElementById("pnl-stats").textContent =
    `${p.count} trade${p.count === 1 ? "" : "s"} · ${wr}${manualNote}`;

  const fundingEl = document.getElementById("pnl-funding");
  fundingEl.textContent = p.funding ? fmtMoney(p.funding) : "—";
  fundingEl.classList.toggle("positive", p.funding > 0);
  fundingEl.classList.toggle("negative", p.funding < 0);

  // Unrealized показываем только для period=today (он "сейчас")
  const unrEl = document.getElementById("pnl-unrealized");
  const unr = lastPnlSummary.unrealized;
  if (currentPnlPeriod === "today" && Number.isFinite(unr) && unr !== 0) {
    unrEl.textContent = fmtMoney(unr);
    unrEl.classList.toggle("positive", unr > 0);
    unrEl.classList.toggle("negative", unr < 0);
  } else {
    unrEl.textContent = "—";
    unrEl.classList.remove("positive", "negative");
  }

  document.getElementById("pnl-utilization").textContent = Number.isFinite(
    p.utilizationPct,
  )
    ? `${p.utilizationPct.toFixed(0)}%`
    : "—";

  document.getElementById("pnl-avg").textContent =
    p.count > 0 ? fmtMoney(p.avgPnl) : "—";
  document.getElementById("pnl-best").textContent =
    p.count > 0 ? fmtMoney(p.bestPnl) : "—";
  document.getElementById("pnl-worst").textContent =
    p.count > 0 ? fmtMoney(p.worstPnl) : "—";
  document.getElementById("pnl-wl").textContent =
    p.count > 0 ? `${p.wins} / ${p.losses}` : "—";

  // Manual breakdown row: отдельная видимость W/L+P&L по ручным сделкам.
  // Combined p.wins/losses их прячет, а ручные сделки бывают важны для разбора.
  const manualRow = document.getElementById("pnl-manual-row");
  if (manualRow) {
    if (manualCount > 0) {
      manualRow.style.display = "";
      const manualWins = p.manual?.wins || 0;
      const manualLosses = manualCount - manualWins;
      const manualAvg = manualCount > 0 ? manualPnl / manualCount : 0;
      document.getElementById("pnl-manual-wl").textContent =
        `${manualWins}W / ${manualLosses}L`;
      const pnlEl = document.getElementById("pnl-manual-pnl");
      pnlEl.textContent = fmtMoney(manualPnl);
      pnlEl.classList.toggle("positive", manualPnl > 0);
      pnlEl.classList.toggle("negative", manualPnl < 0);
      document.getElementById("pnl-manual-avg").textContent =
        `avg ${fmtMoney(manualAvg)}`;
    } else {
      manualRow.style.display = "none";
    }
  }

  const expEl = document.getElementById("pnl-expectancy");
  if (expEl) {
    expEl.textContent = p.count > 0 ? fmtMoney(p.expectancy) : "—";
    expEl.classList.toggle("positive", p.expectancy > 0);
    expEl.classList.toggle("negative", p.expectancy < 0);
  }
  const payoffEl = document.getElementById("pnl-payoff");
  if (payoffEl) {
    if (p.count === 0 || p.payoffRatio == null) {
      payoffEl.textContent = "—";
    } else {
      payoffEl.textContent = `${p.payoffRatio.toFixed(2)}×`;
    }
  }
  const ddEl = document.getElementById("pnl-maxdd");
  if (ddEl) {
    if (p.count === 0) {
      ddEl.textContent = "—";
    } else {
      const pctTxt = Number.isFinite(p.maxDrawdownPct)
        ? ` (${p.maxDrawdownPct.toFixed(0)}%)`
        : "";
      ddEl.textContent = `${fmtMoney(-Math.abs(p.maxDrawdown))}${pctTxt}`;
      ddEl.classList.toggle("negative", p.maxDrawdown > 0);
    }
  }
  const feesEl = document.getElementById("pnl-fees");
  if (feesEl) {
    if (p.count === 0) {
      feesEl.textContent = "—";
    } else {
      const pctTxt =
        Number.isFinite(p.feesPctOfGross) && p.grossPnl !== 0
          ? ` (${p.feesPctOfGross.toFixed(0)}% of gross)`
          : "";
      feesEl.textContent = `${fmtMoney(p.totalFees)}${pctTxt}`;
    }
  }

  // Strategy breakdown — добавляем синтетическую запись 'manual' если есть.
  const stratContainer = document.getElementById("pnl-strategy");
  // byStrategy теперь уже включает 'manual' (server-side combined stats).
  const strategies = Object.entries(p.byStrategy || {});
  if (strategies.length === 0) {
    stratContainer.innerHTML =
      '<div class="empty-state">No trades in this period</div>';
  } else {
    const maxAbs = Math.max(
      1e-9,
      ...strategies.map(([, s]) => Math.abs(s.pnl)),
    );
    stratContainer.innerHTML = strategies
      .sort(([, a], [, b]) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .map(([sid, s]) => {
        const widthPct = (Math.abs(s.pnl) / maxAbs) * 100;
        const wr = s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : 0;
        const cls = s.pnl > 0 ? "positive" : s.pnl < 0 ? "negative" : "";
        return `
          <div class="strategy-row">
            <div class="strategy-name">${strategyDisplayName(sid)}</div>
            <div class="strategy-bar"><div class="strategy-bar-fill ${cls}" style="width:${widthPct}%"></div></div>
            <div class="strategy-pnl ${cls}">${fmtMoney(s.pnl)}</div>
            <div class="strategy-meta">${s.count}t · ${wr}% win</div>
          </div>`;
      })
      .join("");
  }

  // Резерв высоты под самый «высокий» период: замеряем реальную строку и
  // считаем max число стратегий по всем периодам. Без этого блок стратегий
  // меняет высоту при переключении дней и карточка (с графиком ниже) скачет.
  let maxRows = 1;
  for (const per of Object.values(lastPnlSummary.periods)) {
    const n = Object.keys(per.byStrategy || {}).length;
    if (n > maxRows) maxRows = n;
  }
  const sampleRow = stratContainer.querySelector(".strategy-row");
  if (sampleRow) {
    const rowH = sampleRow.getBoundingClientRect().height;
    const gap =
      0.4 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    stratContainer.style.minHeight = `${Math.round(maxRows * rowH + (maxRows - 1) * gap)}px`;
  }

  // Данные отрендерены — убираем скелетон-оверлей.
  document.getElementById("pnl-skeleton")?.classList.add("hidden");
}

// ─────────────────────────────────────────────────
//  Insights: per-coin lifetime + 90d heatmap
// ─────────────────────────────────────────────────
function renderInsights() {
  if (!lastInsights) return;
  if (currentInsightsTab === "per-coin") renderPerCoin();
  else renderHeatmap();
  document.getElementById("insights-skeleton")?.classList.add("hidden");
}

function renderPerCoin() {
  const rows = [...(lastInsights.perCoin || [])];
  const { key, dir } = perCoinSort;
  const mul = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (typeof va === "string") return mul * va.localeCompare(vb);
    return mul * ((va || 0) - (vb || 0));
  });

  // Sort indicator on headers.
  document.querySelectorAll(".per-coin-table th[data-sort]").forEach((th) => {
    th.classList.remove("sort-active", "sort-asc", "sort-desc");
    if (th.dataset.sort === key) {
      th.classList.add("sort-active");
      th.classList.add(dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  const meta = document.getElementById("per-coin-meta");
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  if (meta) {
    meta.textContent = `${rows.length} coins · ${totalTrades} trades · ${fmtMoney(totalPnl)} all-time`;
  }

  const tbody = document.getElementById("per-coin-tbody");
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">No trades yet</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const pnlCls = r.pnl > 0 ? "num-pos" : r.pnl < 0 ? "num-neg" : "";
      const avgCls = r.avg > 0 ? "num-pos" : r.avg < 0 ? "num-neg" : "";
      const wrCls =
        r.winRate >= 60 ? "num-pos" : r.winRate < 40 ? "num-neg" : "";
      return `
        <tr>
          <td class="coin-cell">#${escapeHtml(r.coin)}</td>
          <td class="num">${r.trades}</td>
          <td class="num ${pnlCls}">${fmtMoney(r.pnl)}</td>
          <td class="num ${wrCls}">${r.winRate.toFixed(0)}%</td>
          <td class="num ${avgCls}">${fmtMoney(r.avg)}</td>
          <td class="num num-muted">${fmtTime(r.lastClosedAt)}</td>
        </tr>`;
    })
    .join("");
}

function renderHeatmap() {
  const days = lastInsights.daily || [];
  const grid = document.getElementById("heatmap-grid");
  const meta = document.getElementById("heatmap-meta");
  if (!grid) return;

  const tradedDays = days.filter((d) => d.trades > 0);
  const totalPnl = days.reduce((s, d) => s + d.pnl, 0);
  if (meta) {
    meta.textContent = `${tradedDays.length}/${days.length} active days · ${fmtMoney(totalPnl)} (90d)`;
  }

  // Тиры по абсолюту daily P&L: 3 ступени win + 3 loss + empty.
  const absVals = days.map((d) => Math.abs(d.pnl)).filter((v) => v > 0);
  absVals.sort((a, b) => a - b);
  const q = (p) =>
    absVals.length === 0 ? 0 : absVals[Math.floor((absVals.length - 1) * p)];
  const t1 = q(0.33);
  const t2 = q(0.66);

  const cellClass = (d) => {
    if (d.trades === 0) return "empty";
    const a = Math.abs(d.pnl);
    const tier = a >= t2 ? "strong" : a >= t1 ? "normal" : "weak";
    return d.pnl >= 0 ? `win-${tier}` : `loss-${tier}`;
  };

  // Сетка: колонки = недели, строки = дни недели (Mon..Sun).
  // Первая колонка может быть неполной (если 90д начинается с середины недели).
  const cellsByCol = [];
  let col = [];
  for (const d of days) {
    const date = new Date(d.date + "T00:00:00");
    const dow = (date.getDay() + 6) % 7; // 0 = Mon ... 6 = Sun
    if (col.length === 0 && dow > 0) {
      for (let i = 0; i < dow; i++) col.push(null);
    }
    col.push(d);
    if (dow === 6) {
      cellsByCol.push(col);
      col = [];
    }
  }
  if (col.length) cellsByCol.push(col);

  const html = cellsByCol
    .map((week) => {
      const cells = [];
      for (let i = 0; i < 7; i++) {
        const d = week[i];
        if (!d) {
          cells.push('<div class="heatmap-cell placeholder"></div>');
          continue;
        }
        const cls = cellClass(d);
        const todayCls = d.isToday ? " is-today" : "";
        const tip = `${d.date} · ${fmtMoney(d.pnl)} · ${d.trades} trade${d.trades === 1 ? "" : "s"}`;
        cells.push(
          `<div class="heatmap-cell ${cls}${todayCls}" title="${tip}"></div>`,
        );
      }
      return `<div class="heatmap-col">${cells.join("")}</div>`;
    })
    .join("");
  grid.innerHTML = html;
}

function renderTax(tax) {
  if (!tax) return;
  document.getElementById("tax-costs").textContent =
    `${(tax.totalCostsPLN || 0).toLocaleString()} PLN`;
  document.getElementById("tax-revenue").textContent =
    `${(tax.totalRevenuePLN || 0).toLocaleString()} PLN`;
  const profit = tax.netProfitPLN || 0;
  const profitEl = document.getElementById("tax-profit");
  profitEl.textContent = `${profit >= 0 ? "+" : ""}${profit.toLocaleString()} PLN`;
  profitEl.style.color = profit >= 0 ? "var(--green)" : "var(--red)";
  document.getElementById("tax-est").textContent =
    `${(profit > 0 ? profit * 0.19 : 0).toLocaleString()} PLN`;
}

// Chill Boy detector heartbeat — строка в P&L Summary. Чисто диагностика, на торговлю не влияет.
function renderChillBoy(cb) {
  const row = document.getElementById("chillboy-detector");
  if (!row) return;
  // В PAPER-режиме всё переехало в отдельную карточку sec-chillboy — гасим
  // дубль в P&L Summary. В PROD оставляем строку (детектор виден без отдельной
  // карточки, она в PROD скрыта).
  if (!cb || !cb.enabled || !cb.prod) {
    row.style.display = "none";
    return;
  }
  row.style.display = "";

  const modeEl = document.getElementById("chillboy-mode");
  if (modeEl) {
    modeEl.textContent = cb.prod ? "PROD" : "PAPER";
    modeEl.classList.toggle("prod", !!cb.prod);
  }

  const statsEl = document.getElementById("chillboy-stats");
  if (!statsEl) return;
  const hb = cb.heartbeat;
  if (!hb) {
    statsEl.textContent = "warming up…";
    return;
  }
  const ageSec = Math.floor((Date.now() - hb.ts) / 1000);
  const age =
    ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  statsEl.textContent =
    `tracked ${hb.tracked} · squeezed ${hb.squeezed} · breakouts ${hb.breakouts} · ` +
    `slot ${hb.slot} · cooldowns ${hb.reCooldowns}+${hb.postSlCooldowns} · ${age}`;

  const vEl = document.getElementById("chillboy-vbalance");
  if (vEl) {
    if (cb.virtualEquity) {
      vEl.style.display = "";
      const ve = cb.virtualEquity;
      const sign = ve.pnlTotal >= 0 ? "+" : "-";
      const color = ve.pnlTotal >= 0 ? "var(--accent-positive, #4caf50)" : "var(--accent-negative, #f44336)";
      vEl.innerHTML =
        `sandbox: <b>$${ve.equity.toFixed(2)}</b> ` +
        `<span style="color:${color}">(${sign}$${Math.abs(ve.pnlTotal).toFixed(2)} · ` +
        `${sign}${Math.abs(ve.pnlPct * 100).toFixed(1)}%)</span> ` +
        `· seed $${ve.startEquity.toFixed(0)} · n=${ve.tradesApplied}`;
    } else if (cb.virtualBalance > 0) {
      vEl.style.display = "";
      vEl.textContent = `virtual $${cb.virtualBalance.toFixed(0)}`;
    } else {
      vEl.style.display = "none";
    }
  }

  const psEl = document.getElementById("chillboy-paper-stats");
  if (psEl && cb.paperStats) {
    const s = cb.paperStats;
    if (s.n > 0) {
      psEl.style.display = "";
      const fmt = (v) => (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`);
      psEl.innerHTML =
        `<b>Paper:</b> n=${s.n} · net ${fmt(s.sumNet)} · avg ${fmt(s.avgNet)} · ` +
        `worst ${fmt(s.worstNet)} · best ${fmt(s.bestNet)} · ` +
        `win-rate ${(s.winRate * 100).toFixed(0)}%`;
    } else {
      psEl.style.display = "none";
    }
  }

  const ptEl = document.getElementById("chillboy-paper-trades");
  if (ptEl && Array.isArray(cb.paperTrades) && cb.paperTrades.length > 0) {
    ptEl.style.display = "";
    ptEl.innerHTML = cb.paperTrades
      .map((t) => {
        const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
        const sign = net >= 0 ? "+" : "-";
        const dt = new Date(t.closed_at);
        const ts = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
        const color = net >= 0 ? "var(--accent-positive, #4caf50)" : "var(--accent-negative, #f44336)";
        return `<div>${ts} · ${t.side.toUpperCase()} ${t.coin} · <span style="color:${color}">${sign}$${Math.abs(net).toFixed(2)}</span> · ${t.reason}</div>`;
      })
      .join("");
  } else if (ptEl) {
    ptEl.style.display = "none";
  }
}

// Chill Boy Shadow Trading card. Полный обзор детектора в PAPER-режиме —
// активная paper-поза с MFE/MAE, watchlist squeezed-монет, cooldowns, история.
// Карточка скрыта в PROD (CHILL_BOY_PROD_ENABLED=true) — там Chill Boy торгует
// реальный slot, эта карточка теряет смысл.
function renderChillBoyCard(cb) {
  const card = document.getElementById("sec-chillboy");
  if (!card) return;
  // Гасим карточку: стратегия выключена ИЛИ Chill Boy в PROD-режиме
  if (!cb || !cb.enabled || cb.prod) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  // Header pills: mode + equity
  const modeEl = document.getElementById("chillboy-card-mode");
  if (modeEl) modeEl.textContent = cb.prod ? "PROD" : "PAPER";
  const equityEl = document.getElementById("chillboy-card-equity");
  if (equityEl) {
    if (cb.virtualEquity) {
      const ve = cb.virtualEquity;
      const sign = ve.pnlTotal >= 0 ? "+" : "-";
      equityEl.style.display = "";
      equityEl.textContent = `$${ve.equity.toFixed(2)} (${sign}$${Math.abs(ve.pnlTotal).toFixed(2)} · ${sign}${Math.abs(ve.pnlPct * 100).toFixed(1)}%)`;
      equityEl.style.color = ve.pnlTotal >= 0 ? "var(--green)" : "var(--red)";
    } else {
      equityEl.style.display = "none";
    }
  }

  renderChillBoyActivePos(cb.paperPosition);
  renderChillBoyWatchlist(cb.heartbeat?.watchlist);
  renderChillBoyCooldowns(cb.heartbeat?.cooldownList);
  renderChillBoyHistory(cb.paperTrades, cb.paperStats);
  renderChillBoyHeartbeatRaw(cb.heartbeat);
}

function renderChillBoyActivePos(pos) {
  const section = document.getElementById("cb-active-section");
  const body    = document.getElementById("cb-active-body");
  if (!section || !body) return;
  if (!pos) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const fmtUsd = (v) => (v == null ? "—" : (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`));
  const fmtPct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const fmtPx  = (v) => (v == null ? "—" : `$${v.toFixed(6)}`);
  const pnlCls = (pos.unrealUsd ?? 0) >= 0 ? "cb-pos-pnl positive" : "cb-pos-pnl negative";
  const heldStr = pos.heldMin >= 60
    ? `${Math.floor(pos.heldMin / 60)}h ${pos.heldMin % 60}m`
    : `${pos.heldMin}m`;

  body.innerHTML = `
    <div class="cb-kv">
      <div class="k">Coin / side</div>      <div class="v"><b>${pos.coin}</b> · ${pos.side}</div>
      <div class="k">Size</div>             <div class="v">$${pos.sizeUsd.toFixed(2)}</div>
      <div class="k">Entry / current</div>  <div class="v">${fmtPx(pos.entryPrice)} → ${fmtPx(pos.currentPrice)}</div>
      <div class="k">Unrealized</div>       <div class="v"><span class="${pnlCls}">${fmtUsd(pos.unrealUsd)} (${fmtPct(pos.unrealPct)})</span></div>
      <div class="k">MFE / MAE</div>        <div class="v">
        <span style="color:var(--green)">${fmtUsd(pos.mfeUsd)} (${fmtPct(pos.mfePct)})</span> /
        <span style="color:var(--red)">${fmtUsd(pos.maeUsd)} (${fmtPct(pos.maePct)})</span>
      </div>
      <div class="k">Held</div>             <div class="v">${heldStr}</div>
      <div class="k">SL / TP</div>          <div class="v">${fmtPx(pos.slPrice)} (${pos.slDistPct != null ? pos.slDistPct.toFixed(2) + "% away" : "—"}) · ${fmtPx(pos.tpPrice)} (${pos.tpDistPct != null ? pos.tpDistPct.toFixed(2) + "% away" : "—"})</div>
    </div>
  `;
}

function renderChillBoyWatchlist(items) {
  const body = document.getElementById("cb-watchlist-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<div class="empty-state">no squeezed coins</div>';
    return;
  }
  const rows = items.map((w) => {
    const ratio = w.ratio != null ? w.ratio.toFixed(2) : "—";
    return `<tr>
      <td><b>${w.coin}</b></td>
      <td>$${w.price.toFixed(6)}</td>
      <td>r=${ratio}</td>
      <td>↑${w.distUpPct.toFixed(2)}%</td>
      <td>↓${w.distDownPct.toFixed(2)}%</td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <table class="cb-table">
      <thead><tr><th>Coin</th><th>Price</th><th>Squeeze</th><th>to high</th><th>to low</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderChillBoyCooldowns(items) {
  const body = document.getElementById("cb-cooldowns-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<div class="empty-state">none</div>';
    return;
  }
  const rows = items.map((c) => {
    const remainStr = c.remainMs > 60000
      ? `${Math.round(c.remainMs / 60000)}m`
      : `${Math.round(c.remainMs / 1000)}s`;
    const kindLabel = c.kind === "post_sl" ? "post-SL" : "re-entry";
    return `<tr><td><b>${c.coin}</b></td><td>${kindLabel}</td><td>${remainStr}</td></tr>`;
  }).join("");
  body.innerHTML = `<table class="cb-table"><thead><tr><th>Coin</th><th>Kind</th><th>Remaining</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderChillBoyHistory(trades, stats) {
  const body  = document.getElementById("cb-history-body");
  const inline = document.getElementById("cb-stats-inline");
  if (!body) return;

  if (inline && stats && stats.n > 0) {
    const fmt = (v) => (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`);
    inline.textContent = `n=${stats.n} · net ${fmt(stats.sumNet)} · avg ${fmt(stats.avgNet)} · win ${(stats.winRate * 100).toFixed(0)}% · best ${fmt(stats.bestNet)} · worst ${fmt(stats.worstNet)}`;
  } else if (inline) {
    inline.textContent = "";
  }

  if (!Array.isArray(trades) || trades.length === 0) {
    body.innerHTML = '<div class="empty-state">no closed trades yet</div>';
    return;
  }
  const fmtUsd = (v) => (v == null ? "—" : (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`));
  const fmtTs = (ms) => {
    if (!ms) return "—";
    const dt = new Date(ms);
    return `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  };
  const fmtHold = (sec) => {
    if (sec == null) return "—";
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  };
  const rows = trades.map((t) => {
    const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
    const cls = net >= 0 ? "positive" : "negative";
    const color = net >= 0 ? "var(--green)" : "var(--red)";
    return `<tr>
      <td>${fmtTs(t.entry_time)}<br><span style="opacity:.65">${fmtTs(t.closed_at)}</span></td>
      <td><b>${t.coin}</b><br><span style="opacity:.65">${(t.side || "").toUpperCase()}</span></td>
      <td>$${(t.entry_price ?? 0).toFixed(6)}<br><span style="opacity:.65">$${(t.close_price ?? 0).toFixed(6)}</span></td>
      <td style="color:${color}"><b>${fmtUsd(net)}</b></td>
      <td>
        <span style="color:var(--green)">${fmtUsd(t.mfe_usd)}</span><br>
        <span style="color:var(--red)">${fmtUsd(t.mae_usd)}</span>
      </td>
      <td>${fmtHold(t.hold_seconds)}</td>
      <td style="opacity:.75">${t.reason || "—"}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <table class="cb-table">
      <thead><tr><th>Open / Close</th><th>Coin</th><th>Entry / Exit</th><th>Net</th><th>MFE / MAE</th><th>Held</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderChillBoyHeartbeatRaw(hb) {
  const el = document.getElementById("cb-heartbeat");
  if (!el) return;
  if (!hb) {
    el.textContent = "warming up…";
    return;
  }
  const ageSec = Math.floor((Date.now() - hb.ts) / 1000);
  const age = ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  el.textContent =
    `tracked ${hb.tracked} · squeezed ${hb.squeezed} · breakouts ${hb.breakouts} · ` +
    `slot ${hb.slot} · cooldowns ${hb.reCooldowns} re + ${hb.postSlCooldowns} post-SL · ${age}`;
}

function renderFooter() {
  const footer = document.getElementById("footer-status").querySelector("span");
  if (footer) {
    const age = Math.floor((Date.now() - lastSuccessAt) / 1000);
    footer.textContent =
      age > 15 ? `⚠ Stale (${age}s)` : `Syncing live · WS active`;
  }
  // Если коннект жив, но данные не идут >10с — флипаем pill в stale.
  if (wsState === "live" && Date.now() - lastSuccessAt > 10_000) {
    setWsState("stale");
  } else if (wsState === "stale") {
    renderWsPill(); // обновим счётчик секунд
  }
}

document.querySelectorAll(".theme-btn").forEach((b) =>
  b.addEventListener("click", () => {
    localStorage.setItem(THEME_KEY, b.dataset.theme);
    applyTheme(b.dataset.theme);
  }),
);
document.querySelectorAll(".range-btn[data-hours]").forEach((b) =>
  b.addEventListener("click", () => {
    document
      .querySelectorAll(".range-btn[data-hours]")
      .forEach((r) => r.classList.remove("active"));
    b.classList.add("active");
    currentRangeHours = b.dataset.hours;
    showChartLoader();
    tick();
  }),
);

document.querySelectorAll("#pnl-periods .range-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.period === currentPnlPeriod) return;
    document
      .querySelectorAll("#pnl-periods .range-btn")
      .forEach((r) => r.classList.remove("active"));
    b.classList.add("active");
    currentPnlPeriod = b.dataset.period;
    renderPnlSummary();
  }),
);

document.querySelectorAll("#insights-tabs .range-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.tab === currentInsightsTab) return;
    document
      .querySelectorAll("#insights-tabs .range-btn")
      .forEach((r) => r.classList.remove("active"));
    b.classList.add("active");
    currentInsightsTab = b.dataset.tab;
    document.getElementById("insights-pane-per-coin").style.display =
      currentInsightsTab === "per-coin" ? "" : "none";
    document.getElementById("insights-pane-heatmap").style.display =
      currentInsightsTab === "heatmap" ? "" : "none";
    renderInsights();
  }),
);

document.querySelectorAll(".per-coin-table th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (perCoinSort.key === key) {
      perCoinSort.dir = perCoinSort.dir === "desc" ? "asc" : "desc";
    } else {
      perCoinSort.key = key;
      // По дефолту для числовых — desc, для coin — asc.
      perCoinSort.dir = key === "coin" ? "asc" : "desc";
    }
    renderInsights();
  }),
);

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

// ── Live Logs ────────────────────────────────────

const LOG_BUFFER_MAX = 1000;
const logsState = {
  buffer: [],
  lastId: 0,
  level: "all",
  query: "",
  paused: false,
  renderScheduled: false,
};

function ingestLogs(entries, replace) {
  if (replace) logsState.buffer = [];
  for (const e of entries) {
    if (!e || typeof e.id !== "number") continue;
    if (e.id <= logsState.lastId && !replace) continue;
    logsState.buffer.push(e);
    if (e.id > logsState.lastId) logsState.lastId = e.id;
  }
  if (logsState.buffer.length > LOG_BUFFER_MAX) {
    logsState.buffer.splice(0, logsState.buffer.length - LOG_BUFFER_MAX);
  }
  scheduleLogRender();
}

function scheduleLogRender() {
  if (logsState.renderScheduled) return;
  logsState.renderScheduled = true;
  requestAnimationFrame(() => {
    logsState.renderScheduled = false;
    renderLogs();
  });
}

function logMatches(e) {
  if (logsState.level !== "all" && e.level !== logsState.level) return false;
  if (logsState.query && !e.message.toLowerCase().includes(logsState.query))
    return false;
  return true;
}

function fmtLogTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const q = escapeHtml(query);
  // case-insensitive replace on the escaped string
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function renderLogs() {
  const list = document.getElementById("logs-list");
  const empty = document.getElementById("logs-empty");
  const countEl = document.getElementById("logs-count");
  if (!list || !empty || !countEl) return;

  const filtered = logsState.buffer.filter(logMatches);
  countEl.textContent = `${filtered.length} / ${logsState.buffer.length} lines`;

  if (filtered.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const viewport = document.getElementById("logs-viewport");
  const wasAtBottom = viewport
    ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30
    : true;

  list.innerHTML = filtered
    .map(
      (e) => `
    <div class="log-row log-${e.level}">
      <span class="log-time">${fmtLogTime(e.ts)}</span>
      <span class="log-level">${e.level.toUpperCase()}</span>
      <span class="log-msg">${highlightMatch(e.message, logsState.query)}</span>
    </div>`,
    )
    .join("");

  if (!logsState.paused && wasAtBottom && viewport) {
    viewport.scrollTop = viewport.scrollHeight;
  }
}

function bindLogsUi() {
  const search = document.getElementById("logs-search");
  const pauseBtn = document.getElementById("logs-pause");
  const filters = document.getElementById("logs-filters");
  const viewport = document.getElementById("logs-viewport");

  if (search) {
    search.addEventListener("input", () => {
      logsState.query = search.value.trim().toLowerCase();
      renderLogs();
    });
  }
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      logsState.paused = !logsState.paused;
      pauseBtn.textContent = logsState.paused ? "▶" : "⏸";
      pauseBtn.classList.toggle("active", logsState.paused);
      document.getElementById("logs-status").textContent = logsState.paused
        ? "paused"
        : "live";
      if (!logsState.paused && viewport)
        viewport.scrollTop = viewport.scrollHeight;
    });
  }
  if (filters) {
    filters.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".logs-filter-btn");
      if (!btn) return;
      filters
        .querySelectorAll(".logs-filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      logsState.level = btn.dataset.level;
      renderLogs();
    });
  }
  // Detect manual scroll up → auto-pause autoscroll until user clicks resume or scrolls back to bottom
  if (viewport) {
    viewport.addEventListener("scroll", () => {
      const atBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30;
      if (atBottom && logsState.paused) {
        // user scrolled back to bottom — resume
        logsState.paused = false;
        pauseBtn.textContent = "⏸";
        pauseBtn.classList.remove("active");
        document.getElementById("logs-status").textContent = "live";
      }
    });
  }
}

async function fetchInitialLogs() {
  try {
    const r = await fetchJson("/api/logs?limit=500");
    if (r && Array.isArray(r.entries)) ingestLogs(r.entries, true);
  } catch (err) {
    console.error("[Logs] initial fetch failed", err);
  }
}

bindLogsUi();
fetchInitialLogs();

applyTheme(getStoredTheme());
initEquityChart();
initWebSocket();
tick();
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1000);
