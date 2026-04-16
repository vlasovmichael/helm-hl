// ─────────────────────────────────────────────────
//  HL Scanner Dashboard — Stripe-style Frontend
// ─────────────────────────────────────────────────

function formatUptime(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
  }
  if (minutes < 10080) {
    const d = Math.floor(minutes / 1440);
    const h = Math.round((minutes % 1440) / 60);
    return h > 0 ? `${d}д ${h}ч` : `${d}д`;
  }
  const w = Math.floor(minutes / 10080);
  const d = Math.round((minutes % 10080) / 1440);
  return d > 0 ? `${w}н ${d}д` : `${w}н`;
}

const REFRESH_MS = 5_000;
let chart = null;
let lastSuccessAt = 0;
let currentRangeHours = 24;

// ── Range Selectors ─────────────────────────────

function setupRangeButtons() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const active = document.querySelector(".range-btn.active");
      if (active) active.classList.remove("active");
      btn.classList.add("active");
      currentRangeHours = parseInt(btn.dataset.hours, 10);
      tick(); // Немедленно обновляем график
    });
  });
}

// ── Helpers ─────────────────────────────────────

function fmtUsd(n) {
  if (n == null || isNaN(n)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function fmtUsdSigned(n) {
  if (n == null || isNaN(n)) return "$0.00";
  const sign = n >= 0 ? "+" : "-";
  const val = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Math.abs(n));
  return `${sign}${val}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "0.00%";
  return `${n.toFixed(2)}%`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (currentRangeHours <= 24) {
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// ── Chart setup ─────────────────────────────────

function initChart() {
  const canvas = document.getElementById("equity-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, "rgba(99, 91, 255, 0.12)");
  gradient.addColorStop(1, "rgba(99, 91, 255, 0)");

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Equity",
          data: [],
          borderColor: "#635BFF",
          backgroundColor: gradient,
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 10,
          pointBackgroundColor: "#635BFF",
          pointBorderColor: "#FFFFFF",
          pointBorderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: {
        intersect: false,
        mode: "index",
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#131316",
          borderColor: "#27272A",
          borderWidth: 1,
          titleColor: "#A1A1AA",
          bodyColor: "#FFFFFF",
          titleFont: { size: 14, family: "Inter" },
          bodyFont: { size: 14, weight: "600", family: "SF Mono" },
          padding: 12,
          displayColors: false,
          callbacks: {
            label: (ctx) => `Equity: $${ctx.parsed.y.toLocaleString()}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#71717A",
            font: { family: "Inter", size: 14 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
          },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: {
            color: "#71717A",
            font: { family: "Inter", size: 14 },
            callback: (v) => `$${v.toLocaleString()}`,
            maxTicksLimit: 6,
          },
          grid: { color: "#1F1F23" },
          border: { display: false },
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

function renderBans(status) {
  const container = document.getElementById("bans-container");
  if (!status.runtimeBans || status.runtimeBans.length === 0) {
    container.innerHTML =
      '<div class="empty-state" style="font-size:14px;">No active restrictions</div>';
    return;
  }

  container.innerHTML = status.runtimeBans
    .map(
      (coin) => `
        <div style="display:inline-block; background:rgba(239, 68, 68, 0.1); color:var(--red); border:1px solid rgba(239, 68, 68, 0.2); padding:4px 10px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:600; margin:0 8px 8px 0;">
            #${coin}
        </div>
    `,
    )
    .join("");
}

function renderActivity(history) {
  const container = document.getElementById("activity-container");
  const points = [...(history.points || [])].reverse().slice(0, 5);

  if (points.length === 0) {
    container.innerHTML =
      '<div class="empty-state" style="font-size:14px;">Waiting for first trade...</div>';
    return;
  }

  container.innerHTML = points
    .map(
      (p) => `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #1F1F23; font-size:12px;">
            <div style="font-family:var(--font-mono)">
                <span style="color:var(--text-secondary)">${fmtTime(p.ts)}</span>
                <span style="color:var(--accent); font-weight:600; margin-left:8px;">#${p.coin}</span>
                <span style="color:var(--text-secondary); margin-left:4px;">${p.reason}</span>
            </div>
            <div style="font-family:var(--font-mono); font-weight:600; color:${p.pnl >= 0 ? "var(--green)" : "var(--red)"}">
                ${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}
            </div>
        </div>
    `,
    )
    .join("");
}

function renderHeader(status) {
  document.getElementById("equity-value").textContent = fmtUsd(status.equity);

  const deltaEl = document.getElementById("equity-delta");
  const profit = status.sessionProfit;
  if (status.sessionStartEquity > 0) {
    const pct = (profit / status.sessionStartEquity) * 100;
    deltaEl.textContent = `${fmtUsdSigned(profit)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) session`;
    deltaEl.className = `delta ${profit >= 0 ? "positive" : "negative"}`;
  }

  const pill = document.getElementById("mode-pill");
  pill.textContent = status.mode;
  pill.className = `status-pill ${status.mode === "PRODUCTION" ? "prod" : ""}`;

  document.getElementById("uptime-val").textContent = `Uptime: ${formatUptime(status.uptimeMin)}`;
  document.getElementById("available-val").textContent =
    `Available: ${fmtUsd(status.available)}`;
}

function renderPosition(pos) {
  const container = document.getElementById("position-container");
  if (!pos) {
    container.innerHTML =
      '<div class="empty-state">No active positions — bot is IDLE</div>';
    return;
  }

  container.innerHTML = `
        <div class="data-grid">
            <div class="grid-item">
                <div class="item-label">Coin</div>
                <div class="item-value highlight">#${pos.coin}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Size</div>
                <div class="item-value">${fmtUsd(pos.sizeUsd)}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Entry</div>
                <div class="item-value">$${pos.entryPrice}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">APY · Held</div>
                <div class="item-value">${fmtPct(pos.entryApy)} · ${pos.heldHours.toFixed(1)}h</div>
            </div>
        </div>
    `;
}

function renderChart(history) {
  if (!chart) return;
  const points = history.points || [];
  if (points.length === 0) return;

  chart.data.labels = points.map((p) => fmtTime(p.ts));
  chart.data.datasets[0].data = points.map((p) => p.equity);
  chart.update();
}

function renderTax(tax) {
  if (!tax) return;
  document.getElementById("tax-year").textContent = tax.year || 2026;

  const costs = tax.totalCostsPLN || 0;
  const revenue = tax.totalRevenuePLN || 0;
  const profit = tax.netProfitPLN || 0;
  const estTax = profit > 0 ? profit * 0.19 : 0;

  document.getElementById("tax-costs").textContent =
    `${costs.toLocaleString()} PLN`;
  document.getElementById("tax-revenue").textContent =
    `${revenue.toLocaleString()} PLN`;

  const profitEl = document.getElementById("tax-profit");
  profitEl.textContent = `${profit >= 0 ? "+" : ""}${profit.toLocaleString()} PLN`;
  profitEl.style.color = profit >= 0 ? "var(--green)" : "var(--red)";

  document.getElementById("tax-est").textContent =
    `${estTax.toLocaleString()} PLN`;
}

function renderFooter() {
  const footer = document.getElementById("footer-status");
  if (lastSuccessAt === 0) {
    footer.textContent = "Connecting to core terminal...";
    return;
  }

  const ageSec = Math.floor((Date.now() - lastSuccessAt) / 1000);
  if (ageSec > 15) {
    footer.innerHTML = `<span class="stale-warning">⚠ Core connection stale (${ageSec}s ago)</span>`;
  } else {
    footer.textContent = `Syncing live · Refreshing in ${Math.max(0, Math.floor((REFRESH_MS - (Date.now() % REFRESH_MS)) / 1000))}s`;
  }
}

// ── Main loop ───────────────────────────────────

async function tick() {
  try {
    const [status, history, tax] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson(`/api/history?hours=${currentRangeHours}`),
      fetchJson("/api/tax-summary"),
    ]);
    renderHeader(status);
    renderPosition(status.activePosition);
    renderChart(history);
    renderTax(tax);
    renderActivity(history);
    renderBans(status);
    lastSuccessAt = Date.now();
  } catch (err) {
    console.error("[Dashboard]", err);
  }
  renderFooter();
}

setupRangeButtons();
initChart();
tick();
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1000);
