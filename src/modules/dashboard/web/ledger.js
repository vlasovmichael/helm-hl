// ─────────────────────────────────────────────────
//  ledger.html — таблицу месяцев рендерит inline-скрипт страницы (/api/ledger).
//  Отсюда: Recent Activity + Tax Summary (tick), trade-модалка, bans-strip.
//  Тема: inline-IIFE гасит FOUC, bindTheme() вешает клики на topnav-свитчер.
// ─────────────────────────────────────────────────

import {
  REFRESH_MS,
  getRangeHours,
  initWebSocket,
  markSuccess,
  startFooterTimer,
  bindTheme,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { fetchJson } from "./src/net/api.js";
import { initModals, renderActivity } from "./src/features/modals.js";
import { renderTax } from "./src/features/pnlInsights.js";
import { renderBans } from "./src/features/accountStatus.js";

function onStatus(data) {
  renderBans(data);
}

async function tick() {
  const [activityR, taxR] = await Promise.allSettled([
    fetchJson(`/api/activity?hours=${getRangeHours()}&limit=10`),
    fetchJson("/api/tax-summary"),
  ]);
  if (activityR.status === "fulfilled") renderActivity(activityR.value);
  if (taxR.status === "fulfilled") renderTax(taxR.value);
  markSuccess();
}

// ── Bootstrap ──
mountTopnav("ledger");
bindTheme();
initModals();
initWebSocket({ onStatus });
tick();
setInterval(tick, REFRESH_MS);
startFooterTimer();
