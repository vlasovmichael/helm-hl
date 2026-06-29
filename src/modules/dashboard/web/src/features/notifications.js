// ─────────────────────────────────────────────────
//  Notification bell — dropdown of the ntfy pushes that went out
// ─────────────────────────────────────────────────
// Markup lives in topnav (all pages). Here is the behavior: fetch
// /api/notifications, render the list, unread badge (vs lastRead in
// localStorage), open/close the panel. Light 60s polling while the tab is
// visible. The backend only reads the log — "read" is purely client-side.

import { getNotifications } from "../net/api.js";
import { escapeHtml, fmtSince } from "../utils/format.js";
import { linkifyCoins } from "../utils/links.js";

const LS_KEY = "helm.notif.lastRead";
const POLL_MS = 60_000;
const WINDOW_MS = 24 * 60 * 60 * 1000; // показываем только последние сутки
const ANIM_MS = 180; // длительность open/close анимации панели (см. _chrome.scss)

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
    list.innerHTML = '<div class="notif-empty">All quiet — nothing in the last 24h.</div>';
    return;
  }
  const lr = lastRead();
  list.innerHTML = items
    .map((n) => {
      const fresh = n.ts > lr ? " notif-item--fresh" : "";
      const mail = n.emailed ? '<span class="notif-mail" title="Also sent by email">✉</span>' : "";
      const body = (n.message || "").split("\n")[0]; // первая строка — суть
      // linkifyCoins сам экранирует текст и делает #COIN ссылкой на TradingView.
      return `
        <div class="notif-item${fresh}">
          <div class="notif-item-head">
            <span class="notif-item-title">${linkifyCoins(n.title)}</span>
            <span class="notif-item-time">${mail}${fmtSince(n.ts)}</span>
          </div>
          <div class="notif-item-body">${linkifyCoins(body)}</div>
        </div>`;
    })
    .join("");
}

async function refresh() {
  try {
    const data = await getNotifications(50);
    const raw = Array.isArray(data?.items) ? data.items : [];
    const cutoff = Date.now() - WINDOW_MS;
    items = raw.filter((n) => n.ts >= cutoff);
    renderBadge();
    if (!document.getElementById("notif-panel")?.hidden) renderList();
  } catch {
    /* fail-soft — колокольчик не критичен */
  }
}

// Мгновенный приём одного пуша по WS (shell.js → CustomEvent "helm:notification").
// Телефон (ntfy) и дашборд звонят синхронно, без 60с-лага поллинга. Поллинг
// остаётся fallback'ом на реконнект / вкладку в фоне. Дедуп по id (poll + WS).
function ingest(item) {
  if (!item || typeof item.ts !== "number") return;
  if (items.some((n) => n.id === item.id)) return;
  const cutoff = Date.now() - WINDOW_MS;
  items = [item, ...items].filter((n) => n.ts >= cutoff).slice(0, 50);
  renderBadge(); // n>lastUnread → звонок (см. renderBadge)
  if (!document.getElementById("notif-panel")?.hidden) renderList();
}

let closeTimer = null;

function openPanel() {
  const panel = document.getElementById("notif-panel");
  const btn = document.getElementById("notif-btn");
  if (!panel) return;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  renderList(); // рендерим со старым lastRead → свежие подсветятся в этом показе
  panel.hidden = false;
  // Следующий кадр → добавляем .is-open, чтобы сработал CSS-переход (анимация
  // въезда). Без rAF браузер применит оба состояния разом и анимации не будет.
  requestAnimationFrame(() => panel.classList.add("is-open"));
  btn?.setAttribute("aria-expanded", "true");
  // Авто-прочтение: гасим бейдж сразу при открытии (кнопки «Mark read» больше
  // нет). Список не перерисовываем — подсветка свежих остаётся видна, пока
  // панель открыта; при следующем открытии они уже не «fresh».
  markRead({ keepList: true });
}

function closePanel() {
  const panel = document.getElementById("notif-panel");
  const btn = document.getElementById("notif-btn");
  if (!panel || panel.hidden) return;
  panel.classList.remove("is-open");
  btn?.setAttribute("aria-expanded", "false");
  // Прячем из потока только после того, как отыграет анимация выезда.
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!panel.classList.contains("is-open")) panel.hidden = true;
    closeTimer = null;
  }, ANIM_MS);
}

function markRead({ keepList = false } = {}) {
  const newest = items.length ? Math.max(...items.map((n) => n.ts)) : Date.now();
  setLastRead(newest);
  renderBadge();
  if (!keepList) renderList();
}

export function initNotifications() {
  const root = document.getElementById("notif");
  const btn = document.getElementById("notif-btn");
  if (!root || !btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.getElementById("notif-panel");
    if (panel?.classList.contains("is-open")) closePanel();
    else openPanel();
  });

  // Клик вне панели / Esc — закрыть.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  // Мгновенные пуши по WS (глобально, на всех страницах — топнав один на все).
  window.addEventListener("helm:notification", (e) => ingest(e.detail));

  refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
}
