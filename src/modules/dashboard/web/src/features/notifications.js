// ─────────────────────────────────────────────────
//  Notification bell — dropdown of the ntfy pushes that went out
// ─────────────────────────────────────────────────
// Markup lives in topnav (all pages). Here is the behavior: fetch
// /api/notifications, render the list, unread badge (vs lastRead in
// localStorage), open/close the panel. Light 60s polling while the tab is
// visible. The backend only reads the log — "read" is purely client-side.

import { getNotifications } from "../net/api.js";
import { escapeHtml, fmtSince } from "../utils/format.js";

const LS_KEY = "helm.notif.lastRead";
const POLL_MS = 60_000;

let items = [];
let timer = null;
let lastUnread = 0; // to detect a freshly-arrived push → ring the bell

function lastRead() {
  return Number(localStorage.getItem(LS_KEY) || 0);
}
function setLastRead(ts) {
  localStorage.setItem(LS_KEY, String(ts));
}

function unreadCount() {
  const lr = lastRead();
  return items.filter((n) => n.ts > lr).length;
}

function renderBadge() {
  const badge = document.getElementById("notif-badge");
  const btn = document.getElementById("notif-btn");
  if (!badge) return;
  const n = unreadCount();
  if (n > 0) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
  // Ring the bell once when the unread count grows (new push landed). Re-trigger
  // the CSS animation by toggling the class off→reflow→on.
  if (btn && n > lastUnread) {
    btn.classList.remove("is-ringing");
    void btn.offsetWidth; // force reflow so the animation restarts
    btn.classList.add("is-ringing");
  }
  if (btn && n === 0) btn.classList.remove("is-ringing");
  lastUnread = n;
}

function renderList() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="notif-empty">All quiet — no pushes yet.</div>';
    return;
  }
  const lr = lastRead();
  list.innerHTML = items
    .map((n) => {
      const fresh = n.ts > lr ? " notif-item--fresh" : "";
      const mail = n.emailed ? '<span class="notif-mail" title="Also sent by email">✉</span>' : "";
      const body = (n.message || "").split("\n")[0]; // первая строка — суть
      return `
        <div class="notif-item${fresh}">
          <div class="notif-item-head">
            <span class="notif-item-title">${escapeHtml(n.title)}</span>
            <span class="notif-item-time">${mail}${fmtSince(n.ts)}</span>
          </div>
          <div class="notif-item-body">${escapeHtml(body)}</div>
        </div>`;
    })
    .join("");
}

async function refresh() {
  try {
    const data = await getNotifications(50);
    items = Array.isArray(data?.items) ? data.items : [];
    renderBadge();
    if (!document.getElementById("notif-panel")?.hidden) renderList();
  } catch {
    /* fail-soft — колокольчик не критичен */
  }
}

function openPanel() {
  const panel = document.getElementById("notif-panel");
  const btn = document.getElementById("notif-btn");
  if (!panel) return;
  panel.hidden = false;
  btn?.setAttribute("aria-expanded", "true");
  renderList();
}

function closePanel() {
  const panel = document.getElementById("notif-panel");
  const btn = document.getElementById("notif-btn");
  if (!panel) return;
  panel.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
}

function markRead() {
  const newest = items.length ? Math.max(...items.map((n) => n.ts)) : Date.now();
  setLastRead(newest);
  renderBadge();
  renderList();
}

export function initNotifications() {
  const root = document.getElementById("notif");
  const btn = document.getElementById("notif-btn");
  if (!root || !btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.getElementById("notif-panel");
    if (panel?.hidden) openPanel();
    else closePanel();
  });

  document.getElementById("notif-mark-read")?.addEventListener("click", (e) => {
    e.stopPropagation();
    markRead();
  });

  // Клик вне панели / Esc — закрыть.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
}
