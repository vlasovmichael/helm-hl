import "./src/styles/statistics.scss";
// ─────────────────────────────────────────────────
//  strategies.html — таблица стратегий, Performance-график (equity),
//  Chill Boy, P&L Summary + Insights, Live Logs.
//  Радар-фичи/модалки сюда не грузятся.
// ─────────────────────────────────────────────────

import {
  REFRESH_MS,
  fmtTime,
  getRangeHours,
  bindTheme,
  bindRange,
  initWebSocket,
  markSuccess,
  startFooterTimer,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { fetchJson } from "./src/net/api.js";
import {
  initEquityChart,
  applyChartTheme,
  renderEquityPill,
  setEquityData,
  showChartLoader,
  hideChartLoader,
} from "./src/charts/equityChart.js";
import { renderStrategies } from "./src/features/strategies.js";
import {
  renderChillBoy,
  renderChillBoyCard,
} from "./src/features/chillBoy.js";
import {
  setPnlSummary,
  setInsights,
  initPnlInsights,
} from "./src/features/pnlInsights.js";
import {
  ingestLogs,
  bindLogsUi,
  fetchInitialLogs,
} from "./src/features/logs.js";

function onStatus(data) {
  renderStrategies(data.strategies);
  renderChillBoy(data.chillBoy);
  renderChillBoyCard(data.chillBoy);
}

async function tick() {
  const [historyR, pnlR, insightsR, stratR] = await Promise.allSettled([
    fetchJson(`/api/history?hours=${getRangeHours()}`),
    fetchJson("/api/pnl-summary"),
    fetchJson("/api/insights"),
    fetchJson("/api/strategies"),
  ]);
  if (stratR.status === "fulfilled" && stratR.value) {
    renderStrategies(stratR.value);
  }
  if (pnlR.status === "fulfilled") setPnlSummary(pnlR.value);
  if (insightsR.status === "fulfilled") setInsights(insightsR.value);
  if (historyR.status === "fulfilled" && historyR.value?.points) {
    const pts = historyR.value.points;
    const seen = new Set();
    const data = [];
    for (const p of pts) {
      const t = Math.floor(p.ts / 1000);
      if (seen.has(t)) continue;
      seen.add(t);
      data.push({ time: t, value: Number(p.equity) });
    }
    data.sort((a, b) => a.time - b.time);
    setEquityData(data);
    renderEquityPill();
    hideChartLoader();
  }
  markSuccess();
}

// ── Bootstrap ──
mountTopnav("statistics");
bindTheme([applyChartTheme]);
bindRange(() => {
  showChartLoader();
  tick();
});
initWebSocket({
  onStatus,
  onLogsInit: (entries) => ingestLogs(entries, true),
  onLog: (entry) => ingestLogs([entry], false),
});
initEquityChart();
bindLogsUi();
fetchInitialLogs();
initPnlInsights({ fmtTime });
tick();
setInterval(tick, REFRESH_MS);
startFooterTimer();
