// ─────────────────────────────────────────────────
//  Колокольчик уведомлений — выпадашка с ушедшими ntfy-пушами
// ─────────────────────────────────────────────────
// Разметка живёт в topnav (на всех страницах). Здесь — поведение: фетч
// /api/notifications, рендер списка, бейдж непрочитанных (по lastRead в
// localStorage), открытие/закрытие панели. Лёгкий поллинг раз в 60с, пока
// вкладка видима. Бэкенд только читает журнал — «прочитано» чисто клиентское.

import { getNotifications } from "../net/api.js";
import { escapeHtml, fmtSince } from "../utils/format.js";

const LS_KEY = "helm.notif.lastRead";
const POLL_MS = 60_000;

let items = [];
let timer = null;

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
  if (!badge) return;
  const n = unreadCount();
  if (n > 0) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderList() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="notif-empty">Пока тихо — пушей не было.</div>';
    return;
  }
  const lr = lastRead();
  list.innerHTML = items
    .map((n) => {
      const fresh = n.ts > lr ? " notif-item--fresh" : "";
      const mail = n.emailed ? '<span class="notif-mail" title="Продублировано письмом">✉</span>' : "";
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
