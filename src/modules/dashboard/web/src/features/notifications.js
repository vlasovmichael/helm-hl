// ─────────────────────────────────────────────────
//  Notification bell — dropdown of the ntfy pushes that went out
// ─────────────────────────────────────────────────
// Markup lives in topnav (all pages). Here is the behavior: fetch
// /api/notifications, render the list, unread badge (vs lastRead in
// localStorage), open/close the panel. Light 60s polling while the tab is
// visible. The backend only reads the log — "read" is purely client-side.

import { getNotifications } from "../net/api.js";
import { fmtSince } from "../utils/format.js";
import { linkifyCoins } from "../utils/links.js";
import { icon } from "../core/icon.js";

const LS_KEY = "helm.notif.lastRead";
const POLL_MS = 60_000;
const WINDOW_MS = 24 * 60 * 60 * 1000; // показываем только последние сутки
const ANIM_MS = 180; // длительность open/close анимации панели (см. _chrome.scss)
const TOAST_LINGER_MS = 5200; // сколько тост висит перед полётом в колокольчик
const TOAST_FRESH_MS = 120_000; // тостим только реально свежий пуш (не реплей WS)
const TOAST_MAX = 3; // максимум одновременных тостов на экране

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
      const mail = n.emailed ? `<span class="notif-mail" title="Also sent by email">${icon("mail")}</span>` : "";
      const body = stripEmoji((n.message || "").split("\n")[0]); // первая строка — суть
      // Та же классификация, что у тоста: одно событие выглядит одинаково и в
      // тосте, и в списке — иначе колокольчик читается как другой продукт.
      const { glyph } = classifyNotif(n);
      // linkifyCoins сам экранирует текст и делает #COIN ссылкой на TradingView.
      return `
        <div class="notif-item${fresh}">
          <div class="notif-item-head">
            <span class="notif-item-ico">${icon(glyph)}</span>
            <span class="notif-item-title">${linkifyCoins(stripEmoji(n.title))}</span>
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

// ── Toasts ────────────────────────────────────────────────────────────
// Свежий пуш всплывает карточкой справа сверху, живёт TOAST_LINGER_MS, затем
// «улетает» в колокольчик и растворяется (бейдж остаётся). Разметка/анимации —
// _chrome.scss (.toast-stack / .toast / .is-in / .is-out).

function toastStack() {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  return stack;
}

// Полёт тоста в колокольчик: считаем дельту центров и отдаём её в CSS-transform.
function flyToBell(el) {
  if (el.dataset.leaving) return;
  el.dataset.leaving = "1";
  const bell = document.getElementById("notif-btn");
  if (bell) {
    const b = bell.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    el.style.setProperty("--fly-x", `${b.left + b.width / 2 - (t.left + t.width / 2)}px`);
    el.style.setProperty("--fly-y", `${b.top + b.height / 2 - (t.top + t.height / 2)}px`);
  }
  el.classList.remove("is-in");
  el.classList.add("is-out");
  const done = () => el.remove();
  el.addEventListener("transitionend", done, { once: true });
  setTimeout(done, 700); // страховка, если transitionend не прилетит
}

// Иконка события — ключ из общего набора (core/icon.js). Раньше здесь лежали
// шесть контуров, набранных руками под viewBox 24: у них был свой stroke-width,
// и рядом с иконками остального дашборда они читались как из другого набора.
const NOTIF_ICON = {
  ok: "check",
  danger: "danger",
  warn: "warn",
  up: "rising",
  down: "falling",
  info: "info",
};

// Явная сторона сделки — только когда в тексте есть слово LONG/SHORT (fade-алерты,
// филлы). Тогда показываем цветную пилюлю. Для радара OI/move это не «сторона».
function toastSide(item) {
  const t = `${item.title || ""} ${item.message || ""}`;
  if (/\bshort\b/i.test(t)) return "short";
  if (/\blong\b/i.test(t)) return "long";
  return null;
}

// Направление движения — из ntfy-тегов. Даёт иконку-тренд.
function toastDir(item) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const has = (x) => tags.includes(x);
  if (has("green_circle") || has("chart_with_upwards_trend")) return "up";
  if (has("red_circle") || has("chart_with_downwards_trend")) return "down";
  return null;
}

// Схема B: цвет = СОБЫТИЕ (стоп/цель/пауза/инфо), сторону несёт бейдж +
// иконка-тренд. Вход (opened/filled) — нейтральный инфо, а не «успех».
//
// Одна функция на тост и на список в колокольчике: одно и то же событие в двух
// местах обязано выглядеть одинаково.
function classifyNotif(item) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const has = (t) => tags.includes(t);
  const text = `${item.title || ""} ${item.message || ""}`.toLowerCase();
  const side = toastSide(item);
  const dir = toastDir(item) || (side === "long" ? "up" : side === "short" ? "down" : null);

  let kind = "info";
  if ((item.priority ?? 3) >= 4 || has("rotating_light") || has("warning") ||
      /\bstop|\bsl\b|liquidat|error|fail|drawdown|circuit|breaker|external/.test(text)) {
    kind = "danger";
  } else if (has("white_check_mark") || has("heavy_check_mark") ||
      /target|\btp\b|profit|\bwin\b|\+\$/.test(text)) {
    kind = "ok";
  } else if (has("snowflake") || /\bwarn|stale|cooldown|paused|\bcold\b|skip/.test(text)) {
    kind = "warn";
  }

  const cls = kind === "ok" ? "toast--ok" : kind === "danger" ? "toast--danger"
    : kind === "warn" ? "toast--warn" : "";

  // Иконка события важнее тренда (стоп — тревога, а не «вниз»). Тренд остаётся
  // только у нейтральных инфо-пушей (входы, радар движения).
  const glyph =
    kind !== "info" ? NOTIF_ICON[kind]
    : dir === "up" ? NOTIF_ICON.up
    : dir === "down" ? NOTIF_ICON.down
    : NOTIF_ICON.info;

  return { kind, cls, glyph, side };
}

// Тексты пушей приходят из ntfy, а там заголовок начинается с эмодзи и ещё
// пара встречается внутри строки. В дашборде эмодзи нет: они рисуются цветным
// растром мимо темы и мимо веса шрифта, а смысл уже несёт иконка-чип слева.
//
// 🚨 Чистим ОБА места — и тост, и список в колокольчике. До 04.09.2026 стриппер
// стоял только на тосте, поэтому в панели эмодзи оставались.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu;

function stripEmoji(s) {
  const out = String(s || "")
    .replace(EMOJI, "")
    // Двойные пробелы и осиротевшие разделители после вырезанного эмодзи.
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s·—–-]+/, "")
    .trim();
  return out || String(s || "").trim();
}

// Красиво выделяем тело: числовые токены ($70, 2%, +$3.10, 5x, 0.0000123) — моно
// и ярче, знак ±→ зелёный/красный; «·» — приглушённый разделитель. Применяем
// ТОЛЬКО к тексту вне тегов, чтобы не поломать <a>-ссылки из linkifyCoins.
function decorateBody(html) {
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_m, tag, txt) => {
    if (tag) return tag;
    return txt
      .replace(/·/g, '<span class="toast-sep">·</span>')
      .replace(/([+\-−]?\$?\d[\d.,]*\s*(?:%|x)?)/g, (num) => {
        const t = num.trim();
        let cls = "toast-num";
        if (/^\+/.test(t)) cls += " toast-num--pos";
        else if (/^[-−]/.test(t)) cls += " toast-num--neg";
        return `<span class="${cls}">${t}</span>`;
      });
  });
}

function showToast(item) {
  // Уважаем системную настройку «меньше движения» — но и вовсе без тостов скучно;
  // CSS сам упрощает анимацию (reduced-motion), поэтому тост показываем всегда.
  const stack = toastStack();
  const { cls, glyph, side } = classifyNotif(item);
  const el = document.createElement("div");
  el.className = `toast${cls ? ` ${cls}` : ""}`;
  el.setAttribute("role", "status");
  el.style.setProperty("--toast-life", `${TOAST_LINGER_MS}ms`);
  const body = (item.message || "").split("\n")[0];
  const badge = side
    ? `<span class="toast-side toast-side--${side}">${side.toUpperCase()}</span>`
    : "";
  el.innerHTML = `
    <span class="toast-ico">${icon(glyph)}</span>
    <div class="toast-main">
      <div class="toast-head">
        <span class="toast-title">${badge}${linkifyCoins(stripEmoji(item.title) || "Notification")}</span>
        <span class="toast-time">${fmtSince(item.ts)}</span>
      </div>
      ${body ? `<div class="toast-body">${decorateBody(linkifyCoins(body))}</div>` : ""}
    </div>`;

  // Клик по тосту (но не по ссылке-монете внутри) → открыть панель и убрать тост.
  el.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    flyToBell(el);
    openPanel();
  });

  stack.prepend(el);
  requestAnimationFrame(() => el.classList.add("is-in"));

  // Переполнение стека — самые старые (снизу) улетают раньше.
  const extra = [...stack.querySelectorAll(".toast:not([data-leaving])")].slice(TOAST_MAX);
  extra.forEach(flyToBell);

  setTimeout(() => flyToBell(el), TOAST_LINGER_MS);
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
  // Тост только на реально свежий живой пуш (не на поздний реплей WS/реконнект).
  if (Date.now() - item.ts < TOAST_FRESH_MS) showToast(item);
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
