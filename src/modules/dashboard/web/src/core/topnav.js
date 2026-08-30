// ─────────────────────────────────────────────────
//  Topnav — единый верхний бар для всех страниц (index / statistics / ledger).
//  Раньше один и тот же <nav> копировался в три HTML — рассинхронизировался при
//  каждой правке. Теперь разметка живёт здесь, страница лишь кладёт пустой
//  placeholder <nav class="topnav" id="topnav"> и зовёт mountTopnav('<key>').
//  Тема-свитчер всё ещё цепляется отдельным bindTheme() ПОСЛЕ монтирования.
// ─────────────────────────────────────────────────

import { initNotifications } from "../features/notifications.js";
import { createMorphIcon } from "./iconMorph.js";
import { BELL_ICONS, NAV_ICONS } from "./icons.js";

const LINKS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  // Order Book остаётся как страница (/orderbook), но ссылку из навбара
  // убрали — стакан оператору тяжело читается, не нужен на видном месте (2026-06-28).
  { key: "statistics", href: "/statistics", label: "Statistics" },
  { key: "oi", href: "/oi", label: "OI", title: "История open interest по всем монетам (ΔOI 24ч/1ч)" },
  { key: "lab", href: "/lab", label: "Lab", title: "Research: реестр стратегий + закрытые вердикты" },
  { key: "journal", href: "/journal", label: "Journal", title: "Журнал чтения графика — разметка монеты на сутки вперёд" },
  { key: "ledger", href: "/ledger", label: "Ledger", title: "Monthly P&L ledger" },
];

const navLink = (l, active) => {
  const isActive = l.key === active;
  return `
    <a class="nav-link${isActive ? " active" : ""}" href="${l.href}"${
      isActive ? ' aria-current="page"' : ""
    }${l.title ? ` title="${l.title}"` : ""} data-nav="${l.key}">
      <svg class="nav-ico" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[l.key].rest}</svg>
      ${l.label}
    </a>`;
};

/**
 * Рендерит topnav в placeholder `#topnav`. Вызывать ДО bindTheme() — иначе
 * #theme-toggle ещё не существует в DOM.
 * @param {'dashboard'|'statistics'|'ledger'|'lab'} active
 */
export function mountTopnav(active) {
  const nav = document.getElementById("topnav");
  if (!nav) return;
  nav.setAttribute("aria-label", "Primary");
  nav.innerHTML = `
    <a class="topnav-brand" href="/">Helm</a>
    <div class="topnav-links">${LINKS.map((l) => navLink(l, active)).join("")}</div>
    <div class="topnav-right">
      <div class="notif" id="notif">
        <button class="notif-btn" id="notif-btn" type="button" aria-label="Notifications" aria-expanded="false" title="Notifications">
          <svg class="nav-ico notif-bell" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          <span class="notif-badge" id="notif-badge" hidden></span>
        </button>
        <div class="notif-panel" id="notif-panel" hidden role="dialog" aria-label="Notifications">
          <div class="notif-panel-head">
            <span>Notifications</span>
            <span class="notif-head-hint">Last 24h</span>
          </div>
          <div class="notif-list" id="notif-list"></div>
        </div>
      </div>
      <button class="theme-toggle" id="theme-toggle" type="button">
        <svg class="nav-ico" id="theme-ico" viewBox="0 0 24 24" aria-hidden="true"></svg>
      </button>
    </div>`;
  initNotifications();
  mountBellMorph();
  mountNavMorph(nav);
}

/**
 * Иконки ссылок оживают под курсором и при фокусе с клавиатуры.
 *
 * pointerenter/leave, а не mouseenter: на тач-экране pointerenter приходит
 * вместе с тапом, и иконка успевает отыграть до ухода на другую страницу.
 * focus/blur дублируют то же для тех, кто ходит табом, — иначе анимация
 * доставалась бы только мышке.
 */
function mountNavMorph(nav) {
  for (const link of nav.querySelectorAll(".nav-link[data-nav]")) {
    const set = NAV_ICONS[link.dataset.nav];
    const svg = link.querySelector(".nav-ico");
    if (!set || !svg) continue;
    const icon = createMorphIcon(svg, set, "rest");
    const wake = () => icon.to("hover");
    const rest = () => icon.to("rest");
    link.addEventListener("pointerenter", wake);
    link.addEventListener("pointerleave", rest);
    link.addEventListener("focus", wake);
    link.addEventListener("blur", rest);
  }
}

/**
 * Колокольчик перетекает idle ↔ unread. Морф ведёт СОСТОЯНИЕ (висят ли
 * непрочитанные), а не событие — за «дзынь» отвечает CSS-класс .is-ringing,
 * который ставит notifications.js.
 *
 * Слушаем badge, а не зовёмся из notifications.js: там ровно один источник
 * правды (renderBadge прячет/показывает .notif-badge), и подписка не заставляет
 * фичу знать про существование морфа.
 */
function mountBellMorph() {
  const svg = document.querySelector(".notif-bell");
  const badge = document.getElementById("notif-badge");
  if (!svg || !badge) return;

  const bell = createMorphIcon(svg, BELL_ICONS, "idle");
  const sync = () => bell.to(badge.hidden ? "idle" : "unread");

  // hidden — атрибут, поэтому ловится attributes-наблюдателем.
  new MutationObserver(sync).observe(badge, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  sync();
}
