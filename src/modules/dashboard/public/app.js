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
let _cgSignalsCache = [];
let _hmSignalsCache = [];
let _lastSetupRowsCache = [];
let _macroPct = null;
let _macroFetchedAt = 0;
let _btcMomentum1m = null;
let _tickReady = false; // true after first tick() completes — prevents half-baked SmartSignals renders

// Активные монеты (позиция бота + все ручные/HANDS-OFF). Подсвечиваем их во
// всех лентах монет (Hot Movers / Divergence / Candy Girl), чтобы оператор видел
// свою монету выделенной, пока торгует руками (2026-06-09).
let activeCoinSet = new Set();
function updateActiveCoinSet(activePosition, manualPositions) {
  const next = new Set();
  if (activePosition?.coin) next.add(activePosition.coin);
  if (Array.isArray(manualPositions))
    for (const p of manualPositions) if (p?.coin) next.add(p.coin);
  activeCoinSet = next;
}
function isActiveCoin(coin) {
  return coin != null && activeCoinSet.has(coin);
}

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
        updateActiveCoinSet(msg.data.activePosition, msg.data.manualPositions);
        renderPosition(msg.data.activePosition);
        renderManualPositions(msg.data.manualPositions);
        renderBans(msg.data);
        renderChillBoy(msg.data.chillBoy);
        renderChillBoyCard(msg.data.chillBoy);
        renderCandyGirl(msg.data.candyGirl);
        renderFaderCard(msg.data.fader);
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
      } else if (msg.type === "btc-divergence") {
        // WS-пуш = триггер «данные обновились»; перетягиваем по своему вотчлисту.
        divRefresh();
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
      const startDigit = /[0-9]/.test(charOld) ? Number(charOld) : 0;
      const endDigit = Number(charNew);
      // Odometer: только реальная дельта (1→2 = один шаг, не полный оборот).
      const totalSteps = (endDigit - startDigit + 10) % 10;
      const frames = [];
      for (let k = 0; k <= totalSteps; k++) {
        frames.push(String((startDigit + k) % 10));
      }
      frames.forEach((d) => {
        const s = document.createElement("span");
        s.textContent = d;
        reel.appendChild(s);
      });
      el.appendChild(reel);
      requestAnimationFrame(() => {
        reel.style.transform = `translateY(-${totalSteps * 1.1}em)`;
      });
    } else {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    }
  }
}

// ── Order-book Imbalance (HL public WS) ─────────────
// Subscribes to l2Book for the coin currently shown in price-card and renders
// a bid/ask imbalance bar (sum of USD-notional within ±0.5% of mid).
const OB_RANGE = 0.005;
let obWs = null;
let obCoin = null;
let obReconnectTimer = null;

function subscribeOrderBook(coin) {
  if (obCoin === coin && obWs && obWs.readyState === WebSocket.OPEN) return;
  if (obReconnectTimer) {
    clearTimeout(obReconnectTimer);
    obReconnectTimer = null;
  }
  obCoin = coin;
  if (obWs) {
    try {
      obWs.close();
    } catch {}
    obWs = null;
  }
  if (!coin) {
    renderOrderBookBar(null);
    return;
  }
  openObWs(coin);
}

function openObWs(coin) {
  let ws;
  try {
    ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  } catch {
    return;
  }
  obWs = ws;
  ws.onopen = () => {
    if (obCoin !== coin || obWs !== ws) return;
    ws.send(
      JSON.stringify({
        method: "subscribe",
        subscription: { type: "l2Book", coin },
      }),
    );
  };
  ws.onmessage = (e) => {
    if (obCoin !== coin || obWs !== ws) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.channel === "l2Book" && msg.data && msg.data.coin === coin) {
        renderOrderBookBar(msg.data);
      }
    } catch {}
  };
  ws.onclose = () => {
    if (obWs !== ws) return;
    obWs = null;
    if (obCoin === coin) {
      obReconnectTimer = setTimeout(() => {
        if (obCoin === coin) openObWs(coin);
      }, 2000);
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function renderOrderBookBar(data) {
  const wrap = document.getElementById("orderbook-bar");
  if (!wrap) return;
  if (!data || !Array.isArray(data.levels) || data.levels.length < 2) {
    wrap.style.display = "none";
    return;
  }
  const bids = data.levels[0] || [];
  const asks = data.levels[1] || [];
  if (!bids.length || !asks.length) {
    wrap.style.display = "none";
    return;
  }
  const bestBid = Number(bids[0].px);
  const bestAsk = Number(asks[0].px);
  if (!(bestBid > 0) || !(bestAsk > 0)) {
    wrap.style.display = "none";
    return;
  }
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - OB_RANGE);
  const hi = mid * (1 + OB_RANGE);
  let bidUsd = 0,
    askUsd = 0;
  for (const lv of bids) {
    const px = Number(lv.px),
      sz = Number(lv.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    if (px < lo) break;
    bidUsd += px * sz;
  }
  for (const lv of asks) {
    const px = Number(lv.px),
      sz = Number(lv.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    if (px > hi) break;
    askUsd += px * sz;
  }
  const total = bidUsd + askUsd;
  if (total <= 0) {
    wrap.style.display = "none";
    return;
  }
  const bidPct = (bidUsd / total) * 100;
  const askPct = 100 - bidPct;
  wrap.style.display = "flex";
  const bidEl = document.getElementById("orderbook-bid");
  const askEl = document.getElementById("orderbook-ask");
  const labelEl = document.getElementById("orderbook-label");
  if (bidEl) bidEl.style.flexBasis = bidPct.toFixed(2) + "%";
  if (askEl) askEl.style.flexBasis = askPct.toFixed(2) + "%";
  if (labelEl)
    labelEl.textContent = `bids ${bidPct.toFixed(0)}% / asks ${askPct.toFixed(0)}% · ±0.5%`;
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
  if (priceChart) {
    applyPriceChartTheme();
  }
}

function applyPriceChartTheme() {
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
function fmtPrice(p) {
  if (p == null || !Number.isFinite(Number(p))) return "—";
  p = Number(p);
  if (p >= 10000)
    return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1000) return `$${p.toFixed(1)}`;
  if (p >= 100) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toPrecision(4)}`;
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
  // HL 2026-05-23 unified mode: equity = spot.total + perp.uPnL,
  // available = spot.total - spot.hold. Раньше показывали отдельный
  // wallet-total / perp/spot breakdown — после миграции это один и
  // тот же пул, разбивка потеряла смысл.
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

  const wtEl = document.getElementById("wallet-total-val");
  if (wtEl) wtEl.style.display = "none";
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
        <div class="grid-item grid-item-primary"><div class="item-label">Net (Mkt) <span class="primary-tag">total</span></div><div class="item-value ${cls(pnl.netMarket)}">${sgn(pnl.netMarket)}$${Math.abs(pnl.netMarket).toFixed(4)}</div></div>
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
      <div class="grid-item"><div class="item-label">Entry</div><div class="item-value">${fmtPrice(pos.entryPrice)}</div></div>
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
      const liq =
        p.liquidationPrice != null ? fmtPrice(p.liquidationPrice) : "—";
      const lev = p.leverage != null ? `${p.leverage}x` : "—";
      const cur = p.currentPrice != null ? fmtPrice(p.currentPrice) : "—";
      return `
      <div style="margin-top:0.75rem; padding:0.75rem; border:1px dashed var(--border); border-radius:8px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:0.5rem;">
          <span style="background:rgba(234,179,8,0.12); color:var(--yellow,#eab308); border:1px solid rgba(234,179,8,0.3); padding:2px 8px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:700;">HANDS-OFF · MANUAL</span>
          <span class="item-value highlight">#${p.coin}</span>
          <span class="item-value ${sideCls}">${p.side}</span>
        </div>
        <div class="data-grid">
          <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(p.sizeUsd)} · ${lev}</div></div>
          <div class="grid-item"><div class="item-label">Entry · Now</div><div class="item-value">${fmtPrice(p.entryPrice)} · ${cur}</div></div>
          <div class="grid-item"><div class="item-label">uPnL</div><div class="item-value ${cls(p.unrealizedPnl)}">${sgn(p.unrealizedPnl)}$${Math.abs(p.unrealizedPnl).toFixed(4)}</div></div>
          <div class="grid-item"><div class="item-label">Liq</div><div class="item-value">${liq}</div></div>
        </div>
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

// Setup-вердикт: одна метка из комбо Accel + Vol× + направление.
// Логика 1:1 с FAQ-таблицей карточки Hot Movers — agg только визуализация,
// никакой новой стратегической логики, чтобы пользователь видел готовый
// ответ «заходить / ждать / мимо» без сборки комбо в голове.
// SVG-иконки для Setup пилл
const _SVG_ARROW_DOWN = `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-bottom:1px"><path d="M6 1v8M3 7l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
const _SVG_ARROW_UP = `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-bottom:1px"><path d="M6 11V3M3 5l3-3 3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
const _SVG_WAIT = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-bottom:1px;opacity:0.7"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 4v2.5l1.5 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`;

// ── Momentum-режим ────────────────────────────────────────────────────────
// В отличие от фейда, едем ПО движению. Направление = знак взвешенного хода
// по окнам (2m/5m/15m/1h, длинные окна весомее). accel/vol — подтверждение.
const _MOM_WEIGHTS = { 2: 0.2, 5: 0.4, 15: 0.8, 60: 1.2 };

function deriveAccelKind(w2, w5) {
  if (!w2 || !w5 || w2.spikePct == null || w5.spikePct == null) return null;
  const a = w2.spikePct,
    b = w5.spikePct;
  if (Math.abs(b) < 0.05) return "flat";
  if (a > 0 !== b > 0 && Math.abs(a) > 0.2) return "rev";
  const ratio = Math.abs(a) / Math.abs(b * 0.4);
  return ratio >= 1.2 ? "up" : ratio <= 0.6 ? "down" : "flat";
}

function deriveVolKind(volMult) {
  if (typeof volMult !== "number" || !isFinite(volMult)) return null;
  if (volMult >= 2) return "high";
  if (volMult >= 1.3) return "mid";
  if (volMult <= 0.5) return "thin";
  return "normal";
}

// Возвращает {label, cls, title, score, side}. score — для сортировки.
function computeMomentum(windows, accelKind, volKind) {
  let weighted = 0;
  let haveData = false;
  for (const w of windows) {
    if (w.spikePct == null) continue;
    const wt = _MOM_WEIGHTS[w.mins];
    if (wt == null) continue;
    weighted += w.spikePct * wt;
    haveData = true;
  }
  if (!haveData) {
    return {
      label: '<span class="num-inline-muted">—</span>',
      cls: "setup-none",
      title: "Нет данных",
      score: 0,
      side: null,
    };
  }
  const up = weighted > 0;
  const side = up ? "LONG" : "SHORT";
  let score = Math.abs(weighted);
  // Ускорение относительно тренда: ↑ подтверждает, выдох/разворот — штрафуют.
  if (accelKind === "up") score *= 1.15;
  else if (accelKind === "down") score *= 0.8;
  else if (accelKind === "rev") score *= 0.6;
  // Объём подтверждает реальность хода.
  if (volKind === "high") score *= 1.15;
  else if (volKind === "thin") score *= 0.85;

  const arrow = up ? _SVG_ARROW_UP : _SVG_ARROW_DOWN;
  if (score >= 3) {
    // STRONG ≥6 помечаем точкой; NORMAL — обычный пилл.
    const dot = score >= 6 ? " ●" : "";
    const confirm =
      (accelKind === "up" ? "accel↑ " : "") + (volKind === "high" ? "vol↑" : "");
    return {
      label: `<span class="setup-pill">${arrow}${side}${dot}</span>`,
      cls: up ? "setup-long" : "setup-short",
      title:
        `Momentum ${side} (score ${score.toFixed(1)})` +
        (confirm ? " · " + confirm.trim() : ""),
      score,
      side,
    };
  }
  if (score >= 1.5) {
    return {
      label: `<span class="setup-pill">${arrow}${side}</span>`,
      cls: up ? "setup-wait-long" : "setup-wait-short",
      title: `Слабый momentum ${side} (score ${score.toFixed(1)}) — наблюдаем`,
      score,
      side,
    };
  }
  return {
    label: `<span class="setup-pill">${_SVG_WAIT} WAIT</span>`,
    cls: up ? "setup-wait-long" : "setup-wait-short",
    title: "Хода мало — ждём явный тренд",
    score,
    side,
  };
}

// Предыдущая цена по монете — для биржевых flash-вспышек при изменении цены.
const _hmPrevPrices = new Map();

function renderHotMovers(payload) {
  const tbody = document.getElementById("hot-movers-tbody");
  const meta = document.getElementById("hot-movers-meta");
  if (!tbody || !meta) return;
  const signals = Array.isArray(payload?.signals) ? payload.signals : [];
  const th = payload?.thresholds || {};

  // Сортировка: по силе momentum'а (взвешенный ход по окнам + подтверждение
  // accel/vol). Едем ПО движению — ZEC-тип грайнда всплывает наверх как LONG.
  const enriched = signals
    .map((s) => {
      const windows = Array.isArray(s.windows) ? s.windows : [];
      let maxAbs = -Infinity;
      for (const w of windows) {
        if (w.spikePct != null && Math.abs(w.spikePct) > maxAbs) {
          maxAbs = Math.abs(w.spikePct);
        }
      }
      const w2 = windows.find((w) => w.mins === 2);
      const w5 = windows.find((w) => w.mins === 5);
      const mom = computeMomentum(
        windows,
        deriveAccelKind(w2, w5),
        deriveVolKind(s.volMult),
      );
      return { s, windows, maxAbs, momScore: mom.score };
    })
    .filter((x) => x.maxAbs > -Infinity)
    .sort((a, b) => b.momScore - a.momScore || b.maxAbs - a.maxAbs)
    .slice(0, 20);

  meta.textContent = payload?.ts
    ? `scope ${payload.universeSize} · top ${enriched.length} by momentum · updated ${fmtTime(payload.ts)}`
    : "—";

  if (!enriched.length) {
    tbody.innerHTML =
      '<tr><td colspan="10" class="empty-state">Waiting for price history…</td></tr>';
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
    if (!w || w.spikePct == null)
      return ['<span class="num-inline-muted">—</span>', ""];
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

      // Living heatmap: тинт строки по доминирующему движению цены (как на бирже —
      // вверх зелёный, вниз красный), интенсивность по |move|. Не зависит от
      // fade-тиров, поэтому карточка «дышит» даже когда сигналов нет.
      let domMove = 0;
      for (const w of x.windows) {
        if (w.spikePct != null && Math.abs(w.spikePct) > Math.abs(domMove))
          domMove = w.spikePct;
      }
      const moveAbs = Math.abs(domMove);
      const heatLvl =
        moveAbs >= 1.5
          ? "strong"
          : moveAbs >= 0.6
            ? "mid"
            : moveAbs >= 0.1
              ? "weak"
              : "";
      const heatCls = heatLvl
        ? `${domMove > 0 ? "row-up" : "row-down"} row-heat-${heatLvl}`
        : "";

      const rowCls = [s.isActive ? "is-active" : "", heatCls]
        .filter(Boolean)
        .join(" ");

      // Биржевая flash-вспышка: цена выросла с прошлого рендера → зелёный,
      // упала → красный. Анимация играет один раз на новом DOM-узле.
      const prevPx = _hmPrevPrices.get(s.coin);
      let flashCls = "";
      if (prevPx != null && s.price != null && s.price !== prevPx) {
        flashCls = s.price > prevPx ? "hm-flash-up" : "hm-flash-down";
      }
      if (s.price != null) _hmPrevPrices.set(s.coin, s.price);

      const winDefs = [
        [w2, "2m"],
        [w5, "5m"],
        [w15, "15m"],
      ];
      const cells = winDefs
        .map(([w, lbl]) => {
          const [inner, cls] = pctCellTiered(w);
          const klass = ["hm-window", cls].filter(Boolean).join(" ");
          return `<td class="${klass}" data-w="${lbl}">${inner}</td>`;
        })
        .join("");

      // Accel: |w2| vs линейная экстраполяция w5 (×0.4). Ratio ≥1.2 = ускорение
      // (не фейди), ≤0.6 = выдыхается (хороший момент), знаки разные = разворот.
      // accelKind/accelRatio выносим наружу — нужны для Setup-вердикта ниже.
      let accelInner = '<span class="num-inline-muted">—</span>';
      let accelCellCls = "";
      let accelKind = null; // 'up' | 'down' | 'flat' | 'rev' | null
      let accelRatio = null;
      if (w2 && w5 && w2.spikePct != null && w5.spikePct != null) {
        const a = w2.spikePct,
          b = w5.spikePct;
        if (Math.abs(b) < 0.05) {
          accelInner = '<span class="num-inline-muted">→</span>';
          accelKind = "flat";
        } else if (a > 0 !== b > 0 && Math.abs(a) > 0.2) {
          accelInner = '<span style="color:var(--accent)">↻ rev</span>';
          accelKind = "rev";
        } else {
          const expected = b * 0.4;
          const ratio = expected !== 0 ? Math.abs(a) / Math.abs(expected) : 0;
          accelRatio = ratio;
          if (ratio >= 1.2) {
            accelInner = `<span style="color:var(--red)">▲ ${ratio.toFixed(1)}×</span>`;
            accelCellCls = "num-neg-weak";
            accelKind = "up";
          } else if (ratio <= 0.6) {
            accelInner = `<span style="color:var(--green)">▼ ${ratio.toFixed(1)}×</span>`;
            accelCellCls = "num-pos-weak";
            accelKind = "down";
          } else {
            accelInner = `<span class="num-inline-muted">→ ${ratio.toFixed(1)}×</span>`;
            accelKind = "flat";
          }
        }
      }

      // Vol×: серверный multiplier (5min recent / avg 5min over hour).
      let volInner = '<span class="num-inline-muted">…</span>';
      let volCellCls = "";
      let volKind = null; // 'high' | 'mid' | 'normal' | 'thin' | null
      if (typeof s.volMult === "number" && isFinite(s.volMult)) {
        const v = s.volMult;
        let color = "var(--text-muted)";
        if (v >= 2) {
          color = "var(--red)";
          volCellCls = "num-neg-weak";
          volKind = "high";
        } else if (v >= 1.3) {
          color = "var(--orange, #f59e0b)";
          volKind = "mid";
        } else if (v <= 0.5) {
          color = "var(--green)";
          volCellCls = "num-pos-weak";
          volKind = "thin";
        } else {
          volKind = "normal";
        }
        volInner = `<span style="color:${color}">${v.toFixed(1)}×</span>`;
      } else if (s.volMult === null) {
        volInner = '<span class="num-inline-muted">—</span>';
      }

      // Setup: momentum-вердикт — направление ПО движению (вверх LONG, вниз
      // SHORT), сила по взвешенному ходу окон с подтверждением accel/vol.
      const setup = computeMomentum(x.windows, accelKind, volKind);

      // OI delta 5m
      let oiInner = '<span class="num-inline-muted">—</span>';
      let oiCellCls = "";
      if (typeof s.oiDelta5m === "number" && isFinite(s.oiDelta5m)) {
        const v = s.oiDelta5m;
        const arrow = v > 0 ? "▲" : "▼";
        if (Math.abs(v) >= 3) {
          oiCellCls = v > 0 ? "num-neg-weak" : "num-pos-weak"; // OI растёт при памп = плохо; падает = ликвидации
          oiInner = `<span style="color:${v > 0 ? "var(--red)" : "var(--green)"};font-weight:600">${arrow} ${fmtPct(v)}</span>`;
        } else if (Math.abs(v) >= 1) {
          oiInner = `<span style="color:var(--text-muted)">${arrow} ${fmtPct(v)}</span>`;
        } else {
          oiInner = `<span class="num-inline-muted">${fmtPct(v)}</span>`;
        }
      }

      return `<tr class="${rowCls}">
        <td>${idx + 1}</td>
        <td><span class="signals-price">#${escapeHtml(s.coin)}</span></td>
        <td class="hm-setup ${setup.cls}" data-w="Setup" title="${setup.title}">${setup.label}</td>
        <td class="hm-price-cell ${flashCls}"><span class="signals-price">${fmtPrice(s.price)}</span></td>
        ${cells}
        <td class="${accelCellCls}" data-w="Acc">${accelInner}</td>
        <td class="${oiCellCls}" data-w="OI">${oiInner}</td>
        <td data-w="Trend">${trendInner}</td>
      </tr>`;
    })
    .join("");
}

function renderSetupScanner(payload) {
  const tbody = document.getElementById("setup-scanner-tbody");
  const meta = document.getElementById("setup-scanner-meta");
  if (!tbody || !meta) return;
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];

  if (!rows.length) {
    meta.textContent = "collecting first snapshots…";
    tbody.innerHTML =
      '<tr><td colspan="9" class="empty-state">Waiting for first snapshot…</td></tr>';
    return;
  }

  // Сортировка: по «насыщенности» сигналов. Прокси-скор:
  //   |fundingApy| + |premium%|*5 + (fundingPersist.fractionExtreme ?? 0)*20
  //   + |oi7d.deltaOi|*30 при |deltaPx|<5% (OI ramp без цены)
  const sigScore = (r) => {
    let s = Math.abs(r.fundingApy || 0);
    if (r.premium != null) s += Math.abs(r.premium) * 500; // premium — доля
    const fp = r.fundingPersist;
    if (fp && fp.fractionExtreme != null) s += fp.fractionExtreme * 20;
    const oi = r.oi7d;
    if (
      oi &&
      oi.deltaOi != null &&
      oi.deltaPx != null &&
      Math.abs(oi.deltaPx) < 0.05
    ) {
      s += Math.abs(oi.deltaOi) * 30;
    }
    return s;
  };
  const enriched = [...rows]
    .sort((a, b) => sigScore(b) - sigScore(a))
    .slice(0, 25);

  // Honest meta: возраст самого старого ряда (≈ возраст collector'а)
  const collectorAgeH = rows.reduce((min, r) => {
    const fpAge = r.fundingPersist?.ageHours ?? 0;
    return fpAge > min ? fpAge : min;
  }, 0);
  const ageLabel =
    collectorAgeH < 48
      ? `early data · ${collectorAgeH.toFixed(0)}h collected`
      : collectorAgeH < 7 * 24
        ? `${collectorAgeH.toFixed(0)}h collected · persist ready`
        : collectorAgeH < 30 * 24
          ? `${(collectorAgeH / 24).toFixed(1)}d collected · 7d ready`
          : `${(collectorAgeH / 24).toFixed(0)}d collected · full`;
  meta.textContent = payload?.ts
    ? `${rows.length} coins · ${ageLabel} · updated ${fmtTime(payload.ts)}`
    : "—";

  const fmtUsd = (v) => {
    if (v == null || !isFinite(v))
      return '<span class="num-inline-muted">—</span>';
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  };
  const fmtPct = (v, digits = 2) => {
    if (v == null || !isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(digits)}%`;
  };
  const fundingCell = (apy) => {
    if (apy == null) return '<span class="num-inline-muted">—</span>';
    // HL funding baseline ≈ 0.00125%/h when premium≈0 → ~10.95% APY.
    // Values within ±2% of baseline mean "no premium signal", render as neutral.
    const HL_BASELINE_APY = 10.95;
    const isNeutral = Math.abs(apy - HL_BASELINE_APY) < 2;
    if (isNeutral) {
      return `<span class="num-inline-muted" title="≈ HL baseline (premium ≈ 0)">≈base</span>`;
    }
    const cls =
      apy > 0
        ? "num-inline-pos"
        : apy < 0
          ? "num-inline-neg"
          : "num-inline-muted";
    const tag =
      Math.abs(apy) > 50
        ? '<span style="font-weight:700">'
        : Math.abs(apy) > 20
          ? "<span>"
          : '<span style="opacity:0.7">';
    return `<span class="${cls}">${tag}${fmtPct(apy, 1)}</span></span>`;
  };
  const premiumCell = (p) => {
    if (p == null) return '<span class="num-inline-muted">—</span>';
    const pct = p * 100;
    const cls =
      pct > 0
        ? "num-inline-pos"
        : pct < 0
          ? "num-inline-neg"
          : "num-inline-muted";
    return `<span class="${cls}">${fmtPct(pct, 3)}</span>`;
  };
  const persistCell = (fp) => {
    if (!fp) return '<span class="num-inline-muted">—</span>';
    if (fp.etaHours != null) {
      const eta = fp.etaHours.toFixed(0);
      return `<span class="num-inline-muted">collecting · ${eta}h</span>`;
    }
    const frac = (fp.fractionExtreme * 100).toFixed(0);
    const color =
      fp.fractionExtreme >= 0.8
        ? "var(--red)"
        : fp.fractionExtreme >= 0.4
          ? "var(--orange, #f59e0b)"
          : "var(--text-muted)";
    return `<span style="color:${color}">${frac}% extreme</span>`;
  };
  const oiCell = (oi) => {
    if (!oi) return '<span class="num-inline-muted">—</span>';
    if (oi.etaHours != null) {
      const days = (oi.etaHours / 24).toFixed(1);
      return `<span class="num-inline-muted">collecting · ${days}d</span>`;
    }
    const oiPct = oi.deltaOi * 100;
    const pxPct = oi.deltaPx != null ? oi.deltaPx * 100 : null;
    const oiSign = oiPct > 0 ? "+" : "";
    const pxStr =
      pxPct != null ? `${pxPct > 0 ? "+" : ""}${pxPct.toFixed(1)}%` : "—";
    // Highlight: большой OI ramp без движения цены
    const ramp = Math.abs(oiPct) > 40 && pxPct != null && Math.abs(pxPct) < 5;
    const cls = ramp ? 'style="color:var(--accent);font-weight:600"' : "";
    return `<span ${cls}>${oiSign}${oiPct.toFixed(0)}% / ${pxStr}</span>`;
  };
  const volRegimeCell = (vr) => {
    if (!vr) return '<span class="num-inline-muted">—</span>';
    if (vr.etaHours != null) {
      const days = (vr.etaHours / 24).toFixed(0);
      return `<span class="num-inline-muted">collecting · ${days}d</span>`;
    }
    const r = vr.ratio;
    let color = "var(--text-muted)";
    if (r >= 2) color = "var(--red)";
    else if (r >= 1.5) color = "var(--orange, #f59e0b)";
    else if (r <= 0.5) color = "var(--green)";
    return `<span style="color:${color}">${r.toFixed(2)}×</span>`;
  };

  tbody.innerHTML = enriched
    .map(
      (r, idx) => `<tr>
      <td>${idx + 1}</td>
      <td><span class="signals-price">#${escapeHtml(r.coin)}</span></td>
      <td>${fundingCell(r.fundingApy)}</td>
      <td>${premiumCell(r.premium)}</td>
      <td>${fmtUsd(r.oiUsd)}</td>
      <td>${fmtUsd(r.vol24hUsd)}</td>
      <td>${persistCell(r.fundingPersist)}</td>
      <td>${oiCell(r.oi7d)}</td>
      <td>${volRegimeCell(r.volRegime)}</td>
    </tr>`,
    )
    .join("");
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (r.status === 401) window.location.href = "/login";
  return r.json();
}

// Market Context bar — вердикт по фону (risk-on/off). Деградирует тихо,
// если priceHistory ещё пуст (первые минуты после рестарта бота).
const MC_VERDICT_LABEL = {
  RISK_ON: "RISK-ON",
  RISK_OFF: "RISK-OFF",
  MIXED: "MIXED",
  UNKNOWN: "—",
};
function mcMoveSpan(label, pct) {
  if (pct == null) return `<span>${label} —</span>`;
  const cls = pct >= 0 ? "up" : "down";
  const sign = pct >= 0 ? "+" : "";
  return `<span class="${cls}">${label} ${sign}${pct.toFixed(2)}%</span>`;
}

// ── Fear & Greed gauge (полукруглый спидометр со стрелкой) ──
// value 0..100. 0 = слева (Extreme Fear), 100 = справа (Extreme Greed).
const FNG_GEO = { cx: 66, cy: 60, r: 48 };
// Точка на дуге для значения v (радиус rr). th: v=0→π (лево), v=100→0 (право).
function fngPoint(v, rr) {
  const th = Math.PI * (1 - Math.max(0, Math.min(100, v)) / 100);
  return [FNG_GEO.cx + rr * Math.cos(th), FNG_GEO.cy - rr * Math.sin(th)];
}
function fngArc(v1, v2) {
  const [x1, y1] = fngPoint(v1, FNG_GEO.r);
  const [x2, y2] = fngPoint(v2, FNG_GEO.r);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${FNG_GEO.r} ${FNG_GEO.r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}
function fngColor(v) {
  if (v < 20) return "#f6465c"; // extreme fear
  if (v < 40) return "#f0883e"; // fear
  if (v < 56) return "#f3d42f"; // neutral
  if (v < 76) return "#58bd7d"; // greed
  return "#0ecb81"; // extreme greed
}
// 5 цветных сегментов дуги (зоны страх→жадность).
const FNG_ZONES = [
  [0, 20, "#f6465c"],
  [20, 40, "#f0883e"],
  [40, 56, "#f3d42f"],
  [56, 76, "#58bd7d"],
  [76, 100, "#0ecb81"],
];
function renderFngGauge(value, label) {
  const v = Math.max(0, Math.min(100, value));
  const segs = FNG_ZONES.map(
    ([a, b, c]) =>
      `<path d="${fngArc(a, b)}" stroke="${c}" stroke-width="8" fill="none" />`,
  ).join("");
  const [nx, ny] = fngPoint(v, FNG_GEO.r - 9);
  const { cx, cy } = FNG_GEO;
  return `
    <svg class="fng-gauge" viewBox="0 0 132 84" width="116" height="74"
         role="img" aria-label="Fear and Greed ${v} ${label || ""}">
      ${segs}
      <line class="fng-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" />
      <circle class="fng-hub" cx="${cx}" cy="${cy}" r="3.5" />
      <text class="fng-num" x="${cx}" y="${cy + 19}" text-anchor="middle">${v}</text>
    </svg>`;
}
function renderMarketContext(d) {
  const el = document.getElementById("market-context");
  if (!el || !d) return;
  // Светофор «можно/нельзя»: чёткий фонд (RISK-ON/OFF) = go (зелёный),
  // MIXED = wait (жёлтый), всё прочее = unknown (серый).
  const cls =
    d.verdict === "RISK_ON" || d.verdict === "RISK_OFF"
      ? "go"
      : d.verdict === "MIXED"
        ? "wait"
        : "unknown";
  el.className = `market-context ${cls}`;
  const verdictEl = document.getElementById("mc-verdict");
  const btcEl = document.getElementById("mc-btc");
  const fngEl = document.getElementById("mc-fng");
  if (verdictEl) {
    verdictEl.textContent = `MARKET: ${MC_VERDICT_LABEL[d.verdict] || "—"} ${d.arrow || ""}`.trim();
  }
  if (btcEl) {
    const b = d.btc || {};
    btcEl.innerHTML =
      mcMoveSpan("BTC 15m", b.m15) +
      mcMoveSpan("1h", b.m1h) +
      mcMoveSpan("4h", b.m4h);
  }
  if (fngEl) {
    if (d.fearGreed) {
      const { value, label } = d.fearGreed;
      fngEl.innerHTML =
        `<span class="mc-fng-cap">F&amp;G</span>` +
        renderFngGauge(value, label) +
        `<span class="mc-fng-class" style="color:${fngColor(value)}">${label || ""}</span>`;
    } else {
      fngEl.innerHTML = "";
    }
  }
}

async function tick() {
  const [historyR, activityR, taxR, pnlR, insightsR, hmR, btcR, mcR] =
    await Promise.allSettled([
      fetchJson(`/api/history?hours=${currentRangeHours}`),
      fetchJson(`/api/activity?hours=${currentRangeHours}&limit=10`),
      fetchJson("/api/tax-summary"),
      fetchJson("/api/pnl-summary"),
      fetchJson("/api/insights"),
      fetchJson("/api/signals?limit=30"),
      fetchJson("/api/candles?coin=BTC&interval=1m"),
      fetchJson("/api/market-context"),
    ]);
  if (mcR.status === "fulfilled") renderMarketContext(mcR.value);
  if (hmR.status === "fulfilled" && hmR.value?.signals) {
    _hmSignalsCache = hmR.value.signals;
    renderHotMovers(hmR.value);
  }
  if (
    btcR.status === "fulfilled" &&
    Array.isArray(btcR.value) &&
    btcR.value.length >= 2
  ) {
    const candles = btcR.value;
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const prevClose = prev?.c ?? prev?.close;
    const lastClose = last?.c ?? last?.close;
    if (prevClose && lastClose) {
      _btcMomentum1m = ((lastClose - prevClose) / prevClose) * 100;
    }
  }
  await fetchMacroIfStale();
  _tickReady = true;
  renderSmartSignals();
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
      const canOpen =
        e.kind === "close" || e.kind === "manual_close" || e.kind === "open";
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

// ── Help modal (mini FAQ per card) ─────────────────────────────────────
const HELP_CONTENT = {
  setupScanner: {
    title: "Setup Scanner — конвергенция HL-сигналов",
    lead: "Manual-helper: ищет монеты, где совпали 2-3 ортогональных сигнала (funding extreme + premium, OI ramp без движения цены, vol regime shift). Не торгует, бот не трогает.",
    sections: [
      {
        title: "Источник данных",
        sub: "Scout раз в 60min (SETUP_SNAPSHOT_INTERVAL_MIN) пишет snapshot по всем монетам из liquidSet (top-50 по 24h vol) в setup_snapshots. Retention 90 дней. HL не отдаёт историю — копим сами с нуля.",
      },
      {
        title: "Funding APY",
        sub: "Annualized funding (current). > +30% APY = шортов перебор, < -30% = лонгов перебор. Сам по себе шум; ценен в комбо с persist.",
      },
      {
        title: "Premium",
        sub: "Mark vs oracle. > 0 = mark выше oracle (давление покупателей), < 0 = давление продавцов. Доли %, не путать с funding.",
      },
      {
        title: "Persist 48h",
        sub: "Доля 48ч-сэмплов с |APY| > 30%. Funding extreme который ДЕРЖИТСЯ ≥48ч = устойчивая разбалансировка позиций, не разовый всплеск.",
        rows: [
          [
            '<span style="color:var(--red)">≥80% extreme</span>',
            "Перенасыщенная сторона — высокая вероятность сжатия (squeeze)",
          ],
          ['<span style="color:#f59e0b">40-80%</span>', "Заметное смещение"],
          [
            '<span class="num-inline-muted">collecting · Xh</span>',
            "Недостаточно истории, ждём 48ч",
          ],
        ],
      },
      {
        title: "OI Δ7d / Px",
        sub: "Δ Open Interest vs Δ цены за 7 дней. Главный setup-маркер: OI растёт сильно, а цена стоит → накапливают позицию, ждут катализатор.",
        rows: [
          [
            '<span style="color:var(--accent)">+50% / +2%</span>',
            "Massive accumulation без движения — high-conviction setup",
          ],
          [
            "+10% / +30%",
            "OI просто следует за ценой — нормальный тренд, не setup",
          ],
          [
            '<span class="num-inline-muted">collecting · Xd</span>',
            "Ждём 7 дней истории",
          ],
        ],
      },
      {
        title: "Vol regime",
        sub: "Vol 24h / средний 24h vol за 30d. > 1.5× = регулярный объём вырос (рост интереса). < 0.5× = монета остыла. Нужно 30 дней истории.",
      },
      {
        title: "Почему нет суммарного score 0-4",
        sub: "Пока persist/OI/regime ещё «collecting» — суммарный балл будет враньём. Показываем сигналы по отдельности и красим только те, что готовы. Через ~30 дней появится полноценный score.",
      },
    ],
  },
  chillBoy: {
    title: "Chill Boy — Shadow Trading",
    lead: "Trend-follow squeeze-breakout стратегия #4. Детектор работает в PROD-боте, но НЕ торгует реальный slot — всё в PAPER. Карточка собирает данные для решения о промоушене стратегии в live.",
    sections: [
      {
        title: "Режим",
        rows: [
          [
            '<span class="status-pill">PAPER</span>',
            "Симуляция на виртуальном балансе (compound seed ~$115)",
          ],
          [
            '<span class="status-pill">PROD</span>',
            "Реальные слоты бота (включается через CHILL_BOY_PROD_ENABLED=true)",
          ],
        ],
      },
      {
        title: "Active paper position",
        sub: "Текущая открытая paper-позиция: монета, side, entry, MFE/MAE в реальном времени. Показывается только когда симулятор внутри слота.",
      },
      {
        title: "Watchlist — closest to breakout",
        sub: "Монеты в состоянии squeeze (низкая волатильность, узкие Bollinger/ATR-bands) — потенциальные брейкаут-кандидаты. Сортировка по близости к пробою.",
      },
      {
        title: "Cooldowns",
        sub: "Монеты под временным запретом на повторный вход: после SL или TP стратегия даёт монете «остыть». Cooldowns переживают рестарт бота (persist в data/hunter_cooldowns.json).",
      },
      {
        title: "Paper trades history (MFE / MAE)",
        sub: "Закрытые paper-сделки с метриками экстремумов цены за время удержания. Помогают оценить «упустила ли стратегия профит» / «как далеко уходила в минус».",
        rows: [
          [
            '<span style="color:var(--green)">MFE</span>',
            "Maximum Favorable Excursion — лучший непойманный профит",
          ],
          [
            '<span style="color:var(--red)">MAE</span>',
            "Maximum Adverse Excursion — глубочайшая просадка",
          ],
          ["Net", "Фактический P&L по правилам детектора"],
          [
            "Reason",
            "Причина выхода: trend_follow_tp / sl / time_stop / reversal",
          ],
        ],
      },
      {
        title: "Detector heartbeat",
        sub: "Низ карточки: tracked (сколько монет в фокусе) · squeezed (сколько в squeeze) · breakouts (сколько пробоев за тик) · slot (IDLE/IN_POS) · cooldowns (re-cooldown + post-SL cooldown).",
      },
    ],
  },
};

function renderHelpSection(s) {
  let html = `<div class="help-section">`;
  html += `<div class="help-section-title">${s.title}</div>`;
  if (s.sub) html += `<div class="help-section-sub">${s.sub}</div>`;
  if (Array.isArray(s.rows) && s.rows.length) {
    html += `<table class="help-table"><tbody>`;
    for (const r of s.rows) {
      html += `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  return html;
}

function openHelpModal(key) {
  const content = HELP_CONTENT[key];
  const modal = document.getElementById("help-modal");
  const body = document.getElementById("help-modal-body");
  if (!content || !modal || !body) return;
  body.innerHTML =
    `<div class="help-modal__title">${content.title}</div>` +
    (content.lead
      ? `<div class="help-modal__lead">${content.lead}</div>`
      : "") +
    content.sections.map(renderHelpSection).join("");
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeHelpModal() {
  const modal = document.getElementById("help-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
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
  const stratText =
    isManual && !/manual/i.test(strat) ? `${strat} · 🖐 Manual` : strat;
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
  if (e.entryPrice != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(e.entryPrice)}</div></div>`,
    );
  if (e.closePrice != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(e.closePrice)}</div></div>`,
    );
  if (e.sizeUsd != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${e.sizeUsd.toFixed(2)}</div></div>`,
    );
  if (e.reason)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Reason</div><div class="tm-cell-value">${e.reason}</div></div>`,
    );

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
  const holdMs =
    t.closed_at && t.entry_time ? t.closed_at - t.entry_time : null;
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
  if (sl != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Stop Loss</div><div class="tm-cell-value">$${fmtPx(sl)}</div></div>`,
    );
  if (tp != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Take Profit</div><div class="tm-cell-value">$${fmtPx(tp)}</div></div>`,
    );
  cells.push(
    `<div class="tm-cell"><div class="tm-cell-label">Gross PnL</div><div class="tm-cell-value ${grossPnl >= 0 ? "positive" : "negative"}">${grossPnl >= 0 ? "+" : "−"}$${Math.abs(grossPnl).toFixed(4)}</div></div>`,
  );
  cells.push(
    `<div class="tm-cell"><div class="tm-cell-label">Fees</div><div class="tm-cell-value muted">−$${Math.abs(fee).toFixed(4)}</div></div>`,
  );
  if (t.reason)
    cells.push(
      `<div class="tm-cell full"><div class="tm-cell-label">Close reason</div><div class="tm-cell-value">${t.reason}</div></div>`,
    );

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
      if (slot && r?.trade)
        slot.outerHTML = `<div class="tm-section">${tradeDetailHtml(r.trade)}</div>`;
    } catch (err) {
      const slot = document.getElementById("tm-detail-slot");
      if (slot)
        slot.innerHTML =
          '<div class="tm-sub">Не удалось загрузить детали</div>';
    }
  }
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#trade-modal [data-close]")) {
    closeTradeModal();
    return;
  }
  if (e.target.closest("#help-modal [data-close]")) {
    closeHelpModal();
    return;
  }
  const helpBtn = e.target.closest(".help-btn[data-help]");
  if (helpBtn) {
    openHelpModal(helpBtn.dataset.help);
    return;
  }
  if (e.target.closest("#activity-container")) onActivityClick(e);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeTradeModal();
    closeHelpModal();
  }
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

  // Strategy breakdown — byStrategy уже включает 'manual' (server-side combined).
  const stratContainer = document.getElementById("pnl-strategy");
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
      const color =
        ve.pnlTotal >= 0
          ? "var(--accent-positive, #4caf50)"
          : "var(--accent-negative, #f44336)";
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
      const fmt = (v) =>
        v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
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
        const color =
          net >= 0
            ? "var(--accent-positive, #4caf50)"
            : "var(--accent-negative, #f44336)";
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
  // Показываем карточку всегда, когда стратегия включена (paper ИЛИ prod).
  // Раньше в PROD гасилась, но именно в PROD это главный радар находок.
  if (!cb || !cb.enabled) {
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

  renderChillBoySignals(cb.signals);
  renderChillBoyActivePos(cb.paperPosition);
  renderChillBoyWatchlist(cb.heartbeat?.watchlist);
  renderChillBoyCooldowns(cb.heartbeat?.cooldownList);
  renderChillBoyHistory(cb.paperTrades, cb.paperStats);
  renderChillBoyHeartbeatRaw(cb.heartbeat);
}

// Лента последних пробоев (радар). Главная ценность Chill Boy — находить монеты,
// которых не видно на aggr.trade. Свежайший сигнал также кладём в data-атрибут
// аккордеона для бейджа в свёрнутой шапке (см. inline-скрипт в index.html).
function renderChillBoySignals(signals) {
  const body = document.getElementById("cb-signals-body");
  if (!body) return;
  const acc = document.getElementById("sec-chillboy");
  if (!Array.isArray(signals) || signals.length === 0) {
    body.innerHTML = '<div class="empty-state">no breakouts yet</div>';
    if (acc) acc.removeAttribute("data-badge-text");
    return;
  }
  const fmtAge = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  };
  body.innerHTML = signals
    .map((s) => {
      const dir = s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const tag = s.traded
        ? '<span class="cb-sig-tag traded">бот вошёл</span>'
        : '<span class="cb-sig-tag">сигнал</span>';
      return (
        `<div class="cb-sig-row"><span class="cb-sig-dir">${dir}</span> ` +
        `<b>#${s.coin}</b> <span class="cb-sig-px">@ $${s.price}</span> ${tag} ` +
        `<span class="cb-sig-age">${fmtAge(s.ts)} ago</span></div>`
      );
    })
    .join("");
  // Бейдж: свежайший сигнал (для свёрнутой шапки Radar-аккордеона)
  if (acc) {
    const top = signals[0];
    const d = top.direction === "LONG" ? "▲" : "▼";
    acc.setAttribute("data-badge-text", `${d} ${top.coin} · ${fmtAge(top.ts)}`);
  }
}

// ── Candy Girl — signal-only радар (1h EMA-тренд + 5m pullback-reclaim) ──────
function renderCandyGirl(cg) {
  _cgSignalsCache = Array.isArray(cg?.signals) ? cg.signals : [];
  if (_tickReady) renderSmartSignals();

  const card = document.getElementById("sec-candygirl");
  if (!card) return;
  if (!cg || !cg.enabled) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const fmtAge = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  };
  const fmtPx = (v) => (v == null ? "—" : `$${Number(v).toFixed(6)}`);
  const trendIcon = (t) =>
    t === "up"
      ? '<span style="color:var(--green,#3ddc84)">▲ up</span>'
      : t === "down"
        ? '<span style="color:var(--red,#ff5c5c)">▼ down</span>'
        : '<span style="opacity:.5">—</span>';

  const tbody = document.getElementById("cg-signals-tbody");
  if (tbody) {
    const signals = Array.isArray(cg.signals) ? cg.signals : [];
    if (signals.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="empty-state">no setups yet</td></tr>';
      card.removeAttribute("data-badge-text");
    } else {
      tbody.innerHTML = signals
        .map((s) => {
          const isLong = s.direction === "LONG";
          const dir = isLong
            ? '<span style="color:var(--green,#3ddc84)">🟢 LONG</span>'
            : '<span style="color:var(--red,#ff5c5c)">🔴 SHORT</span>';
          const risk = Math.abs((s.entry ?? 0) - (s.sl ?? 0));
          const rr =
            risk > 0
              ? (Math.abs((s.tp ?? 0) - (s.entry ?? 0)) / risk).toFixed(1)
              : "?";
          const activeCls = isActiveCoin(s.coin) ? " is-active" : "";
          return (
            `<tr class="cg-sig-row ${isLong ? "dir-long" : "dir-short"}${activeCls}">` +
            `<td>${dir}</td>` +
            `<td><b>#${s.coin}</b></td>` +
            `<td>$${s.price}</td>` +
            `<td>${fmtPx(s.entry)}</td>` +
            `<td>${fmtPx(s.sl)}</td>` +
            `<td>${fmtPx(s.tp)}</td>` +
            `<td>${rr}</td>` +
            `<td>${trendIcon(s.trend4h)}</td>` +
            `<td>${fmtAge(s.ts)}</td>` +
            `</tr>`
          );
        })
        .join("");
      const top = signals[0];
      const d = top.direction === "LONG" ? "▲" : "▼";
      card.setAttribute(
        "data-badge-text",
        `${d} ${top.coin} · ${fmtAge(top.ts)}`,
      );
    }
  }

  // Точность сигналов (TP-before-SL). Показываем только когда есть решённые.
  const accEl = document.getElementById("candygirl-acc");
  if (accEl) {
    const st = cg.stats;
    const decided = st ? (st.win || 0) + (st.loss || 0) : 0;
    if (st && decided > 0) {
      const pct = Math.round((st.winRate ?? 0) * 100);
      accEl.style.display = "";
      accEl.textContent = `acc ${pct}% (${st.win}W/${st.loss}L · ${st.open} open)`;
    } else if (st && st.open > 0) {
      accEl.style.display = "";
      accEl.textContent = `${st.open} open · collecting`;
    } else {
      accEl.style.display = "none";
    }
  }

  const hb = cg.heartbeat;
  const hbEl = document.getElementById("cg-heartbeat");
  if (hbEl) {
    hbEl.textContent = hb
      ? `tracked=${hb.tracked} · trending=${hb.trending} · signals=${hb.signals} · cooldowns=${hb.cooldowns}`
      : "—";
  }
  const pill = document.getElementById("candygirl-hb");
  if (pill) {
    if (hb) {
      pill.style.display = "";
      pill.textContent = `${hb.trending} trending`;
    } else {
      pill.style.display = "none";
    }
  }

  // Paper shadow-слот (Iter 2): equity-пилюля + активная позиция + история.
  const eqPill = document.getElementById("candygirl-card-equity");
  if (eqPill) {
    const ve = cg.virtualEquity;
    if (ve && cg.virtualBalance > 0) {
      const pnl = ve.pnlTotal ?? 0;
      const sign = pnl >= 0 ? "+" : "−";
      eqPill.style.display = "";
      eqPill.textContent = `paper $${ve.equity.toFixed(2)} (${sign}$${Math.abs(pnl).toFixed(2)})`;
      eqPill.style.color =
        pnl >= 0 ? "var(--green,#3ddc84)" : "var(--red,#ff5c5c)";
    } else {
      eqPill.style.display = "none";
    }
  }
  renderCandyGirlActivePos(cg.paperPosition);
  renderCandyGirlHistory(cg.paperTrades, cg.paperStats, cg.paperPeriod);
}

function renderCandyGirlActivePos(pos) {
  const section = document.getElementById("cg-active-section");
  const body = document.getElementById("cg-active-body");
  if (!section || !body) return;
  if (!pos) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const fmtPx = (v) => (v == null ? "—" : `$${v.toFixed(6)}`);
  const pnlCls =
    (pos.unrealUsd ?? 0) >= 0 ? "cb-pos-pnl positive" : "cb-pos-pnl negative";
  const heldStr =
    pos.heldMin >= 60
      ? `${Math.floor(pos.heldMin / 60)}h ${pos.heldMin % 60}m`
      : `${pos.heldMin}m`;
  const sl = `${fmtPx(pos.slPrice)}${pos.slDistPct != null ? ` <span style="opacity:.6">(${pos.slDistPct.toFixed(2)}%)</span>` : ""}`;
  const tp = `${fmtPx(pos.tpPrice)}${pos.tpDistPct != null ? ` <span style="opacity:.6">(${pos.tpDistPct.toFixed(2)}%)</span>` : ""}`;

  body.innerHTML = `
    <table class="cb-table">
      <thead><tr>
        <th>Coin</th><th>Side</th><th>Size</th><th>Entry → Cur</th>
        <th>Unreal</th><th>Held</th><th>SL</th><th>TP</th>
      </tr></thead>
      <tbody><tr>
        <td><b>${pos.coin}</b></td>
        <td>${(pos.side || "").toUpperCase()}</td>
        <td>$${pos.sizeUsd.toFixed(2)}</td>
        <td>${fmtPx(pos.entryPrice)}<br><span style="opacity:.65">${fmtPx(pos.currentPrice)}</span></td>
        <td><span class="${pnlCls}"><b>${fmtUsd(pos.unrealUsd)}</b><br>${fmtPct(pos.unrealPct)}</span></td>
        <td>${heldStr}</td>
        <td>${sl}</td>
        <td>${tp}</td>
      </tr></tbody>
    </table>
  `;
}

function renderCandyGirlHistory(trades, stats, period) {
  const body = document.getElementById("cg-history-body");
  const inline = document.getElementById("cg-stats-inline");
  if (!body) return;

  if (inline && stats && stats.n > 0) {
    const fmt = (v) =>
      v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    inline.textContent = `n=${stats.n} · net ${fmt(stats.sumNet)} · avg ${fmt(stats.avgNet)} · win ${(stats.winRate * 100).toFixed(0)}% · best ${fmt(stats.bestNet)} · worst ${fmt(stats.worstNet)}`;
  } else if (inline) {
    inline.textContent = "";
  }

  // Summary под таблицей: P&L за день и за неделю (профит/убыток paper-слота).
  const periodHtml = (() => {
    if (!period) return "";
    const cell = (label, p) => {
      const net = p?.net ?? 0;
      const n = p?.n ?? 0;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      const txt =
        net >= 0 ? `+$${net.toFixed(2)}` : `-$${Math.abs(net).toFixed(2)}`;
      return (
        `<span class="cg-sum-item"><span class="cg-sum-label">${label}</span>` +
        `<b style="color:${color}">${txt}</b> <span style="opacity:.55">(${n})</span></span>`
      );
    };
    return `<div class="cg-summary">${cell("Today", period.day)}${cell("Week", period.week)}</div>`;
  })();

  if (!Array.isArray(trades) || trades.length === 0) {
    body.innerHTML =
      '<div class="empty-state">no closed trades yet</div>' + periodHtml;
    return;
  }
  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
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
  const rows = trades
    .map((t) => {
      const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
      <td>${fmtTs(t.entry_time)}<br><span style="opacity:.65">${fmtTs(t.closed_at)}</span></td>
      <td><b>${t.coin}</b><br><span style="opacity:.65">${(t.side || "").toUpperCase()}</span></td>
      <td>$${(t.entry_price ?? 0).toFixed(6)}<br><span style="opacity:.65">$${(t.close_price ?? 0).toFixed(6)}</span></td>
      <td style="color:${color}"><b>${fmtUsd(net)}</b></td>
      <td>${fmtHold(t.hold_seconds)}</td>
      <td style="opacity:.75">${t.reason || "—"}</td>
    </tr>`;
    })
    .join("");
  body.innerHTML =
    `
    <table class="cb-table">
      <thead><tr><th>Open / Close</th><th>Coin</th><th>Entry / Exit</th><th>Net</th><th>Held</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  ` + periodHtml;
}

function renderChillBoyActivePos(pos) {
  const section = document.getElementById("cb-active-section");
  const body = document.getElementById("cb-active-body");
  if (!section || !body) return;
  if (!pos) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const fmtPx = (v) => (v == null ? "—" : `$${v.toFixed(6)}`);
  const pnlCls =
    (pos.unrealUsd ?? 0) >= 0 ? "cb-pos-pnl positive" : "cb-pos-pnl negative";
  const heldStr =
    pos.heldMin >= 60
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
  const rows = items
    .map((w) => {
      const ratio = w.ratio != null ? w.ratio.toFixed(2) : "—";
      return `<tr>
      <td><b>${w.coin}</b></td>
      <td>$${w.price.toFixed(6)}</td>
      <td>r=${ratio}</td>
      <td>↑${w.distUpPct.toFixed(2)}%</td>
      <td>↓${w.distDownPct.toFixed(2)}%</td>
    </tr>`;
    })
    .join("");
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
  const rows = items
    .map((c) => {
      const remainStr =
        c.remainMs > 60000
          ? `${Math.round(c.remainMs / 60000)}m`
          : `${Math.round(c.remainMs / 1000)}s`;
      const kindLabel = c.kind === "post_sl" ? "post-SL" : "re-entry";
      return `<tr><td><b>${c.coin}</b></td><td>${kindLabel}</td><td>${remainStr}</td></tr>`;
    })
    .join("");
  body.innerHTML = `<table class="cb-table"><thead><tr><th>Coin</th><th>Kind</th><th>Remaining</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderChillBoyHistory(trades, stats) {
  const body = document.getElementById("cb-history-body");
  const inline = document.getElementById("cb-stats-inline");
  if (!body) return;

  if (inline && stats && stats.n > 0) {
    const fmt = (v) =>
      v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    inline.textContent = `n=${stats.n} · net ${fmt(stats.sumNet)} · avg ${fmt(stats.avgNet)} · win ${(stats.winRate * 100).toFixed(0)}% · best ${fmt(stats.bestNet)} · worst ${fmt(stats.worstNet)}`;
  } else if (inline) {
    inline.textContent = "";
  }

  if (!Array.isArray(trades) || trades.length === 0) {
    body.innerHTML = '<div class="empty-state">no closed trades yet</div>';
    return;
  }
  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
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
  const rows = trades
    .map((t) => {
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
    })
    .join("");
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
  const age =
    ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  el.textContent =
    `tracked ${hb.tracked} · squeezed ${hb.squeezed} · breakouts ${hb.breakouts} · ` +
    `slot ${hb.slot} · cooldowns ${hb.reCooldowns} re + ${hb.postSlCooldowns} post-SL · ${age}`;
}

// ── Fader (Strategy #5) — PAPER-only card ───────────────────
function renderFaderCard(f) {
  const card = document.getElementById("sec-fader");
  if (!card) return;
  if (!f || !f.enabled) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const equityEl = document.getElementById("fader-equity-pill");
  if (equityEl) {
    if (f.virtualEquity) {
      const ve = f.virtualEquity;
      const sign = ve.pnlTotal >= 0 ? "+" : "-";
      equityEl.style.display = "";
      equityEl.textContent = `$${ve.equity.toFixed(2)} (${sign}$${Math.abs(ve.pnlTotal).toFixed(2)} · ${sign}${Math.abs(ve.pnlPct * 100).toFixed(1)}%)`;
      equityEl.style.color = ve.pnlTotal >= 0 ? "var(--green)" : "var(--red)";
    } else {
      equityEl.style.display = "none";
    }
  }

  renderFaderActivePos(f.paperPosition);
  renderFaderWatchlist(f.heartbeat?.watchlist);
  renderFaderConfig(f.config);
  renderFaderHistory(f.paperTrades, f.paperStats);
  renderFaderHeartbeatRaw(f.heartbeat);
}

function renderFaderActivePos(pos) {
  const section = document.getElementById("fader-active-section");
  const body = document.getElementById("fader-active-body");
  if (!section || !body) return;
  if (!pos) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const fmtPx = (v) => (v == null ? "—" : `$${v.toFixed(6)}`);
  const pnlCls =
    (pos.unrealUsd ?? 0) >= 0 ? "cb-pos-pnl positive" : "cb-pos-pnl negative";
  const heldStr =
    pos.heldMin >= 60
      ? `${Math.floor(pos.heldMin / 60)}h ${pos.heldMin % 60}m`
      : `${pos.heldMin}m`;

  body.innerHTML = `
    <div class="cb-kv">
      <div class="k">Coin / side</div>     <div class="v"><b>${pos.coin}</b> · ${pos.side}</div>
      <div class="k">Notional</div>        <div class="v">$${pos.sizeUsd.toFixed(2)}</div>
      <div class="k">Entry / current</div> <div class="v">${fmtPx(pos.entryPrice)} → ${fmtPx(pos.currentPrice)}</div>
      <div class="k">Unrealized</div>      <div class="v"><span class="${pnlCls}">${fmtUsd(pos.unrealUsd)} (${fmtPct(pos.unrealPct)})</span></div>
      <div class="k">MFE / MAE</div>       <div class="v">
        <span style="color:var(--green)">${fmtUsd(pos.mfeUsd)} (${fmtPct(pos.mfePct)})</span> /
        <span style="color:var(--red)">${fmtUsd(pos.maeUsd)} (${fmtPct(pos.maePct)})</span>
      </div>
      <div class="k">Held</div>            <div class="v">${heldStr}</div>
      <div class="k">TP</div>              <div class="v">${fmtPx(pos.tpPrice)} ${pos.tpDistPct != null ? `(${pos.tpDistPct.toFixed(2)}% away)` : ""}</div>
      <div class="k">Impulse@entry</div>   <div class="v">${fmtPct(pos.entry_spike_pct)}</div>
    </div>
  `;
}

function renderFaderWatchlist(items) {
  const body = document.getElementById("fader-watchlist-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<div class="empty-state">no green setups</div>';
    return;
  }
  const rows = items
    .map(
      (w) => `<tr>
    <td><b>${w.coin}</b></td>
    <td>chop ${(w.chopRatio ?? 0).toFixed(2)}</td>
  </tr>`,
    )
    .join("");
  body.innerHTML = `<table class="cb-table"><thead><tr><th>Coin</th><th>chopRatio</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFaderConfig(cfg) {
  const body = document.getElementById("fader-config-body");
  if (!body) return;
  if (!cfg) {
    body.textContent = "—";
    return;
  }
  body.innerHTML =
    `nominal $${cfg.nominalUsd} × ${cfg.leverage}x · ` +
    `spike ≥ ${cfg.spikePctMin}% · chop > ${cfg.chopRatioMin} · ` +
    `TP = impulse × ${cfg.tpReclaimFrac} · ` +
    `adverse-kill ${Math.round(cfg.adverseKillPct * 100)}% · ` +
    `time-stop ${cfg.timeStopHours}h`;
}

function renderFaderHistory(trades, stats) {
  const body = document.getElementById("fader-history-body");
  const inline = document.getElementById("fader-stats-inline");
  if (!body) return;

  if (inline && stats && stats.n > 0) {
    const fmt = (v) =>
      v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    inline.textContent = `n=${stats.n} · net ${fmt(stats.sumNet)} · avg ${fmt(stats.avgNet)} · win ${(stats.winRate * 100).toFixed(0)}% · best ${fmt(stats.bestNet)} · worst ${fmt(stats.worstNet)}`;
  } else if (inline) {
    inline.textContent = "";
  }

  if (!Array.isArray(trades) || trades.length === 0) {
    body.innerHTML = '<div class="empty-state">no closed trades yet</div>';
    return;
  }
  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
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
  const rows = trades
    .map((t) => {
      const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
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
    })
    .join("");
  body.innerHTML = `
    <table class="cb-table">
      <thead><tr><th>Open / Close</th><th>Coin</th><th>Entry / Exit</th><th>Net</th><th>MFE / MAE</th><th>Held</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderFaderHeartbeatRaw(hb) {
  const el = document.getElementById("fader-heartbeat");
  if (!el) return;
  if (!hb) {
    el.textContent = "warming up…";
    return;
  }
  const ageSec = Math.floor((Date.now() - hb.ts) / 1000);
  const age =
    ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  el.textContent =
    `tracked ${hb.tracked} · GREEN ${hb.green} · YELLOW ${hb.yellow} · RED ${hb.red} · ` +
    `slot ${hb.slot} · cooldowns ${hb.cooldowns} · recentLosses ${hb.recentLosses} · ${age}`;
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

// ── Smart Signals ──────────────────────────────────────────────────────────
async function fetchMacroIfStale() {
  if (Date.now() - _macroFetchedAt < 5 * 60_000) return;
  try {
    const candles = await fetchJson("/api/candles?coin=BTC&interval=4h");
    if (Array.isArray(candles) && candles.length >= 2) {
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const c = Number(last.c ?? last.close);
      const o = Number(prev.c ?? prev.close ?? prev.o);
      if (o && c) _macroPct = ((c - o) / o) * 100;
    }
    _macroFetchedAt = Date.now();
  } catch (_) {}
}

function _smartScoreSetup(r) {
  let s = 0;
  const fp = r.fundingPersist;
  if (
    fp?.fractionExtreme != null &&
    fp.fractionExtreme > 0.4 &&
    Math.abs(r.fundingApy || 0) > 50
  )
    s++;
  const oi = r.oi7d;
  if (
    oi?.deltaOi != null &&
    oi?.deltaPx != null &&
    oi.deltaOi > 0.5 &&
    Math.abs(oi.deltaPx) < 0.07
  )
    s++;
  if (r.premium != null && Math.abs(r.premium) > 0.001) s++;
  const vr = r.volRegime;
  if (vr?.ratio != null && vr.ratio > 1.5) s++;
  return s;
}

function _smartFmtPx(v) {
  if (v == null || !isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n >= 10000) return `$${n.toFixed(0)}`;
  if (n >= 100) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(6)}`;
}

function renderSmartSignals() {
  const tbody = document.getElementById("smart-tbody");
  const macroEl = document.getElementById("smart-macro");
  if (!tbody) return;

  const macroDir =
    _macroPct == null
      ? "neutral"
      : _macroPct > 0.5
        ? "bull"
        : _macroPct < -0.5
          ? "bear"
          : "neutral";

  if (macroEl) {
    const macroLabel =
      _macroPct == null
        ? ""
        : `BTC 4h ${_macroPct > 0 ? "+" : ""}${_macroPct.toFixed(1)}% · ${macroDir === "bull" ? "▲ BULL" : macroDir === "bear" ? "▼ BEAR" : "● FLAT"}`;
    macroEl.dataset.macro = macroLabel;
    macroEl.style.color =
      macroDir === "bull"
        ? "var(--green)"
        : macroDir === "bear"
          ? "var(--red)"
          : "var(--text-muted)";
  }

  const TIER_SCORE = { STRONG: 3, NORMAL: 2, WEAK: 1 };
  const setupMap = new Map(
    (_lastSetupRowsCache || []).map((r) => [r.coin, _smartScoreSetup(r)]),
  );

  // BTC 1m momentum penalty: если BTC активно движется против направления сигнала
  const btcPressurePenalty = (dir) => {
    if (_btcMomentum1m == null) return 0;
    if (dir === "SHORT" && _btcMomentum1m > 0.3) return -4; // BTC памп → SHORT конфликт
    if (dir === "LONG" && _btcMomentum1m < -0.3) return -4; // BTC дамп → LONG конфликт
    return 0;
  };

  function macroBonus(dir) {
    if (macroDir === "neutral") return 0;
    if (dir === "LONG" && macroDir === "bull") return 2;
    if (dir === "SHORT" && macroDir === "bear") return 2;
    return -3; // conflict
  }
  function isConflict(dir) {
    const macroCon =
      (dir === "LONG" && macroDir === "bear") ||
      (dir === "SHORT" && macroDir === "bull");
    const momentumCon =
      _btcMomentum1m != null &&
      ((dir === "SHORT" && _btcMomentum1m > 0.5) ||
        (dir === "LONG" && _btcMomentum1m < -0.5));
    return macroCon || momentumCon;
  }

  const items = [];

  // CG signals — structured (entry/sl/tp/trend4h уже есть)
  for (const s of _cgSignalsCache) {
    const entry = Number(s.entry);
    const sl = Number(s.sl);
    const tp = Number(s.tp);
    const risk = Math.abs(sl - entry);
    const rr = risk > 0 ? (Math.abs(tp - entry) / risk).toFixed(1) : "2.0";
    const trendBonus =
      s.trend4h == null
        ? 0
        : s.direction === "LONG" && s.trend4h === "up"
          ? 2
          : s.direction === "SHORT" && s.trend4h === "down"
            ? 2
            : -1;
    const setupBonus = (setupMap.get(s.coin) || 0) * 2;
    const score =
      40 +
      Number(rr) * 3 +
      trendBonus +
      macroBonus(s.direction) +
      setupBonus +
      btcPressurePenalty(s.direction);
    items.push({
      coin: s.coin,
      direction: s.direction,
      entry,
      sl,
      tp,
      rr,
      trend4h: s.trend4h,
      score,
      why: [
        "CG",
        ...(setupMap.get(s.coin) >= 2 ? [`HL${setupMap.get(s.coin)}`] : []),
      ],
      conflict: isConflict(s.direction),
    });
  }

  // HM signals — рассчитываем entry/sl/tp из текущей цены
  for (const m of _hmSignalsCache) {
    if (!m.best?.tier || m.best.tier === "NEUTRAL") continue;
    const direction = m.best.side === "SHORT" ? "SHORT" : "LONG";
    const tierS = TIER_SCORE[m.best.tier] || 0;
    const setupBonus = (setupMap.get(m.coin) || 0) * 2;
    const existing = items.find((i) => i.coin === m.coin);
    if (existing) {
      existing.score += tierS * 3;
      if (!existing.why.includes("spike")) existing.why.push("spike");
    } else {
      const SL = 0.025;
      const entry = Number(m.price);
      const sl = direction === "SHORT" ? entry * (1 + SL) : entry * (1 - SL);
      const tp =
        direction === "SHORT" ? entry * (1 - SL * 2) : entry * (1 + SL * 2);
      const score =
        tierS * 3 +
        macroBonus(direction) +
        setupBonus +
        btcPressurePenalty(direction);
      items.push({
        coin: m.coin,
        direction,
        entry,
        sl,
        tp,
        rr: "2.0",
        trend4h: null,
        score,
        why: [
          "spike",
          ...(setupMap.get(m.coin) >= 2 ? [`HL${setupMap.get(m.coin)}`] : []),
        ],
        conflict: isConflict(direction),
      });
    }
  }

  // Setup-only — все монеты с mark price, без порога по score (watchlist fallback)
  for (const r of _lastSetupRowsCache) {
    if (items.find((i) => i.coin === r.coin)) continue;
    const ss = _smartScoreSetup(r);
    const direction = (r.fundingApy || 0) < 0 ? "LONG" : "SHORT";
    const entry = Number(r.mark || 0);
    if (!entry) continue;
    const SL = 0.025;
    const sl = direction === "SHORT" ? entry * (1 + SL) : entry * (1 - SL);
    const tp =
      direction === "SHORT" ? entry * (1 - SL * 2) : entry * (1 + SL * 2);
    // proxy score: |fundingApy| + funding persist fraction + OI delta
    const fp = r.fundingPersist;
    const oi = r.oi7d;
    let proxy = Math.min(Math.abs(r.fundingApy || 0) / 10, 5); // 0-5
    if (fp?.fractionExtreme != null) proxy += fp.fractionExtreme * 3;
    if (oi?.deltaOi != null) proxy += Math.abs(oi.deltaOi) * 2;
    if (r.premium != null) proxy += Math.abs(r.premium) * 200;
    const score = ss * 4 + proxy + macroBonus(direction);
    const why =
      ss > 0
        ? [`HL${ss}`, ...(Math.abs(r.fundingApy || 0) > 100 ? ["fund"] : [])]
        : Math.abs(r.fundingApy || 0) > 50
          ? ["fund"]
          : ["watch"];
    items.push({
      coin: r.coin,
      direction,
      entry,
      sl,
      tp,
      rr: "2.0",
      trend4h: null,
      score,
      why,
      conflict: isConflict(direction),
    });
  }

  items.sort((a, b) => b.score - a.score);
  const top10 = items.slice(0, 10);

  // Статус данных для мета-строки
  const collectorAgeH = _lastSetupRowsCache.reduce((mx, r) => {
    const age = r.fundingPersist?.ageHours ?? 0;
    return age > mx ? age : mx;
  }, 0);
  const dataReady = collectorAgeH >= 48;
  const dataLabel =
    collectorAgeH < 1
      ? "collecting…"
      : collectorAgeH < 24
        ? `warming up · ${collectorAgeH.toFixed(0)}h / 48h`
        : collectorAgeH < 48
          ? `almost ready · ${collectorAgeH.toFixed(0)}h / 48h`
          : collectorAgeH < 168
            ? `${collectorAgeH.toFixed(0)}h data · OI pending`
            : `${(collectorAgeH / 24).toFixed(0)}d data · full`;

  if (macroEl) {
    const parts = [
      macroEl.dataset.macro,
      `${_lastSetupRowsCache.length} coins · ${dataLabel}`,
    ].filter(Boolean);
    macroEl.textContent = parts.join(" · ");
  }

  if (!top10.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${dataLabel}</td></tr>`;
    return;
  }

  const TD =
    "padding:8px 10px;border-bottom:1px solid var(--hairline);vertical-align:middle;";
  const TDR = TD + "text-align:right;";
  const TDC = TD + "text-align:center;";

  tbody.innerHTML = top10
    .map((item, idx) => {
      const isLong = item.direction === "LONG";
      const dirHtml = isLong
        ? '<span style="color:var(--green);font-weight:700;font-family:var(--font-mono);font-size:12px">▲ LONG</span>'
        : '<span style="color:var(--red);font-weight:700;font-family:var(--font-mono);font-size:12px">▼ SHORT</span>';
      const trend4hHtml =
        item.trend4h == null
          ? '<span style="opacity:.35;font-family:var(--font-mono)">—</span>'
          : item.trend4h === "up"
            ? '<span style="color:var(--green);font-family:var(--font-mono)">▲</span>'
            : '<span style="color:var(--red);font-family:var(--font-mono)">▼</span>';
      // Один главный тег + опциональный score
      const LABEL_MAP = {
        CG: {
          text: "entry ready",
          style:
            "background:var(--accent-soft);color:var(--accent-strong);border:1px solid var(--accent-line)",
        },
        spike: {
          text: "spike",
          style:
            "background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn)",
        },
        fund: {
          text: "funding",
          style:
            "background:var(--canvas-inset);color:var(--text-secondary);border:1px solid var(--border-muted)",
        },
        watch: {
          text: "watch",
          style:
            "background:none;color:var(--text-faint);border:1px solid var(--hairline)",
        },
        conflict: {
          text: "conflict",
          style:
            "background:none;color:var(--text-faint);border:1px solid var(--hairline)",
        },
      };
      const PRIORITY = ["CG", "spike", "fund"];
      const primary = item.conflict
        ? "conflict"
        : (PRIORITY.find((k) => item.why.includes(k)) ?? "watch");
      const lbl = LABEL_MAP[primary];
      const hlTag = item.why.find((w) => /^HL\d$/.test(w));
      const scoreHtml = hlTag
        ? `<span style="font-size:11px;padding:2px 6px;border-radius:3px;font-weight:600;background:var(--canvas-inset);color:var(--text-secondary);border:1px solid var(--border-muted)">${hlTag.replace("HL", "")} / 4</span>`
        : "";
      const whyHtml = `<span style="font-size:11px;padding:2px 6px;border-radius:3px;font-weight:600;${lbl.style}">${lbl.text}</span> ${scoreHtml}`;
      // Timing: ищем монету в HM — dump для LONG = момент входа, pump для SHORT
      const hm = _hmSignalsCache.find(
        (m) => m.coin === item.coin && m.best?.spikePct != null,
      );
      let timingHtml = `<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">—</span>`;
      if (hm) {
        const spike = hm.best.spikePct;
        const goodForLong = isLong && spike < -1.5; // монета упала → хороший вход для лонга
        const goodForShort = !isLong && spike > 1.5; // монета пампит → хороший вход для шорта
        if (goodForLong) {
          timingHtml = `<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#fff;background:var(--green);padding:2px 8px;border-radius:4px;white-space:nowrap">long now</span>`;
        } else if (goodForShort) {
          timingHtml = `<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#fff;background:var(--red);padding:2px 8px;border-radius:4px;white-space:nowrap">short now</span>`;
        }
      }

      const rowOpacity = item.conflict ? "opacity:.45;" : "";
      const conflictIcon = item.conflict
        ? ' <span style="color:var(--red);font-size:10px" title="Macro conflict">⚠</span>'
        : "";
      const topGlow =
        idx === 0 && !item.conflict
          ? isLong
            ? "background:var(--green-soft);"
            : "background:var(--red-soft);"
          : "";
      return `<tr style="${rowOpacity}${topGlow}">
      <td style="${TD}font-family:var(--font-mono);color:var(--text-faint);font-size:11px">${idx + 1}</td>
      <td style="${TD}font-weight:700;font-size:14px">#${item.coin}${conflictIcon}</td>
      <td style="${TD}">${dirHtml}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px">${_smartFmtPx(item.entry)}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px;color:var(--red)">${_smartFmtPx(item.sl)}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px;color:var(--green)">${_smartFmtPx(item.tp)}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px">${item.rr}</td>
      <td style="${TDC}">${trend4hHtml}</td>
      <td style="${TD}display:flex;gap:3px;flex-wrap:wrap">${whyHtml}</td>
      <td style="${TDC}">${timingHtml}</td>
    </tr>`;
    })
    .join("");
}

let _divData = null;
let _divWindow = "15m";
const DIV_DEFAULT_WATCHLIST = [
  "BTC",
  "HYPE",
  "ZEC",
  "WLD",
  "NEAR",
  "LIT",
  "ASTER",
];

function divGetWatchlist() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("hl-div-watchlist") || "null",
    );
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DIV_DEFAULT_WATCHLIST];
}

function divSaveWatchlist(list) {
  localStorage.setItem("hl-div-watchlist", JSON.stringify(list));
}

function divRenderWatchlistBar() {
  const bar = document.getElementById("div-watchlist-bar");
  if (!bar || _divWindow === "all") {
    if (bar) bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  const list = divGetWatchlist();
  const defaults = new Set(DIV_DEFAULT_WATCHLIST);
  bar.innerHTML =
    list
      .map((coin) => {
        const removable = !defaults.has(coin);
        return `<span style="display:inline-flex;align-items:center;gap:3px;background:var(--surface-2,rgba(255,255,255,.06));border:1px solid var(--hairline);border-radius:4px;padding:2px 6px;font-family:var(--font-mono);font-size:10px;">
      ${coin}${removable ? `<button data-remove="${coin}" style="background:none;border:none;cursor:pointer;color:var(--text-faint);padding:0;line-height:1;font-size:11px;" title="Убрать">×</button>` : ""}
    </span>`;
      })
      .join("") +
    `<span style="display:inline-flex;align-items:center;gap:3px;">
    <input id="div-add-input" placeholder="+ COIN" style="width:60px;background:transparent;border:1px dashed var(--hairline);border-radius:4px;padding:2px 5px;font-family:var(--font-mono);font-size:10px;color:inherit;outline:none;" maxlength="10" autocomplete="off" spellcheck="false"/>
  </span>`;

  bar.querySelector("#div-add-input")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const val = e.target.value.trim().toUpperCase();
    if (!val) return;
    const l = divGetWatchlist();
    if (!l.includes(val)) {
      l.push(val);
      divSaveWatchlist(l);
    }
    e.target.value = "";
    divRenderWatchlistBar();
    divRefresh();
  });

  bar.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const l = divGetWatchlist().filter((c) => c !== btn.dataset.remove);
      divSaveWatchlist(l);
      divRenderWatchlistBar();
      divRefresh();
    });
  });
}

function divSignalInfo(c, btcPct, hasPast) {
  const rel = c.relPct;
  const isBtc = c.coin === "BTC";
  const relColor =
    !hasPast || rel == null
      ? "var(--text-muted)"
      : rel <= -1.5
        ? "var(--red)"
        : rel >= 1.5
          ? "var(--green)"
          : "var(--text-muted)";
  const coinColor =
    !hasPast || c.coinPct == null
      ? "var(--text-muted)"
      : c.coinPct > 0
        ? "var(--green)"
        : c.coinPct < 0
          ? "var(--red)"
          : "var(--text-muted)";
  let signal = "—";
  if (hasPast && rel != null && btcPct != null && !isBtc) {
    if (btcPct > 0.3 && rel <= -1.5) signal = "SHORT";
    else if (btcPct < -0.3 && rel >= 1.5) signal = "LONG";
  }
  const signalColor =
    signal === "SHORT"
      ? "var(--red)"
      : signal === "LONG"
        ? "var(--green)"
        : "var(--text-faint)";
  return { relColor, coinColor, signal, signalColor, isBtc };
}

function divRenderRows(coins, btcPct, hasPast) {
  const fmtPct = (v) =>
    v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
  return coins
    .map((c) => {
      const { relColor, coinColor, signal, signalColor, isBtc } = divSignalInfo(
        c,
        btcPct,
        hasPast,
      );
      const rel = c.relPct;
      const whaleEntries = _wwPositionsMap.get(c.coin.toUpperCase());
      let whaleCell = "";
      if (whaleEntries?.length) {
        const shortSum = whaleEntries
          .filter((w) => w.side === "SHORT")
          .reduce((s, w) => s + w.sizeUsd, 0);
        const longSum = whaleEntries
          .filter((w) => w.side === "LONG")
          .reduce((s, w) => s + w.sizeUsd, 0);
        const parts = [];
        if (shortSum > 0)
          parts.push(
            `<span style="color:var(--red);font-weight:700">↓${fmtNotional(shortSum)}</span>`,
          );
        if (longSum > 0)
          parts.push(
            `<span style="color:var(--green);font-weight:700">↑${fmtNotional(longSum)}</span>`,
          );
        whaleCell = parts.join(" ");
      }
      return `<tr class="${isActiveCoin(c.coin) ? "is-active" : ""}">
      <td style="font-weight:600">${c.coin}</td>
      <td class="r">${fmtPrice(c.price)}</td>
      <td class="r" style="color:${coinColor}">${hasPast ? fmtPct(c.coinPct) : "—"}</td>
      <td class="r" style="color:${relColor};font-weight:${Math.abs(rel ?? 0) >= 1.5 ? 600 : 400}">${hasPast && !isBtc ? fmtPct(rel) : isBtc ? "baseline" : "—"}</td>
      <td class="c" style="color:${signalColor};font-weight:700">${signal}</td>
      <td class="r">${whaleCell}</td>
    </tr>`;
    })
    .join("");
}

let _divAllFetching = false;

async function divFetchAll() {
  if (_divAllFetching) return;
  _divAllFetching = true;
  const win = _divWindow === "all" ? "15m" : _divWindow;
  const tbody = document.getElementById("div-tbody");
  const hasContent =
    tbody && tbody.children.length > 0 && !tbody.querySelector(".empty-state");
  if (!hasContent && tbody)
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">загружаем все монеты…</td></tr>`;
  try {
    const d = await fetchJson(`/api/btc-divergence/all?window=${win}`);
    if (!d?.coins) return;
    const metaEl = document.getElementById("div-meta");
    const thChange = document.getElementById("div-th-change");
    if (thChange) thChange.textContent = `${win} %`;
    if (metaEl) {
      const label =
        d.btcPct != null
          ? `BTC ${win} ${d.btcPct > 0 ? "+" : ""}${d.btcPct.toFixed(2)}% · ${d.coins.length} монет`
          : `${d.coins.length} монет · накапливаем историю…`;
      metaEl.textContent = label;
      metaEl.style.color =
        d.btcPct == null
          ? "var(--text-muted)"
          : d.btcPct > 0.3
            ? "var(--green)"
            : d.btcPct < -0.3
              ? "var(--red)"
              : "var(--text-muted)";
    }
    if (d.coins.length === 0) {
      if (tbody)
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">накапливаем историю…</td></tr>`;
      return;
    }
    if (tbody) tbody.innerHTML = divRenderRows(d.coins, d.btcPct, d.hasPast);
  } catch {
    /* silent */
  } finally {
    _divAllFetching = false;
  }
}

// Тянем дивергенцию по ТЕКУЩЕМУ вотчлисту (включая монеты, добавленные оператором).
// WS-пуш шлёт только дефолтный список, поэтому источник истины для табов
// 5m/15m/1h — этот fetch. BTC всегда нужен как baseline.
async function divRefresh() {
  if (_divWindow === "all") {
    renderBtcDivergence(null);
    return;
  }
  const wl = divGetWatchlist();
  const coins = wl.includes("BTC") ? wl : ["BTC", ...wl];
  try {
    const d = await fetchJson(
      `/api/btc-divergence?coins=${encodeURIComponent(coins.join(","))}`,
    );
    if (d?.windows) renderBtcDivergence(d);
  } catch {
    /* silent */
  }
}

function renderBtcDivergence(data) {
  if (data) _divData = data;

  divRenderWatchlistBar();

  if (_divWindow === "all") {
    divFetchAll();
    return;
  }

  if (!_divData) return;
  const tbody = document.getElementById("div-tbody");
  const metaEl = document.getElementById("div-meta");
  const thChange = document.getElementById("div-th-change");
  if (!tbody) return;

  const watchlist = divGetWatchlist();
  const windowData = _divData.windows?.[_divWindow];
  if (!windowData?.coins?.length) {
    const mins = _divWindow === "1h" ? 60 : parseInt(_divWindow);
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">накапливаем историю (нужно ${mins} мин)…</td></tr>`;
    return;
  }

  if (thChange) thChange.textContent = `${_divWindow} %`;
  const { coins: allCoins, btcPct, hasPast } = windowData;
  const { updatedAt } = _divData;

  // Фильтруем по вотчлисту, добавляем монеты которые пользователь добавил
  const watchSet = new Set(watchlist);
  const coins = allCoins.filter((c) => watchSet.has(c.coin));

  if (metaEl) {
    const age = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null;
    const btcLabel =
      btcPct != null
        ? `BTC ${_divWindow} ${btcPct > 0 ? "+" : ""}${btcPct.toFixed(2)}%`
        : "BTC —";
    metaEl.textContent = age != null ? `${btcLabel} · ${age}s ago` : btcLabel;
    metaEl.style.color =
      btcPct == null
        ? "var(--text-muted)"
        : btcPct > 0.3
          ? "var(--green)"
          : btcPct < -0.3
            ? "var(--red)"
            : "var(--text-muted)";
  }

  tbody.innerHTML = divRenderRows(coins, btcPct, hasPast);
}

document.getElementById("div-tabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-window]");
  if (!btn) return;
  _divWindow = btn.dataset.window;
  document
    .querySelectorAll("#div-tabs .range-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  divRefresh();
});

bindLogsUi();
fetchInitialLogs();

applyTheme(getStoredTheme());
initEquityChart();
initWebSocket();
tick();
divRefresh(); // первичная загрузка дивергенции (до первого WS-пуша)
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1000);

// ── Whale Watch ──────────────────────────────────

let _wwSort = { key: "sizeUsd", desc: true };

const WW_STORAGE_KEY = "ww-addresses-v2";
const WW_DEFAULTS = [
  { label: "Василий", address: "0x3ed4033676d0bdb3938728ca4ac673d00e74bd06" },
];

// Map<COIN, [{label, side, sizeUsd}]> — shared with divRenderRows for BTC Div integration
let _wwPositionsMap = new Map();

// Map<"address:coin", delta> — cleared on next poll if no new delta
let _wwDeltaMap = new Map();

// True after first successful render — prevents error from overwriting real data on poll failure
let _wwHasData = false;

function wwGetList() {
  try {
    const raw = localStorage.getItem(WW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    /* ignore */
  }
  return WW_DEFAULTS;
}

function wwSaveList(list) {
  localStorage.setItem(WW_STORAGE_KEY, JSON.stringify(list));
}

function fmtNotional(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtSince(ts) {
  if (!ts) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h >= 1) return `${h}h${m}m`;
  return `${m}m`;
}

function fmtPnlColored(v) {
  if (v == null || !Number.isFinite(v)) return `<span>—</span>`;
  const color = v >= 0 ? "var(--green)" : "var(--red)";
  const sign = v >= 0 ? "+" : "";
  return `<span style="color:${color}">${sign}${fmtNotional(v)}</span>`;
}

function wwRenderChips() {
  const chips = document.getElementById("ww-chips");
  if (!chips) return;
  const list = wwGetList();
  chips.innerHTML = list
    .map((w, i) => {
      const short = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
      const labelDiffersFromShort = w.label !== short;
      return `<span style="display:inline-flex;align-items:center;gap:3px;background:var(--bg-header);border:1px solid var(--hairline);border-radius:4px;padding:2px 7px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)" title="${escapeHtml(w.address)}">
      ${escapeHtml(w.label)}${labelDiffersFromShort ? ` <span style="opacity:.5;font-size:9px">${short}</span>` : ""}
      <button data-ww-remove="${i}" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:11px;padding:0 0 0 3px;line-height:1" title="Удалить">×</button>
    </span>`;
    })
    .join("");
  chips.querySelectorAll("[data-ww-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.wwRemove, 10);
      const list = wwGetList();
      list.splice(idx, 1);
      wwSaveList(list);
      wwRenderChips();
      fetchWhaleWatch();
    });
  });
}

let _wwLastResults = null;

function renderWhaleWatch(results) {
  _wwLastResults = results;
  _wwHasData = true;
  const tbody = document.getElementById("ww-tbody");
  const biasEl = document.getElementById("ww-bias");
  const footerEl = document.getElementById("ww-footer");
  if (!tbody) return;

  // Rebuild positions map for BTC Divergence integration
  _wwPositionsMap = new Map();
  let totalNotional = 0;
  let totalShortNotional = 0;
  let totalPnl = 0;
  const allRows = [];
  let fetchedAt = null;

  // Build a new delta map for this render cycle
  const newDeltaMap = new Map();

  for (const { label, address, data } of results) {
    if (!data || data.error) continue;
    fetchedAt = Math.max(fetchedAt ?? 0, data.ts ?? 0);
    // Index deltas by "address:coin"
    for (const d of data.delta ?? []) {
      newDeltaMap.set(`${address}:${d.coin}`, d);
    }
    for (const p of data.positions ?? []) {
      const key = p.coin.toUpperCase();
      if (!_wwPositionsMap.has(key)) _wwPositionsMap.set(key, []);
      _wwPositionsMap
        .get(key)
        .push({ label, side: p.side, sizeUsd: p.sizeUsd });
      totalNotional += p.sizeUsd;
      totalPnl += p.unrealizedPnl;
      if (p.side === "SHORT") totalShortNotional += p.sizeUsd;
      allRows.push({ label, address, ...p });
    }
    // Also add "closed" rows from delta (still show for 1 cycle)
    for (const d of data.delta ?? []) {
      if (d.type === "closed") {
        // Only add if not already in positions
        if (!allRows.some((r) => r.address === address && r.coin === d.coin)) {
          allRows.push({
            label,
            address,
            coin: d.coin,
            side: d.side,
            sizeUsd: d.prevSizeUsd ?? 0,
            unrealizedPnl: 0,
            leverage: null,
            entryPrice: 0,
            _closed: true,
          });
        }
      }
    }
  }

  // Merge old deltas for coins still visible, replace with new ones
  _wwDeltaMap = newDeltaMap;

  if (allRows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty-state">нет открытых perp позиций</td></tr>';
    if (biasEl) biasEl.textContent = "";
    if (footerEl) footerEl.textContent = "";
    // Re-render BTC Div to clear whale column
    renderBtcDivergence(null);
    return;
  }

  // Apply current sort — closed rows always go to the bottom
  allRows.sort((a, b) => {
    if (a._closed !== b._closed) return a._closed ? 1 : -1;
    const { key, desc } = _wwSort;
    const va = a[key] ?? (typeof a[key] === "string" ? "" : -Infinity);
    const vb = b[key] ?? (typeof b[key] === "string" ? "" : -Infinity);
    if (typeof va === "string")
      return desc ? vb.localeCompare(va) : va.localeCompare(vb);
    return desc ? vb - va : va - vb;
  });

  // Sync header indicators
  document.querySelectorAll("#ww-table th[data-ww-sort]").forEach((th) => {
    const active = th.dataset.wwSort === _wwSort.key;
    th.classList.toggle("ww-sort-active", active);
    th.classList.toggle("ww-sort-asc", active && !_wwSort.desc);
    th.classList.toggle("ww-sort-desc", active && _wwSort.desc);
  });

  tbody.innerHTML = allRows
    .map((p) => {
      const sideColor = p.side === "SHORT" ? "var(--red)" : "var(--green)";
      const levStr = p.leverage != null ? `${p.leverage}×` : "—";
      const entryStr =
        p.entryPrice >= 1000
          ? p.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })
          : p.entryPrice >= 1
            ? p.entryPrice.toFixed(2)
            : p.entryPrice > 0
              ? p.entryPrice.toFixed(5)
              : "—";

      // Delta badge
      const deltaKey = `${p.address}:${p.coin}`;
      const d = _wwDeltaMap.get(deltaKey);
      let deltaBadge = "";
      if (d) {
        if (d.type === "opened") {
          deltaBadge = `<span style="margin-left:4px;background:var(--green);color:#000;font-size:9px;font-weight:700;border-radius:3px;padding:1px 4px;vertical-align:middle">NEW</span>`;
        } else if (d.type === "closed" || p._closed) {
          deltaBadge = `<span style="margin-left:4px;background:var(--red);color:#fff;font-size:9px;font-weight:700;border-radius:3px;padding:1px 4px;vertical-align:middle">CLOSED</span>`;
        } else if (d.type === "size_up") {
          const diff = (d.sizeUsd ?? 0) - (d.prevSizeUsd ?? 0);
          deltaBadge = `<span style="margin-left:4px;color:var(--green);font-size:9px;font-weight:700;vertical-align:middle">+${fmtNotional(diff)}</span>`;
        } else if (d.type === "size_down") {
          const diff = (d.sizeUsd ?? 0) - (d.prevSizeUsd ?? 0);
          deltaBadge = `<span style="margin-left:4px;color:var(--red);font-size:9px;font-weight:700;vertical-align:middle">${fmtNotional(diff)}</span>`;
        }
      } else if (p._closed) {
        deltaBadge = `<span style="margin-left:4px;background:var(--red);color:#fff;font-size:9px;font-weight:700;border-radius:3px;padding:1px 4px;vertical-align:middle">CLOSED</span>`;
      }

      const sinceStr = p._closed ? "—" : fmtSince(p.firstSeenAt);
      const rowOpacity = p._closed ? "opacity:.5;" : "";
      return `<tr style="${rowOpacity}">
      <td style="color:var(--text-muted);font-size:12px">${escapeHtml(p.label)}</td>
      <td style="font-weight:700">${escapeHtml(p.coin)}</td>
      <td class="r" style="color:${sideColor};font-weight:700">${p.side}</td>
      <td class="r">${fmtNotional(p.sizeUsd)}${deltaBadge}</td>
      <td class="r" style="color:var(--text-muted)">${levStr}</td>
      <td class="r">${fmtPnlColored(p.unrealizedPnl)}</td>
      <td class="r" style="color:var(--text-muted)">${escapeHtml(entryStr)}</td>
      <td class="r" style="color:var(--text-faint);font-size:11px">${sinceStr}</td>
    </tr>`;
    })
    .join("");

  if (biasEl) {
    const shortPct =
      totalNotional > 0 ? (totalShortNotional / totalNotional) * 100 : 0;
    const longPct = 100 - shortPct;
    const col =
      shortPct > 60
        ? "var(--red)"
        : longPct > 60
          ? "var(--green)"
          : "var(--text-muted)";
    biasEl.style.color = col;
    const pnlSign = totalPnl >= 0 ? "+" : "";
    biasEl.textContent = `SHORT ${shortPct.toFixed(0)}% · LONG ${longPct.toFixed(0)}% · ${fmtNotional(totalNotional)} · uPnL ${pnlSign}${fmtNotional(totalPnl)}`;
  }

  if (footerEl) {
    const age = fetchedAt ? Math.round((Date.now() - fetchedAt) / 1000) : null;
    footerEl.textContent = `${results.length} address${results.length > 1 ? "es" : ""}${age != null ? ` · ${age}s ago` : ""}`;
  }

  // Re-render BTC Div with updated whale data
  renderBtcDivergence(null);
}

async function fetchWhaleWatch() {
  const list = wwGetList();
  wwRenderChips();
  if (list.length === 0) {
    renderWhaleWatch([]);
    return;
  }

  // Single batch request — sequential on the server, doesn't block hlInfo semaphore
  const addrs = list.map((w) => w.address).join(",");
  try {
    const batch = await fetchJson(
      `/api/whale-watch/batch?addresses=${encodeURIComponent(addrs)}`,
    );
    const byAddr = new Map(
      (batch.results ?? []).map((r) => [r.address, r.data]),
    );
    const mapped = list.map((w) => ({
      label: w.label,
      address: w.address,
      data: byAddr.get(w.address) ?? null,
    }));
    if (mapped.every((m) => !m.data)) {
      if (!_wwHasData) {
        const tbody = document.getElementById("ww-tbody");
        if (tbody)
          tbody.innerHTML =
            '<tr><td colspan="8" class="empty-state" style="color:var(--red)">ошибка загрузки — HL API недоступен</td></tr>';
      }
      return;
    }
    renderWhaleWatch(mapped);
  } catch (err) {
    if (!_wwHasData) {
      const tbody = document.getElementById("ww-tbody");
      if (tbody)
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:var(--red)">ошибка: ${err?.message ?? "неизвестно"}</td></tr>`;
    }
  }
}

// Add address form UI
(function initWhaleWatchUi() {
  const addBtn = document.getElementById("ww-add-btn");
  const form = document.getElementById("ww-form");
  const labelInput = document.getElementById("ww-form-label");
  const addrInput = document.getElementById("ww-form-addr");
  const saveBtn = document.getElementById("ww-form-save");
  const cancelBtn = document.getElementById("ww-form-cancel");
  if (!addBtn || !form) return;

  addBtn.addEventListener("click", () => {
    form.style.display = "flex";
    labelInput.value = "";
    addrInput.value = "";
    labelInput.focus();
  });

  cancelBtn?.addEventListener("click", () => {
    form.style.display = "none";
  });

  saveBtn?.addEventListener("click", () => {
    const addr = addrInput.value.trim().toLowerCase();
    const label =
      labelInput.value.trim() || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      addrInput.style.borderColor = "var(--red)";
      setTimeout(() => {
        addrInput.style.borderColor = "";
      }, 1500);
      return;
    }
    const list = wwGetList();
    if (!list.some((w) => w.address === addr)) {
      list.push({ label, address: addr });
      wwSaveList(list);
    }
    form.style.display = "none";
    fetchWhaleWatch();
  });
})();

fetchWhaleWatch();
setInterval(fetchWhaleWatch, 30_000);

// Sortable column headers — re-sort without a new fetch
document.getElementById("ww-table")?.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-ww-sort]");
  if (!th) return;
  const key = th.dataset.wwSort;
  if (_wwSort.key === key) {
    _wwSort.desc = !_wwSort.desc;
  } else {
    _wwSort = { key, desc: key !== "coin" }; // strings default asc, numbers default desc
  }
  if (_wwLastResults) renderWhaleWatch(_wwLastResults);
});

// ── Whale Leaderboard ─────────────────────────────

async function fetchAndRenderLeaderboard() {
  const loadBtn = document.getElementById("ww-lb-load");
  const metaEl = document.getElementById("ww-lb-meta");
  const wrap = document.getElementById("ww-lb-table-wrap");
  const tbody = document.getElementById("ww-lb-tbody");
  if (!loadBtn || !tbody) return;

  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";
  if (metaEl) metaEl.textContent = "";

  try {
    const data = await fetchJson("/api/whale-leaderboard");
    const rows = data.rows ?? [];
    const list = wwGetList();
    const watchedAddresses = new Set(list.map((w) => w.address.toLowerCase()));

    tbody.innerHTML = rows
      .map((r, idx) => {
        const short = `${r.address.slice(0, 6)}…${r.address.slice(-4)}`;
        const nameStr = r.displayName
          ? `${escapeHtml(r.displayName)} <span style="opacity:.5;font-size:10px">${short}</span>`
          : short;
        const roi = Number.isFinite(r.roi30d)
          ? `${(r.roi30d * 100).toFixed(1)}%`
          : "—";
        const pnlColor = r.pnl30d >= 0 ? "var(--green)" : "var(--red)";
        const pnlSign = r.pnl30d >= 0 ? "+" : "";
        const alreadyAdded = watchedAddresses.has(r.address.toLowerCase());
        const addBtn = alreadyAdded
          ? `<button disabled style="font-size:10px;padding:2px 7px;border:1px solid var(--hairline);border-radius:4px;background:none;color:var(--text-faint);cursor:default">✓</button>`
          : `<button data-lb-add="${escapeHtml(r.address)}" data-lb-name="${escapeHtml(r.displayName || short)}" style="font-size:10px;padding:2px 7px;border:1px solid var(--hairline);border-radius:4px;background:none;color:var(--text-muted);cursor:pointer">+ Add</button>`;
        return `<tr>
        <td style="color:var(--text-faint);font-size:11px">${idx + 1}</td>
        <td style="font-family:var(--font-mono);font-size:11px">${nameStr}</td>
        <td class="r">${fmtNotional(r.accountValue)}</td>
        <td class="r" style="color:${pnlColor}">${pnlSign}${fmtNotional(r.pnl30d)}</td>
        <td class="r" style="color:${pnlColor}">${roi}</td>
        <td class="r" style="color:var(--text-muted)">${fmtNotional(r.vlm30d)}</td>
        <td>${addBtn}</td>
      </tr>`;
      })
      .join("");

    // Bind add buttons
    tbody.querySelectorAll("[data-lb-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const addr = btn.dataset.lbAdd.toLowerCase();
        const name =
          btn.dataset.lbName || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
        const list = wwGetList();
        if (!list.some((w) => w.address === addr)) {
          list.push({ label: name, address: addr });
          wwSaveList(list);
        }
        btn.disabled = true;
        btn.textContent = "✓";
        btn.style.color = "var(--text-faint)";
        btn.style.cursor = "default";
        fetchWhaleWatch();
      });
    });

    if (wrap) wrap.style.display = "";
    if (metaEl) {
      const age = data.ts
        ? `${Math.round((Date.now() - data.ts) / 1000)}s ago`
        : "";
      metaEl.textContent = `${rows.length} accounts${data.stale ? " (stale)" : ""}${age ? " · " + age : ""}`;
    }
    loadBtn.textContent = "Refresh";
  } catch (err) {
    loadBtn.textContent = "Error — retry";
    if (metaEl) metaEl.textContent = err.message;
  } finally {
    loadBtn.disabled = false;
  }
}

(function initLeaderboardUi() {
  const loadBtn = document.getElementById("ww-lb-load");
  if (!loadBtn) return;
  loadBtn.addEventListener("click", fetchAndRenderLeaderboard);
})();
