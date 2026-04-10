// ─────────────────────────────────────────────────
//  HL Scanner Dashboard — Stripe-style Frontend
// ─────────────────────────────────────────────────

const REFRESH_MS = 5_000;
let chart = null;
let lastSuccessAt = 0;

// ── Helpers ─────────────────────────────────────

function fmtUsd(n) {
    if (n == null || isNaN(n)) return "$0.00";
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtUsdSigned(n) {
    if (n == null || isNaN(n)) return "$0.00";
    const sign = n >= 0 ? "+" : "-";
    const val = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
    return `${sign}${val}`;
}

function fmtPct(n) {
    if (n == null || isNaN(n)) return "0.00%";
    return `${n.toFixed(2)}%`;
}

function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("en-GB", { hour: '2-digit', minute: '2-digit' });
}

// ── Chart setup ─────────────────────────────────

function initChart() {
    const canvas = document.getElementById("equity-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    
    // Gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(99, 91, 255, 0.12)');
    gradient.addColorStop(1, 'rgba(99, 91, 255, 0)');

    chart = new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [{
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
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            interaction: {
                intersect: false,
                mode: 'index',
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#131316",
                    borderColor: "#27272A",
                    borderWidth: 1,
                    titleColor: "#A1A1AA",
                    bodyColor: "#FFFFFF",
                    titleFont: { size: 12, family: "Inter" },
                    bodyFont: { size: 13, weight: '600', family: "SF Mono" },
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
                        font: { family: "SF Mono", size: 10 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 8
                    },
                    grid: { display: false },
                    border: { display: false }
                },
                y: {
                    ticks: {
                        color: "#71717A",
                        font: { family: "SF Mono", size: 10 },
                        callback: (v) => `$${v.toLocaleString()}`,
                        maxTicksLimit: 6
                    },
                    grid: { color: "#1F1F23" },
                    border: { display: false }
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
    }

    const pill = document.getElementById("mode-pill");
    pill.textContent = status.mode;
    pill.className = `status-pill ${status.mode === "PRODUCTION" ? "prod" : ""}`;

    const uptimeH = (status.uptimeMin / 60).toFixed(1);
    document.getElementById("uptime-val").textContent = `Uptime: ${uptimeH}h`;
    document.getElementById("available-val").textContent = `Available: ${fmtUsd(status.available)}`;
}

function renderPosition(pos) {
    const container = document.getElementById("position-container");
    if (!pos) {
        container.innerHTML = '<div class="empty-state">No active positions — bot is IDLE</div>';
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

    document.getElementById("tax-costs").textContent = `${costs.toLocaleString()} PLN`;
    document.getElementById("tax-revenue").textContent = `${revenue.toLocaleString()} PLN`;
    
    const profitEl = document.getElementById("tax-profit");
    profitEl.textContent = `${profit >= 0 ? "+" : ""}${profit.toLocaleString()} PLN`;
    profitEl.style.color = profit >= 0 ? "var(--green)" : "var(--red)";
    
    document.getElementById("tax-est").textContent = `${estTax.toLocaleString()} PLN`;
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
setInterval(renderFooter, 1000);
