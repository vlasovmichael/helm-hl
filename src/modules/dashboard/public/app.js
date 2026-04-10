// ─────────────────────────────────────────────────
//  HL Scanner Dashboard — frontend
// ─────────────────────────────────────────────────

const REFRESH_MS = 5_000;
let chart = null;
let lastSuccessAt = 0;

// ── Helpers ─────────────────────────────────────

function fmtUsd(n) {
  if (n == null || isNaN(n)) return "$—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtUsdSigned(n) {
  if (n == null || isNaN(n)) return "$0.00";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

// ── Chart setup ─────────────────────────────────

function initChart() {
  const ctx = document.getElementById("equity-chart").getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Equity",
          data: [],
          borderColor: "#5fffa7",
          backgroundColor: "rgba(95, 255, 167, 0.08)",
          borderWidth: 2,
          tension: 0.25,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: "#5fffa7",
          pointBorderColor: "#000",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0a0f0a",
          borderColor: "#143514",
          borderWidth: 1,
          titleColor: "#97fce4",
          bodyColor: "#5fffa7",
          callbacks: {
            label: (ctx) => `Equity: $${ctx.parsed.y.toFixed(4)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#4a8a7a", font: { family: "monospace", size: 10 } },
          grid: { color: "#143514", drawBorder: false },
        },
        y: {
          ticks: {
            color: "#4a8a7a",
            font: { family: "monospace", size: 10 },
            callback: (v) => `$${v.toFixed(2)}`,
          },
          grid: { color: "#143514", drawBorder: false },
        },
      },
    },
  });
}

// ── API ─────────────────────────────────────────

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

// ── Renderers ───────────────────────────────────

function renderHeader(status) {
  document.getElementById("equity-value").textContent = fmtUsd(status.equity);

  const deltaEl = document.getElementById("equity-delta");
  const profit = status.sessionProfit;
  if (status.sessionStartEquity > 0) {
    const pct = (profit / status.sessionStartEquity) * 100;
    deltaEl.textContent = `${fmtUsdSigned(profit)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) session`;
    deltaEl.className = `delta ${profit >= 0 ? "positive" : "negative"}`;
  } else {
    deltaEl.textContent = "—";
    deltaEl.className = "delta";
  }

  const pill = document.getElementById("mode-pill");
  pill.textContent = status.mode;
  pill.className = `status-pill ${status.mode === "PAPER" ? "paper" : ""}`;

  const uptimeH = (status.uptimeMin / 60).toFixed(1);
  document.getElementById("status-meta").textContent =
    `Uptime ${uptimeH}h · Available ${fmtUsd(status.available)}`;
}

function renderPosition(pos) {
  const container = document.getElementById("position-container");
  if (!pos) {
    container.innerHTML =
      '<div class="empty-state">No active position — bot is IDLE</div>';
    return;
  }

  container.innerHTML = `
    <div class="pos-grid">
      <div class="pos-cell">
        <div class="pos-label">Coin</div>
        <div class="pos-value coin">#${pos.coin}</div>
      </div>
      <div class="pos-cell">
        <div class="pos-label">Size</div>
        <div class="pos-value">${fmtUsd(pos.sizeUsd)}</div>
      </div>
      <div class="pos-cell">
        <div class="pos-label">Entry</div>
        <div class="pos-value">$${pos.entryPrice}</div>
      </div>
      <div class="pos-cell">
        <div class="pos-label">APY · Held</div>
        <div class="pos-value">${fmtPct(pos.entryApy)} · ${pos.heldHours.toFixed(1)}h</div>
      </div>
    </div>
  `;
}

function renderChart(history) {
  if (!chart) return;

  const points = history.points || [];
  if (points.length === 0) {
    chart.data.labels = ["start"];
    chart.data.datasets[0].data = [history.baseline || 0];
    chart.update();
    return;
  }

  chart.data.labels = points.map((p) => fmtTime(p.ts));
  chart.data.datasets[0].data = points.map((p) => p.equity);
  chart.update();
}

function renderFooter() {
  const ageSec = (Date.now() - lastSuccessAt) / 1000;
  const footer = document.getElementById("footer");
  if (lastSuccessAt === 0) {
    footer.textContent = "Connecting…";
  } else if (ageSec > 15) {
    footer.innerHTML = `<span class="stale">⚠ Last update ${ageSec.toFixed(0)}s ago</span>`;
  } else {
    footer.textContent = `Auto-refresh every ${REFRESH_MS / 1000}s · Last ${ageSec.toFixed(0)}s ago`;
  }
}

function renderTax(tax) {
  if (!tax) return;
  document.getElementById("tax-year").textContent =
    tax.year || new Date().getFullYear();

  // Если данных еще нет, покажет 0.00
  const costs = tax.totalCostsPLN || 0;
  const revenue = tax.totalRevenuePLN || 0;
  const profit = tax.netProfitPLN || 0;

  document.getElementById("tax-costs").textContent = `${costs.toFixed(2)} PLN`;
  document.getElementById("tax-revenue").textContent =
    `${revenue.toFixed(2)} PLN`;

  const profitEl = document.getElementById("tax-profit");
  profitEl.textContent = `${profit >= 0 ? "+" : ""}${profit.toFixed(2)} PLN`;
  profitEl.style.color = profit >= 0 ? "var(--green)" : "var(--red)";

  // Считаем примерный налог 19% только если есть прибыль
  const estTax = profit > 0 ? profit * 0.19 : 0;
  document.getElementById("tax-est").textContent = `${estTax.toFixed(2)} PLN`;
}

// ── Main loop ───────────────────────────────────

async function tick() {
  try {
    const [status, history, tax] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/history"),
      fetchJson("/api/tax-summary"),
    ]);
    renderHeader(status);
    renderPosition(status.activePosition);
    renderChart(history);
    renderTax(tax);
    lastSuccessAt = Date.now();
  } catch (err) {
    console.error("[Dashboard]", err);
  }
  renderFooter();
}

initChart();
tick();
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1_000);
