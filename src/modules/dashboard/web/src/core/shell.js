// ─────────────────────────────────────────────────
//  Dashboard Shell — общий каркас для всех страниц (index/strategies/ledger).
//  WS-коннект + диспетчер, тема, футер/ws-pill, fmtTime, range-кнопки.
//  Страница даёт свои render-хендлеры; фичи грузит только она (route code-split).
// ─────────────────────────────────────────────────

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
  document.querySelectorAll(".range-btn[data-hours]").forEach((b) =>
    b.addEventListener("click", () => {
      document
        .querySelectorAll(".range-btn[data-hours]")
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

// chartThemers — фабрики тем графиков страницы (само-гардятся, если графика нет).
export function bindTheme(chartThemers = []) {
  const apply = (mode) => {
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
    chartThemers.forEach((fn) => fn());
  };
  document.querySelectorAll(".theme-btn").forEach((b) =>
    b.addEventListener("click", () => {
      localStorage.setItem(THEME_KEY, b.dataset.theme);
      apply(b.dataset.theme);
    }),
  );
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
        age > 15 ? `⚠ Stale (${age}s)` : `Syncing live · WS active`;
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
export function initWebSocket(handlers = {}) {
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
