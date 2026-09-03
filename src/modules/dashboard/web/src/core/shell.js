// ─────────────────────────────────────────────────
//  Dashboard Shell — общий каркас для всех страниц (index/strategies/ledger).
//  WS-коннект + диспетчер, тема, футер/ws-pill, fmtTime, range-кнопки.
//  Страница даёт свои render-хендлеры; фичи грузит только она (route code-split).
// ─────────────────────────────────────────────────

import { createMorphIcon } from "./iconMorph.js";
import { THEME_ICONS } from "./icons.js";

export const REFRESH_MS = 10_000;

let lastSuccessAt = 0;
let currentRangeHours = 24;

// ── fmtTime / range (зависит от выбранного окна) ──
export function getRangeHours() {
  return currentRangeHours;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  if (currentRangeHours <= 24) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// onRange(hours) — страница пере-тикает с новым окном.
export function bindRange(onRange) {
  document.querySelectorAll(".seg__btn[data-hours]").forEach((b) =>
    b.addEventListener("click", () => {
      document
        .querySelectorAll(".seg__btn[data-hours]")
        .forEach((r) => r.classList.remove("active"));
      b.classList.add("active");
      currentRangeHours = b.dataset.hours;
      onRange?.(currentRangeHours);
    }),
  );
}

// ── Theme ────────────────────────────────────────
const THEME_KEY = "hl-scanner-theme";
function getStoredTheme() {
  return localStorage.getItem(THEME_KEY) || "auto";
}

// Порядок цикла кнопки. auto первым — это и дефолт при пустом localStorage.
const THEME_CYCLE = ["auto", "light", "dark"];
const THEME_TITLE = {
  auto: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

// chartThemers — фабрики тем графиков страницы (само-гардятся, если графика нет).
export function bindTheme(chartThemers = []) {
  const btn = document.getElementById("theme-toggle");
  const svg = document.getElementById("theme-ico");
  // Морф не поднимаем, если кнопки нет (напр. login.html без topnav).
  const icon = svg ? createMorphIcon(svg, THEME_ICONS, getStoredTheme()) : null;

  const apply = (mode) => {
    const root = document.documentElement;
    const resolved =
      mode === "auto"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    root.setAttribute("data-theme", resolved);
    // Три состояния нельзя прочитать «по противоположному», поэтому иконка
    // показывает ТЕКУЩИЙ режим: монитор для auto, солнце/луна когда закреплено.
    icon?.to(mode);
    if (btn) {
      btn.title = THEME_TITLE[mode];
      btn.setAttribute("aria-label", THEME_TITLE[mode]);
    }
    chartThemers.forEach((fn) => fn());
  };

  btn?.addEventListener("click", () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(getStoredTheme()) + 1) % THEME_CYCLE.length];
    localStorage.setItem(THEME_KEY, next);
    apply(next);
  });

  // Пока следуем за системой, закат должен доезжать и до страницы.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getStoredTheme() === "auto") apply("auto");
  });

  apply(getStoredTheme());
}

// ── WebSocket ────────────────────────────────────
let socket = null;
let wsState = "connecting"; // 'live' | 'stale' | 'reconnecting' | 'connecting'
let wsRetryDelay = 1000;
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
  pill.classList.remove("live", "stale", "offline", "is-connecting");
  if (wsState === "live") {
    pill.classList.add("live");
    pill.textContent = "WS live";
  } else if (wsState === "stale") {
    pill.classList.add("stale");
    const age = Math.floor((Date.now() - lastSuccessAt) / 1000);
    pill.textContent = `WS stale ${age}s`;
  } else {
    // connecting и reconnecting — одно состояние для глаза: «связи нет, идёт
    // попытка». Многоточие снято, ожидание показывает расходящееся кольцо
    // (.is-connecting в core/_chrome.scss) — оно видно с другого конца стола.
    pill.classList.add("offline", "is-connecting");
    pill.textContent =
      wsState === "reconnecting" ? "WS reconnecting" : "WS connecting";
  }
}

// Вызывать в конце tick() страницы: фиксирует успех + перерисовывает футер.
export function markSuccess() {
  lastSuccessAt = Date.now();
  renderFooter();
}

export function renderFooter() {
  const footerEl = document.getElementById("footer-status");
  if (footerEl) {
    const footer = footerEl.querySelector("span");
    if (footer) {
      const age = Math.floor((Date.now() - lastSuccessAt) / 1000);
      footer.textContent =
        age > 15 ? `Stale (${age}s)` : `Syncing live · WS active`;
    }
  }
  if (wsState === "live" && Date.now() - lastSuccessAt > 10_000) {
    setWsState("stale");
  } else if (wsState === "stale") {
    renderWsPill();
  }
}

export function startFooterTimer() {
  setInterval(renderFooter, 1000);
}

// handlers = { onStatus(data), onLogsInit(entries), onLog(entry), onDivergence() }
// Статус-сокет просыпается по тем же правилам, что и поток цен: свёрнутая
// вкладка замораживается, onclose доходит с задержкой, и на возврате данные
// ждали backoff, а не сеть. Слушатель ставится один раз, handlers запоминаем —
// initWebSocket сам их и переиспользует при переподключении.
let wsHandlers = null;
let wakeBound = false;

function wakeWebSocket() {
  if (document.visibilityState !== "visible" || !wsHandlers) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsRetryDelay = 1000;
  initWebSocket(wsHandlers);
}

export function initWebSocket(handlers = {}) {
  wsHandlers = handlers;
  if (!wakeBound) {
    wakeBound = true;
    document.addEventListener("visibilitychange", wakeWebSocket);
    window.addEventListener("pageshow", wakeWebSocket);
  }
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
  socket = new WebSocket(`${protocol}//${host}`);

  socket.onopen = () => {
    wsRetryDelay = 1000;
    setWsState("connecting"); // станет 'live' после первого msg
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "status") {
        handlers.onStatus?.(msg.data);
        markSuccess();
        setWsState("live");
      } else if (msg.type === "logs:init") {
        handlers.onLogsInit?.(msg.entries || []);
      } else if (msg.type === "log") {
        handlers.onLog?.(msg.entry);
      } else if (msg.type === "btc-divergence") {
        handlers.onDivergence?.();
      } else if (msg.type === "notification") {
        // Колокольчик глобален (в топнаве на всех страницах), а shell не тянет
        // фичи — поэтому отдаём через CustomEvent, notifications.js слушает сам.
        window.dispatchEvent(new CustomEvent("helm:notification", { detail: msg.item }));
      }
    } catch (err) {
      console.error("[WS] Error:", err);
    }
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  socket.onclose = () => {
    setWsState("reconnecting");
    wsReconnectTimer = setTimeout(() => initWebSocket(handlers), wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
  };
}
