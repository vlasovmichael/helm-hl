import "./src/styles/ledger.scss";
// ─────────────────────────────────────────────────
//  ledger.html — таблицу месяцев рендерит inline-скрипт страницы (/api/ledger).
//  Отсюда: Recent Activity + Tax Summary (tick), trade-модалка, bans-strip.
//  Тема: inline-IIFE гасит FOUC, bindTheme() вешает клики на topnav-свитчер.
// ─────────────────────────────────────────────────

import {
  REFRESH_MS,
  initWebSocket,
  markSuccess,
  startFooterTimer,
  bindTheme,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { fetchJson } from "./src/net/api.js";
import { initModals } from "./src/features/modals.js";
import { renderTax } from "./src/features/pnlInsights.js";
import { renderBans } from "./src/features/accountStatus.js";

function onStatus(data) {
  renderBans(data);
}

async function tick() {
  // Recent Activity переехала на главную (index) — здесь остаётся только Tax Summary.
  const [taxR] = await Promise.allSettled([fetchJson("/api/tax-summary")]);
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
