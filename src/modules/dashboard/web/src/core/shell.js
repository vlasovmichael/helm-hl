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
const THEME_LABEL = {
  auto: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

// Перекрасчики графиков. Набор живёт отдельно от bindTheme: шапка с кнопкой
// темы одна на все экраны роутера, а график принадлежит конкретной странице.
const themers = new Set();

/**
 * Подписать перекрасчик графика на смену темы.
 * @returns {() => void} отписка: зовётся при уходе со страницы.
 */
export function onThemeChange(fn) {
  themers.add(fn);
  return () => themers.delete(fn);
}

// chartThemers — фабрики тем графиков страницы (само-гардятся, если графика нет).
export function bindTheme(chartThemers = []) {
  for (const fn of chartThemers) themers.add(fn);
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
      btn.setAttribute("aria-label", THEME_LABEL[mode]);
    }
    for (const fn of themers) fn();
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

let footerTimer = null;

/**
 * Секундный тик футера.
 * @returns {() => void} остановка: без неё на каждом возврате на страницу
 * добавляется ещё один тик поверх живого.
 */
export function startFooterTimer() {
  stopFooterTimer();
  footerTimer = setInterval(renderFooter, 1000);
  return stopFooterTimer;
}

export function stopFooterTimer() {
  if (!footerTimer) return;
  clearInterval(footerTimer);
  footerTimer = null;
}

// handlers = { onStatus(data), onLogsInit(entries), onLog(entry), onDivergence() }
// После сна и заморозки вкладки сокет часто числится OPEN, хотя соединение
// мертво, а onclose приходит через секунды. Живость меряем тишиной: статус
// идёт раз в 2с, и молчание дольше порога значит «переподключиться сейчас».
let wsHandlers = null;
let wakeBound = false;
let lastWsMsgAt = 0;
let wsWatchdog = null;
let wsWatchdogTickAt = 0;
const WS_SILENCE_MS = 6_000;
const WS_WAKE_SILENCE_MS = 3_000;
// Интервал, опоздавший больше чем на это, значит, что таймеры спали вместе с машиной.
const WS_SLEEP_GAP_MS = 3_000;

function reconnectNow() {
  if (!wsHandlers) return;
  wsRetryDelay = 1000;
  initWebSocket(wsHandlers);
}

function wakeWebSocket() {
  if (document.visibilityState !== "visible" || !wsHandlers) return;
  if (Date.now() - lastWsMsgAt < WS_WAKE_SILENCE_MS) return;
  reconnectNow();
}

function checkWsSilence() {
  const now = Date.now();
  const slept = now - wsWatchdogTickAt > WS_SLEEP_GAP_MS;
  wsWatchdogTickAt = now;
  if (!wsHandlers || document.visibilityState !== "visible") return;
  const silence = now - lastWsMsgAt;
  if (silence > WS_SILENCE_MS || (slept && silence > WS_WAKE_SILENCE_MS)) reconnectNow();
}

export function initWebSocket(handlers = {}) {
  wsHandlers = handlers;
  if (!wakeBound) {
    wakeBound = true;
    document.addEventListener("visibilitychange", wakeWebSocket);
    window.addEventListener("pageshow", wakeWebSocket);
    window.addEventListener("online", wakeWebSocket);
  }
  if (!wsWatchdog) {
    wsWatchdogTickAt = Date.now();
    wsWatchdog = setInterval(checkWsSilence, 1000);
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
  // Старый сокет отвязываем до close: его onclose не должен планировать ещё один коннект.
  const prev = socket;
  socket = null;
  prev?.close();
  lastWsMsgAt = Date.now();
  const ws = new WebSocket(`${protocol}//${host}`);
  socket = ws;

  ws.onopen = () => {
    wsRetryDelay = 1000;
    setWsState("connecting"); // станет 'live' после первого msg
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return;
    lastWsMsgAt = Date.now();
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

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };

  ws.onclose = () => {
    // 🚨 Сокет, закрытый уходом со страницы, не переподключаем: иначе каждый
    // возврат добавляет ещё одно соединение поверх живого.
    if (socket !== ws) return;
    setWsState("reconnecting");
    wsReconnectTimer = setTimeout(() => initWebSocket(handlers), wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
  };

  return stopWebSocket;
}

/** Закрыть сокет и отменить переподключение — при уходе со страницы. */
export function stopWebSocket() {
  wsHandlers = null;
  if (wsWatchdog) {
    clearInterval(wsWatchdog);
    wsWatchdog = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const ws = socket;
  socket = null;
  ws?.close();
}
