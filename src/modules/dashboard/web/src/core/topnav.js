// ─────────────────────────────────────────────────
//  Topnav — единый верхний бар для всех страниц (index / statistics / ledger).
//  Раньше один и тот же <nav> копировался в три HTML — рассинхронизировался при
//  каждой правке. Теперь разметка живёт здесь, страница лишь кладёт пустой
//  placeholder <nav class="topnav" id="topnav"> и зовёт mountTopnav('<key>').
//  Тема-свитчер всё ещё цепляется отдельным bindTheme() ПОСЛЕ монтирования.
// ─────────────────────────────────────────────────

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
};

const LINKS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "statistics", href: "/statistics.html", label: "Statistics" },
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
 * @param {'dashboard'|'statistics'|'ledger'} active
 */
export function mountTopnav(active) {
  const nav = document.getElementById("topnav");
  if (!nav) return;
  nav.setAttribute("aria-label", "Primary");
  nav.innerHTML = `
    <a class="topnav-brand" href="/">Helm</a>
    <div class="topnav-links">${LINKS.map((l) => navLink(l, active)).join("")}</div>
    <div class="topnav-right">
      <div class="theme-switcher" role="group" aria-label="Theme">
        <button class="theme-btn" data-theme="auto" title="Auto (system)">Auto</button>
        <button class="theme-btn" data-theme="light" title="Light">Light</button>
        <button class="theme-btn" data-theme="dark" title="Dark">Dark</button>
      </div>
    </div>`;
}
