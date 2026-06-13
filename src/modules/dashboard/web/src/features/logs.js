// ─────────────────────────────────────────────────
//  Live Logs — кольцевой буфер + фильтр/поиск + рендер.
//  Приватное состояние (logsState). ingestLogs зовёт WS-хендлер,
//  bindLogsUi/fetchInitialLogs — bootstrap.
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

const LOG_BUFFER_MAX = 1000;
const logsState = {
  buffer: [],
  lastId: 0,
  level: "all",
  query: "",
  paused: false,
  renderScheduled: false,
};

export function ingestLogs(entries, replace) {
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

export function bindLogsUi() {
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

export async function fetchInitialLogs() {
  try {
    const r = await fetchJson("/api/logs?limit=500");
    if (r && Array.isArray(r.entries)) ingestLogs(r.entries, true);
  } catch (err) {
    console.error("[Logs] initial fetch failed", err);
  }
}
