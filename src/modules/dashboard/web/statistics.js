import "./src/styles/statistics.scss";
// ─────────────────────────────────────────────────
//  Statistics — P&L Summary, Insights, график Performance, Live Logs.
//
//  Страница живёт под роутером: разметку рисует render(), а всё живое — тик,
//  сокет, секундный футер, наблюдатель всплытия и сам график — гасит
//  возвращённая им остановка.
// ─────────────────────────────────────────────────

import { mountPageHeader } from "./src/core/pageHeader.js";
import {
  REFRESH_MS,
  fmtTime,
  getRangeHours,
  onThemeChange,
  bindRange,
  initWebSocket,
  markSuccess,
  startFooterTimer,
} from "./src/core/shell.js";
import { initReveal } from "./src/core/reveal.js";
import { fetchJson } from "./src/net/api.js";
import {
  initEquityChart,
  destroyEquityChart,
  applyChartTheme,
  renderEquityPill,
  setEquityData,
  showChartLoader,
  hideChartLoader,
} from "./src/charts/equityChart.js";
import {
  setPnlSummary,
  setInsights,
  initPnlInsights,
  syncInsightsUi,
} from "./src/features/pnlInsights.js";
import {
  ingestLogs,
  bindLogsUi,
  fetchInitialLogs,
} from "./src/features/logs.js";

// Экран жив, пока его не сменили: ответы, приехавшие после ухода, писать некуда.
let alive = false;

async function tick() {
  // Strategies переехала на Lab — здесь её больше не грузим (/api/strategies).
  const [historyR, pnlR, insightsR] = await Promise.allSettled([
    fetchJson(`/api/history?hours=${getRangeHours()}`),
    fetchJson("/api/pnl-summary"),
    fetchJson("/api/insights"),
  ]);
  if (!alive) return;
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

function view() {
  return `
    <header id="page-header"></header>

    <section class="card" id="sec-pnl">
      <div class="card-header">
        <div class="card-title">P&amp;L Summary</div>
        <div class="seg" id="pnl-periods">
          <button class="seg__btn active" type="button" data-period="today">Today</button>
          <button class="seg__btn" type="button" data-period="yesterday">Yesterday</button>
          <button class="seg__btn" type="button" data-period="d7">7d</button>
          <button class="seg__btn" type="button" data-period="d30">30d</button>
          <button class="seg__btn" type="button" data-period="all">All</button>
        </div>
      </div>
      <div id="pnl-summary-container" class="u-rel">
        <div class="card-skeleton" id="pnl-skeleton">
          <div class="skeleton-row skeleton-row--hero"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
        </div>
        <div class="pnl-hero">
          <div class="pnl-hero-main">
            <div class="item-label">Realized P&amp;L</div>
            <div class="pnl-hero-value" id="pnl-total">$0.00</div>
            <div class="pnl-hero-sub" id="pnl-stats">
              — trades · — win rate
            </div>
          </div>
          <div class="pnl-hero-side">
            <div class="pnl-mini">
              <div class="item-label">Unrealized (now)</div>
              <div class="pnl-mini-value" id="pnl-unrealized">$0.00</div>
            </div>
            <div class="pnl-mini">
              <div class="item-label">Slot utilization</div>
              <div class="pnl-mini-value" id="pnl-utilization">—</div>
            </div>
            <div class="pnl-mini">
              <div class="item-label">Funding</div>
              <div class="pnl-mini-value" id="pnl-funding">—</div>
            </div>
          </div>
        </div>
        <div class="pnl-grid">
          <div class="grid-item">
            <div class="item-label">Avg trade</div>
            <div class="item-value" id="pnl-avg">$0.00</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Best trade</div>
            <div class="item-value" id="pnl-best">$0.00</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Worst trade</div>
            <div class="item-value" id="pnl-worst">$0.00</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Wins / Losses</div>
            <div class="item-value" id="pnl-wl">—</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Expectancy / trade</div>
            <div class="item-value" id="pnl-expectancy">—</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Payoff (avgW/avgL)</div>
            <div class="item-value" id="pnl-payoff">—</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Max drawdown</div>
            <div class="item-value" id="pnl-maxdd">—</div>
          </div>
          <div class="grid-item">
            <div class="item-label">Fees paid</div>
            <div class="item-value" id="pnl-fees">—</div>
          </div>
        </div>
        <div class="pnl-strategy" id="pnl-strategy">
          <div class="empty-state">No trades in this period</div>
        </div>
      </div>
    </section>

    <section class="card" id="sec-insights">
      <div class="card-header">
        <div
          class="card-title"
          data-card="Lifetime cuts: per-coin, long/short and by strategy (with expectancy/payoff), plus a multi-year daily P&amp;L heatmap (paged by year). Independent of the P&amp;L period selector — always all-time."
        >
          Insights
        </div>
        <div class="seg" id="insights-tabs">
          <button class="seg__btn active" type="button" data-tab="per-coin">
            Per-coin
          </button>
          <button class="seg__btn" type="button" data-tab="breakdown">Breakdown</button>
          <button class="seg__btn" type="button" data-tab="exits">Exit quality</button>
          <button class="seg__btn" type="button" data-tab="heatmap">Heatmap</button>
        </div>
      </div>
      <div id="insights-container" class="u-rel">
        <div class="card-skeleton" id="insights-skeleton">
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
        </div>
        <div class="insights-pane" id="insights-pane-per-coin">
          <div class="per-coin-meta" id="per-coin-meta">
            — coins · all-time
          </div>
          <div class="per-coin-table-wrap">
            <table class="table table--compact table--sticky-head per-coin-table">
              <thead>
                <tr>
                  <th data-sort="coin" class="sortable">Coin</th>
                  <th data-sort="trades" class="sortable num">Trades</th>
                  <th data-sort="pnl" class="num sortable is-sorted">
                    P&amp;L
                  </th>
                  <th data-sort="winRate" class="sortable num">Win%</th>
                  <th data-sort="avg" class="sortable num">Avg</th>
                  <th data-sort="lastClosedAt" class="sortable num">Last</th>
                </tr>
              </thead>
              <tbody id="per-coin-tbody"></tbody>
            </table>
          </div>
        </div>
        <!-- 🚨 Панели прячутся инлайном, а не классом: видимость ведёт JS через
             style.display, и класс не сбросился бы (см. core/_utilities.scss). -->
        <div
          class="insights-pane"
          id="insights-pane-breakdown"
          style="display: none"
        >
          <div class="breakdown-block">
            <div class="breakdown-title">Long vs Short</div>
            <table class="table table--compact breakdown-table">
              <thead>
                <tr>
                  <th>Side</th>
                  <th class="num">Trades</th>
                  <th class="num">Win%</th>
                  <th class="num">P&amp;L</th>
                  <th class="num">Expectancy</th>
                  <th class="num">Payoff</th>
                </tr>
              </thead>
              <tbody id="breakdown-side-tbody"></tbody>
            </table>
          </div>
          <div class="breakdown-block">
            <div class="breakdown-title">By strategy</div>
            <table class="table table--compact breakdown-table">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th class="num">Trades</th>
                  <th class="num">Win%</th>
                  <th class="num">P&amp;L</th>
                  <th class="num">Expectancy</th>
                  <th class="num">Payoff</th>
                </tr>
              </thead>
              <tbody id="breakdown-strategy-tbody"></tbody>
            </table>
          </div>
        </div>
        <div
          class="insights-pane"
          id="insights-pane-exits"
          style="display: none"
        >
          <div class="exits-meta" id="exits-meta">— · loading</div>
          <div class="exits-cards" id="exits-cards"></div>
          <div class="per-coin-table-wrap">
            <table class="table table--compact table--sticky-head per-coin-table exits-table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Side</th>
                  <th class="num">P&amp;L</th>
                  <th class="num" data-card="Max Favorable Excursion — best unrealized gain during the trade">MFE</th>
                  <th class="num" data-card="Max Adverse Excursion — worst unrealized loss you sat through">MAE</th>
                  <th class="num" data-card="realized ÷ MFE — how much of the available move you captured">Capture</th>
                </tr>
              </thead>
              <tbody id="exits-tbody"></tbody>
            </table>
          </div>
        </div>
        <div
          class="insights-pane"
          id="insights-pane-heatmap"
          style="display: none"
        >
          <div class="heatmap-meta" id="heatmap-meta">— · loading</div>
          <div class="heatmap-grid" id="heatmap-grid"></div>
          <div class="heatmap-legend">
            <span>Loss</span>
            <span class="heatmap-cell loss-strong"></span>
            <span class="heatmap-cell loss-normal"></span>
            <span class="heatmap-cell loss-weak"></span>
            <span class="heatmap-cell empty"></span>
            <span class="heatmap-cell win-weak"></span>
            <span class="heatmap-cell win-normal"></span>
            <span class="heatmap-cell win-strong"></span>
            <span>Win</span>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-title">Performance</div>
        <div class="equity-pill" id="equity-pill" hidden>
          <span class="equity-pill-value" id="equity-pill-value">$0.00</span>
          <span class="equity-pill-delta" id="equity-pill-delta">+0.00%</span>
        </div>
        <div class="seg">
          <button class="seg__btn" type="button" data-hours="1">1h</button>
          <button class="seg__btn active" type="button" data-hours="24">24h</button>
          <button class="seg__btn" type="button" data-hours="168">7d</button>
          <button class="seg__btn" type="button" data-hours="720">30d</button>
          <button class="seg__btn" type="button" data-hours="0">All</button>
        </div>
      </div>
      <div class="chart-container" id="chart-container">
        <div id="equity-chart"></div>
        <div class="local-loader" id="chart-loader">
          <div class="loader-spinner"></div>
        </div>
      </div>
    </section>

    <section class="card" id="sec-logs">
      <div class="card-header">
        <div class="card-title">Live Logs</div>
        <div class="logs-controls">
          <input
            type="search"
            id="logs-search"
            class="field"
            placeholder="Search logs"
            aria-label="Search logs"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="seg logs-filters" id="logs-filters" role="group" aria-label="Log level">
            <button class="seg__btn logs-filter-btn active" type="button" data-level="all">All</button>
            <button class="seg__btn logs-filter-btn" type="button" data-level="info">Info</button>
            <button class="seg__btn logs-filter-btn" type="button" data-level="warn">Warn</button>
            <button class="seg__btn logs-filter-btn" type="button" data-level="error">Err</button>
          </div>
          <button
            class="btn btn--icon logs-pause-btn"
            id="logs-pause"
            type="button"
            data-card="Pause autoscroll"
            aria-label="Pause autoscroll"
          >
            <svg class="nav-ico" id="logs-pause-ico" viewBox="0 0 24 24" aria-hidden="true"></svg>
          </button>
        </div>
      </div>
      <div class="logs-viewport" id="logs-viewport">
        <div class="logs-empty" id="logs-empty"></div>
        <div class="logs-list" id="logs-list"></div>
      </div>
      <div class="logs-meta" id="logs-meta">
        <span id="logs-count">0 lines</span>
        <span id="logs-status">live</span>
      </div>
    </section>`;
}

export default {
  title: "Statistics · Helm",
  nav: "statistics",

  render(outlet) {
    alive = true;
    outlet.innerHTML = view();

    mountPageHeader({
      status: true,
      eyebrow: "Statistics",
      title: "Lifetime performance",
    });

    bindRange(() => {
      showChartLoader();
      tick();
    });
    const stopWs = initWebSocket({
      onLogsInit: (entries) => ingestLogs(entries, true),
      onLog: (entry) => ingestLogs([entry], false),
    });
    const offTheme = onThemeChange(applyChartTheme);

    initEquityChart();
    bindLogsUi();
    fetchInitialLogs();
    initPnlInsights({ fmtTime });
    // Период и вкладка помнятся между заходами — разметка свежая, вид надо свести.
    syncInsightsUi();

    tick();
    const ticker = setInterval(tick, REFRESH_MS);
    const stopFooter = startFooterTimer();
    const stopReveal = initReveal();

    return () => {
      alive = false;
      clearInterval(ticker);
      stopFooter();
      stopWs();
      stopReveal();
      offTheme();
      destroyEquityChart();
    };
  },
};
