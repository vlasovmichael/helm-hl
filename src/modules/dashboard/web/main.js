// ─────────────────────────────────────────────────
//  HL Scanner Dashboard — Frontend
// ─────────────────────────────────────────────────

import { createChart } from "lightweight-charts";
import {
  formatUptime,
  hexToRgba,
  cssVar,
  fmtUsd,
  fmtPct,
  fmtPrice,
  escapeHtml,
  fmtMoney,
  fmtMoneyAbs,
  fmtNotional,
  fmtSince,
  strategyDisplayName,
} from "./src/utils/format.js";
import { renderHotMovers } from "./src/hotMovers/render.js";
import { fetchJson } from "./src/net/api.js";
import { subscribeOrderBook } from "./src/net/orderbook.js";
import {
  updateActiveCoinSet,
  isActiveCoin,
  hmPosHintRow,
  getActiveCoins,
  getActivePos,
} from "./src/state/activeCoins.js";
import {
  initWhaleWatch,
  getWhalePositions,
  setOnPositionsUpdated,
} from "./src/features/whaleWatch.js";
import {
  divRefresh,
  renderBtcDivergence,
  initDivergenceUi,
} from "./src/features/divergence.js";
import {
  ingestLogs,
  bindLogsUi,
  fetchInitialLogs,
} from "./src/features/logs.js";
import {
  initEquityChart,
  applyChartTheme,
  renderEquityPill,
  setEquityData,
} from "./src/charts/equityChart.js";
import {
  handlePriceChartUpdate,
  applyPriceChartTheme,
  initPriceChartUi,
} from "./src/charts/priceChart.js";
import { renderFaderCard } from "./src/features/fader.js";
import {
  renderCandyGirl,
  getCandySignals,
  setOnCandyUpdate,
} from "./src/features/candyGirl.js";
import { renderMarketContext } from "./src/features/marketContext.js";
import { renderStrategies } from "./src/features/strategies.js";
import {
  renderChillBoy,
  renderChillBoyCard,
} from "./src/features/chillBoy.js";
import { renderActivity, initModals } from "./src/features/modals.js";
import {
  setPnlSummary,
  setInsights,
  renderTax,
  initPnlInsights,
} from "./src/features/pnlInsights.js";
import {
  renderHeader,
  renderPosition,
  renderManualPositions,
  renderBans,
} from "./src/features/accountStatus.js";
import {
  initSetupScanner,
  renderSmartSignals,
  renderSmartSignalsIfReady,
  fetchMacroIfStale,
  setSwingEquity,
  setHmSignals,
  setBtcMomentum1m,
  markTickReady,
} from "./src/features/setupScanner.js";

const REFRESH_MS = 10_000;

let lastSuccessAt = 0;
let currentRangeHours = 24;
let socket = null;

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
  // В деве коннектимся напрямую к Express (:3010), минуя Vite — его HMR-сокет
  // висит на том же root-пути и перехватил бы апгрейд. В проде — same-origin.
  const host = import.meta.env.DEV
    ? import.meta.env.VITE_WS_HOST || "localhost:3010"
    : window.location.host;
  const wsUrl = `${protocol}//${host}`;
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    wsRetryDelay = 1000;
    setWsState("connecting"); // станет 'live' после первого msg
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "status") {
        if (Number.isFinite(msg.data.equity)) setSwingEquity(msg.data.equity);
        renderHeader(msg.data);
        updateActiveCoinSet(msg.data.activePosition, msg.data.manualPositions);
        renderPosition(msg.data.activePosition);
        renderManualPositions(msg.data.manualPositions);
        renderBans(msg.data);
        renderChillBoy(msg.data.chillBoy);
        renderChillBoyCard(msg.data.chillBoy);
        renderCandyGirl(msg.data.candyGirl);
        renderFaderCard(msg.data.fader);
        renderStrategies(msg.data.strategies);
        // Hot Movers — из WS (≤2с) вместо 10с-поллинга; HTTP /api/signals
        // в tick() остаётся фолбэком, если WS отвалится.
        if (msg.data.hotMovers?.signals) {
          setHmSignals(msg.data.hotMovers.signals);
          renderHotMovers(msg.data.hotMovers, fmtTime);
        }
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
  applyChartTheme(); // само-гардится если equity-график ещё не создан
  applyPriceChartTheme(); // само-гардится если price-график ещё не создан
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

async function tick() {
  const [historyR, activityR, taxR, pnlR, insightsR, hmR, btcR, mcR, stratR] =
    await Promise.allSettled([
      fetchJson(`/api/history?hours=${currentRangeHours}`),
      fetchJson(`/api/activity?hours=${currentRangeHours}&limit=10`),
      fetchJson("/api/tax-summary"),
      fetchJson("/api/pnl-summary"),
      fetchJson("/api/insights"),
      fetchJson("/api/signals?limit=30"),
      fetchJson("/api/candles?coin=BTC&interval=1m"),
      fetchJson("/api/market-context"),
      // Strategies таблица: REST-источник на загрузку/поллинг (WS обновляет live).
      // Грузим из REST, чтобы не зависеть от первого WS-тика. Только на /strategies.
      document.getElementById("strategies-tbody")
        ? fetchJson("/api/strategies")
        : Promise.resolve(null),
    ]);
  if (stratR.status === "fulfilled" && stratR.value) {
    renderStrategies(stratR.value);
  }
  if (mcR.status === "fulfilled") renderMarketContext(mcR.value);
  if (hmR.status === "fulfilled" && hmR.value?.signals) {
    setHmSignals(hmR.value.signals);
    renderHotMovers(hmR.value, fmtTime);
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
      setBtcMomentum1m(((lastClose - prevClose) / prevClose) * 100);
    }
  }
  await fetchMacroIfStale();
  markTickReady();
  renderSmartSignals();
  if (pnlR.status === "fulfilled") setPnlSummary(pnlR.value);
  if (insightsR.status === "fulfilled") setInsights(insightsR.value);
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
    setEquityData(data);
    renderEquityPill();
    hideChartLoader();
  }
  if (activityR.status === "fulfilled") renderActivity(activityR.value);
  if (taxR.status === "fulfilled") renderTax(taxR.value);
  lastSuccessAt = Date.now();
  renderFooter();
}

function renderFooter() {
  const footerEl = document.getElementById("footer-status");
  if (!footerEl) return; // нет футера (напр. /strategies.html)
  const footer = footerEl.querySelector("span");
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

bindLogsUi();
fetchInitialLogs();

applyTheme(getStoredTheme());
initModals(); // делегированные listener'ы help/trade модалок + activity-клик + Esc
initPnlInsights({ fmtTime }); // биндинги периодов P&L / вкладок Insights / сортировки
initEquityChart();
initPriceChartUi(); // биндинг кнопок таймфрейма price-графика
initWebSocket();
tick();
initDivergenceUi(); // биндинг вкладок 5m/15m/1h/all
divRefresh(); // первичная загрузка дивергенции (до первого WS-пуша)
// Whale Watch перерисовывает таблицу дивергенции при обновлении китовых позиций.
setOnPositionsUpdated(() => renderBtcDivergence(null));
initWhaleWatch(); // UI-биндинги + первичный fetch + 30с-поллинг + leaderboard
// Candy Girl обновляет Smart Signals при свежих сигналах (после первого tick).
setOnCandyUpdate(() => renderSmartSignalsIfReady());
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1000);

// Setup Scanner (Swing): первичный fetch + 60с-поллинг внутри модуля.
initSetupScanner({ fmtTime });

