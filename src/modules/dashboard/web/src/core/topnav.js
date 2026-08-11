// ─────────────────────────────────────────────────
//  Topnav — единый верхний бар для всех страниц (index / statistics / ledger).
//  Раньше один и тот же <nav> копировался в три HTML — рассинхронизировался при
//  каждой правке. Теперь разметка живёт здесь, страница лишь кладёт пустой
//  placeholder <nav class="topnav" id="topnav"> и зовёт mountTopnav('<key>').
//  Тема-свитчер всё ещё цепляется отдельным bindTheme() ПОСЛЕ монтирования.
// ─────────────────────────────────────────────────

import { initNotifications } from "../features/notifications.js";

const ICONS = {
  dashboard: `
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />`,
  statistics: `
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="1" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="1" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="23" y2="12" />`,
  ledger: `
    <path d="M4 5a2 2 0 0 1 2-2h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2z" />
    <line x1="4" y1="17" x2="19" y2="17" />
    <line x1="9" y1="3" x2="9" y2="21" />`,
  lab: `
    <path d="M9 3h6M10 3v6.5L5.5 17a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9.5V3" />
    <line x1="8" y1="14" x2="16" y2="14" />`,
  orderbook: `
    <line x1="4" y1="6" x2="13" y2="6" />
    <line x1="4" y1="10" x2="17" y2="10" />
    <line x1="4" y1="14" x2="10" y2="14" />
    <line x1="4" y1="18" x2="15" y2="18" />`,
  journal: `
    <path d="M5 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <line x1="7" y1="7" x2="13" y2="7" />
    <path d="M7 14l2.5-2.5L12 14l3-3.5" />`,
  oi: `
    <line x1="3" y1="21" x2="21" y2="21" />
    <line x1="3" y1="21" x2="3" y2="3" />
    <rect x="6" y="12" width="3" height="6" rx="0.5" />
    <rect x="11" y="8" width="3" height="10" rx="0.5" />
    <rect x="16" y="4" width="3" height="14" rx="0.5" />`,
};

const LINKS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  // Order Book остаётся как страница (/orderbook.html), но ссылку из навбара
  // убрали — стакан оператору тяжело читается, не нужен на видном месте (2026-06-28).
  { key: "statistics", href: "/statistics.html", label: "Statistics" },
  { key: "oi", href: "/oi.html", label: "OI", title: "История open interest по всем монетам (ΔOI 24ч/1ч)" },
  { key: "lab", href: "/lab.html", label: "Lab", title: "Research: реестр стратегий + закрытые вердикты" },
  { key: "journal", href: "/journal.html", label: "Journal", title: "Журнал чтения графика — разметка монеты на сутки вперёд" },
  { key: "ledger", href: "/ledger.html", label: "Ledger", title: "Monthly P&L ledger" },
];

const navLink = (l, active) => {
  const isActive = l.key === active;
  return `
    <a class="nav-link${isActive ? " active" : ""}" href="${l.href}"${
      isActive ? ' aria-current="page"' : ""
    }${l.title ? ` title="${l.title}"` : ""}>
      <svg class="nav-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[l.key]}</svg>
      ${l.label}
    </a>`;
};

/**
 * Рендерит topnav в placeholder `#topnav`. Вызывать ДО bindTheme() — иначе
 * .theme-btn ещё не существуют в DOM.
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
      <div class="theme-switcher" role="group" aria-label="Theme">
        <button class="theme-btn" data-theme="auto" title="Auto (system)">Auto</button>
        <button class="theme-btn" data-theme="light" title="Light">Light</button>
        <button class="theme-btn" data-theme="dark" title="Dark">Dark</button>
      </div>
    </div>`;
  initNotifications();
}
