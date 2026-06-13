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
let currentPnlPeriod = "today";
let lastPnlSummary = null;
let lastInsights = null;
let currentInsightsTab = "per-coin";
let perCoinSort = { key: "pnl", dir: "desc" };
let socket = null;
const lastAnimatedValues = new Map();

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

function renderHeader(status) {
  // Секция-хост только на дашборде; на /strategies.html её нет → no-op.
  if (!document.getElementById("uptime-val")) return;
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
  document.getElementById("uptime-val").textContent =
    `Uptime: ${formatUptime(status.uptimeMin)}`;
  document.getElementById("available-val").textContent =
    `Available: ${fmtUsd(status.available)}`;

  const wtEl = document.getElementById("wallet-total-val");
  if (wtEl) wtEl.style.display = "none";
}

function renderPosition(pos) {
  const container = document.getElementById("position-container");
  if (!container) return; // нет секции (напр. /strategies.html)
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
      // Бот подхватил вход (adopt) → дописываем ADOPTED, чтобы было видно, что
      // на нём уже висит стоп+трейл няньки. Не подхватил → чистый HANDS-OFF.
      const manualBadge = p.adopted
        ? `HANDS-OFF · MANUAL · <span style="color:var(--green,#22c55e)">ADOPTED</span>`
        : "HANDS-OFF · MANUAL";
      return `
      <div style="margin-top:0.75rem; padding:0.75rem; border:1px dashed var(--border); border-radius:8px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:0.5rem;">
          <span style="background:rgba(234,179,8,0.12); color:var(--yellow,#eab308); border:1px solid rgba(234,179,8,0.3); padding:2px 8px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:700;">${manualBadge}</span>
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
    setEquityData(data);
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
  if (!container) return; // нет секции (напр. /strategies.html)
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
    title: "Setup Scanner · Swing — направление на 1+ день",
    lead: "Биас/контекст для ручного свинга, НЕ команда на вход. Направление задаёт тренд (4h главный + 1h подтверждение), OI подтверждает реальность движения, funding — флаг осторожности. Вход и инвалидацию ставишь сам.",
    sections: [
      {
        title: "Сигнал v1",
        rows: [
          [
            '<span class="swing-badge long">LONG</span>',
            "4h↑ + 1h↑, OI растёт вместе с ценой за 7д (реальный спрос), funding не в эйфории",
          ],
          [
            '<span class="swing-badge short">SHORT</span>',
            "4h↓ + 1h↓, OI растёт на падении (давят шорты), funding не в панике",
          ],
          [
            '<span class="swing-badge wait">WAIT</span>',
            "Тренды разошлись, OI не подтверждает или funding в экстриме. Подробности — в tooltip строки",
          ],
        ],
      },
      {
        title: "Тренд 4h / 1h",
        sub: "Позиция цены и EMA20 относительно медленной EMA (200 на 1h, 50 на 4h — те же ~200 часов). ↑ = цена и EMA20 выше; ↓ = ниже; − = смешанно. Связь с фейдом: 4h range (−) → фейд ок; чёткий 4h тренд → фейд против него = самоубийство.",
      },
      {
        title: "Позиция открыта — exit-контекст",
        sub: "Монеты с открытой позицией на счёте (ручной или ботовой) поднимаются в топ с бейджем POS, Entry-колонка показывает контекст удержания, колонка SL/TP — твои стопы с биржи: дистанции от входа + R:R (оранжевый если R:R < 2, красный ⚠ NO SL если стопа нет). Дублируется ntfy-пушем (тихий час 00–08: пуш беззвучный).",
        rows: [
          ['<span style="color:var(--green)">hold</span>', "Тренд за позицию — контекст не против тебя"],
          [
            '<span style="color:#f59e0b">⚠ EMA20</span>',
            "Цена закрепилась за 1h EMA20 против позиции — импульс теряется",
          ],
          [
            '<span style="color:var(--red)">⚠ exit?</span>',
            "1h тренд развернулся против позиции — контекст сломан. Не команда: проверь график и свой стоп",
          ],
        ],
      },
      {
        title: "Entry — можно ли прямо сейчас",
        sub: "Сигнал = направление, Entry = тайминг. Где цена относительно 1h EMA20 (зоны отката). Вход в зону тоже дублируется ntfy-пушем:",
        rows: [
          [
            '<span style="color:var(--green);font-weight:600">✓ zone</span>',
            "Цена у/за EMA20 — откат случился, ищи вход по тренду (5m reclaim — глазами)",
          ],
          [
            '<span class="num-inline-muted">mid</span>',
            "Между зоной и растяжкой — можно ждать лучшую цену",
          ],
          [
            '<span style="color:#f59e0b">wait −3.2%</span>',
            "Цена растянута от EMA20 по тренду — гнаться поздно (chase), жди отката",
          ],
          [
            '<span style="color:#ec4899;font-weight:700">🍬 GO 12m</span>',
            "Candy Girl подтвердил 5m reclaim по тому же направлению (≤90m назад) — тайминг входа созрел. «🍬 wait» = свинг даёт зону, но 5m-вход ещё не напечатался (или радар выключен)",
          ],
        ],
      },
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
  if (!document.getElementById("pnl-total")) return; // секция живёт на /strategies.html
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
  if (!document.getElementById("tax-costs")) return; // нет секции (/strategies.html)
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

bindLogsUi();
fetchInitialLogs();

applyTheme(getStoredTheme());
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

