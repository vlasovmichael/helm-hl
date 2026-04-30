// ─────────────────────────────────────────────────
//  HL Scanner Dashboard — Frontend
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
let chartLoaded = false;
let activityLoaded = false;

// ── Theme ───────────────────────────────────────

const THEME_KEY = 'hl-scanner-theme';

function getStoredTheme() {
  return localStorage.getItem(THEME_KEY) || 'auto';
}

function applyTheme(mode) {
  const root = document.documentElement;
  const resolved =
    mode === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (mode === 'light' ? 'light' : 'dark');
  root.setAttribute('data-theme', resolved);
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === mode);
  });
  if (chart) {
    applyChartTheme();
    chart.update('none');
  }
}

function setupThemeSwitcher() {
  applyTheme(getStoredTheme());
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.dataset.theme;
      localStorage.setItem(THEME_KEY, mode);
      applyTheme(mode);
    });
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getStoredTheme() === 'auto') applyTheme('auto');
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── Range Selectors ─────────────────────────────

function setupRangeButtons() {
  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const active = document.querySelector('.range-btn.active');
      if (active) active.classList.remove('active');
      btn.classList.add('active');
      currentRangeHours = parseInt(btn.dataset.hours, 10);
      // При смене окна показываем лоадер заново для chart + activity
      chartLoaded = false;
      activityLoaded = false;
      showChartLoader();
      showActivitySkeleton();
      tick();
    });
  });
}

// ── Local loaders ───────────────────────────────

function showChartLoader() {
  const el = document.getElementById('chart-loader');
  if (el) el.classList.remove('hidden');
}
function hideChartLoader() {
  const el = document.getElementById('chart-loader');
  if (el) el.classList.add('hidden');
}
function showActivitySkeleton() {
  const c = document.getElementById('activity-container');
  if (!c) return;
  c.innerHTML = `
    <div class="activity-skeleton">
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
    </div>
  `;
}

// ── Helpers ─────────────────────────────────────

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n);
}

function fmtUsdSigned(n) {
  if (n == null || isNaN(n)) return '$0.00';
  const sign = n >= 0 ? '+' : '-';
  const val = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Math.abs(n));
  return `${sign}${val}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '0.00%';
  return `${n.toFixed(2)}%`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (currentRangeHours <= 24) {
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return (
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Chart setup ─────────────────────────────────

function makeGradient(ctx) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  const accent = cssVar('--accent') || '#635BFF';
  gradient.addColorStop(0, hexToRgba(accent, 0.18));
  gradient.addColorStop(1, hexToRgba(accent, 0));
  return gradient;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyChartTheme() {
  if (!chart) return;
  const ctx = chart.ctx;
  const accent = cssVar('--accent');
  const textMuted = cssVar('--text-muted');
  const grid = cssVar('--grid-line');
  const cardBg = cssVar('--card-bg');
  const border = cssVar('--border');
  const textSec = cssVar('--text-secondary');
  const textPri = cssVar('--text-primary');

  chart.data.datasets[0].borderColor = accent;
  chart.data.datasets[0].backgroundColor = makeGradient(ctx);
  chart.data.datasets[0].pointBackgroundColor = accent;
  chart.data.datasets[0].pointBorderColor = cardBg;

  chart.options.plugins.tooltip.backgroundColor = cardBg;
  chart.options.plugins.tooltip.borderColor = border;
  chart.options.plugins.tooltip.titleColor = textSec;
  chart.options.plugins.tooltip.bodyColor = textPri;

  chart.options.scales.x.ticks.color = textMuted;
  chart.options.scales.y.ticks.color = textMuted;
  chart.options.scales.y.grid.color = grid;
}

function initChart() {
  const canvas = document.getElementById('equity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Equity',
          data: [],
          borderColor: '#635BFF',
          backgroundColor: makeGradient(ctx),
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 10,
          pointBackgroundColor: '#635BFF',
          pointBorderColor: '#FFFFFF',
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
        mode: 'index',
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#131316',
          borderColor: '#27272A',
          borderWidth: 1,
          titleColor: '#A1A1AA',
          bodyColor: '#FFFFFF',
          titleFont: { size: 14, family: 'Plus Jakarta Sans' },
          bodyFont: { size: 14, weight: '600', family: 'JetBrains Mono' },
          padding: 12,
          displayColors: false,
          callbacks: {
            label: (ctx) => `Equity: $${ctx.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#71717A',
            font: { family: 'JetBrains Mono', size: 12 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
          },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: {
            color: '#71717A',
            font: { family: 'JetBrains Mono', size: 12 },
            callback: (v) => `$${v.toFixed(2)}`,
            maxTicksLimit: 6,
          },
          grid: { color: '#1F1F23' },
          border: { display: false },
        },
      },
    },
  });
  applyChartTheme();
  chart.update('none');
}

// ── API ─────────────────────────────────────────

async function fetchJson(path) {
  const r = await fetch(path);
  if (r.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

// ── Renderers ───────────────────────────────────

function renderBans(status) {
  const container = document.getElementById('bans-container');
  if (!status.runtimeBans || status.runtimeBans.length === 0) {
    container.innerHTML =
      '<div class="empty-state" style="font-size:14px;">No active restrictions</div>';
    return;
  }

  container.innerHTML = status.runtimeBans
    .map(
      (coin) => `
        <div style="display:inline-block; background:rgba(239, 68, 68, 0.1); color:var(--red); border:1px solid rgba(239, 68, 68, 0.2); padding:4px 10px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:600; margin:0 8px 8px 0;">
            #${escapeHtml(coin)}
        </div>
    `,
    )
    .join('');
}

function renderActivity(activity) {
  const container = document.getElementById('activity-container');
  const rawEvents = activity?.events || [];

  // Защита: пропускаем мусорные события (нет coin, неизвестный kind,
  // или служебные anchor-точки которые не должны попадать в feed).
  const events = rawEvents.filter((e) => {
    if (!e || !e.coin) return false;
    if (e.kind !== 'open' && e.kind !== 'close') return false;
    if (e.reason === 'now' || e.reason === 'window_start') return false;
    return true;
  });

  if (events.length === 0) {
    container.innerHTML =
      '<div class="empty-state" style="font-size:14px;">No events in selected window</div>';
    return;
  }

  container.innerHTML = events
    .map((e) => {
      if (e.kind === 'open') {
        const strat = escapeHtml((e.strategy_id || 'carry').toUpperCase());
        const apy = e.entryApy != null ? fmtPct(e.entryApy) : '';
        return `
          <div class="activity-item">
            <div>
              <span class="activity-kind open">OPEN</span>
              <span class="activity-time">${fmtTime(e.ts)}</span>
              <span class="activity-coin">#${escapeHtml(e.coin)}</span>
              <span class="activity-reason">${strat} · ${apy}</span>
            </div>
            <div class="activity-pnl" style="color:var(--text-secondary)">${fmtUsd(e.sizeUsd)}</div>
          </div>
        `;
      }
      const cls = e.pnl >= 0 ? 'positive' : 'negative';
      const sign = e.pnl >= 0 ? '+' : '';
      return `
        <div class="activity-item">
          <div>
            <span class="activity-kind close">CLOSE</span>
            <span class="activity-time">${fmtTime(e.ts)}</span>
            <span class="activity-coin">#${escapeHtml(e.coin)}</span>
            <span class="activity-reason">${escapeHtml(e.reason)}</span>
          </div>
          <div class="activity-pnl ${cls}">${sign}${(e.pnl || 0).toFixed(4)}</div>
        </div>
      `;
    })
    .join('');
}

function renderHeader(status) {
  document.getElementById('equity-value').textContent = fmtUsd(status.equity);

  const deltaEl = document.getElementById('equity-delta');
  const profit = status.sessionProfit;
  if (status.sessionStartEquity > 0) {
    const pct = (profit / status.sessionStartEquity) * 100;
    deltaEl.textContent = `${fmtUsdSigned(profit)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) session`;
    deltaEl.className = `delta ${profit >= 0 ? 'positive' : 'negative'}`;
  }

  const pill = document.getElementById('mode-pill');
  pill.textContent = status.mode;
  pill.className = `status-pill ${status.mode === 'PRODUCTION' ? 'prod' : ''}`;

  document.getElementById('uptime-val').textContent = `Uptime: ${formatUptime(status.uptimeMin)}`;
  document.getElementById('available-val').textContent =
    `Available: ${fmtUsd(status.available)}`;

  if (status.authEnabled) {
    document.getElementById('logout-link').style.display = '';
  }
}

function renderPosition(pos) {
  const container = document.getElementById('position-container');
  if (!pos) {
    container.innerHTML =
      '<div class="empty-state">No active positions — bot is IDLE</div>';
    return;
  }

  const pnl = pos.currentPnl;
  let pnlBlock = '';
  if (pnl) {
    const cls = (v) => (v >= 0 ? 'positive' : 'negative');
    const sgn = (v) => (v >= 0 ? '+' : '−');
    const abs = (v) => Math.abs(v).toFixed(4);
    pnlBlock = `
        <div class="data-grid" style="margin-top:0.75rem">
            <div class="grid-item">
                <div class="item-label">Net (if exit market)</div>
                <div class="item-value ${cls(pnl.netMarket)}">${sgn(pnl.netMarket)}$${abs(pnl.netMarket)}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Net (if exit maker)</div>
                <div class="item-value ${cls(pnl.netMaker)}">${sgn(pnl.netMaker)}$${abs(pnl.netMaker)}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Price PnL</div>
                <div class="item-value ${cls(pnl.price)}">${sgn(pnl.price)}$${abs(pnl.price)}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Funding</div>
                <div class="item-value ${cls(pnl.funding)}">${sgn(pnl.funding)}$${abs(pnl.funding)}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Entry fee (paid)</div>
                <div class="item-value negative">−$${pnl.entryFee.toFixed(4)}</div>
            </div>
            <div class="grid-item">
                <div class="item-label">Exit fee est. (mkt / mkr)</div>
                <div class="item-value negative">−$${pnl.exitFeeMarket.toFixed(4)} / −$${pnl.exitFeeMaker.toFixed(4)}</div>
            </div>
        </div>
    `;
  }

  container.innerHTML = `
        <div class="data-grid">
            <div class="grid-item">
                <div class="item-label">Coin</div>
                <div class="item-value highlight">#${escapeHtml(pos.coin)}</div>
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
        </div>${pnlBlock}
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
  document.getElementById('tax-year').textContent = tax.year || 2026;

  const costs = tax.totalCostsPLN || 0;
  const revenue = tax.totalRevenuePLN || 0;
  const profit = tax.netProfitPLN || 0;
  const estTax = profit > 0 ? profit * 0.19 : 0;

  document.getElementById('tax-costs').textContent =
    `${costs.toLocaleString()} PLN`;
  document.getElementById('tax-revenue').textContent =
    `${revenue.toLocaleString()} PLN`;

  const profitEl = document.getElementById('tax-profit');
  profitEl.textContent = `${profit >= 0 ? '+' : ''}${profit.toLocaleString()} PLN`;
  profitEl.style.color = profit >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('tax-est').textContent =
    `${estTax.toLocaleString()} PLN`;
}

function renderFooter() {
  const footer = document.getElementById('footer-status').querySelector('span');
  if (!footer) return;
  if (lastSuccessAt === 0) {
    footer.textContent = 'Connecting to core terminal...';
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
  // Делаем запросы независимо — отказ одного API не должен блокировать остальные.
  const [statusR, historyR, activityR, taxR] = await Promise.allSettled([
    fetchJson('/api/status'),
    fetchJson(`/api/history?hours=${currentRangeHours}`),
    fetchJson(`/api/activity?hours=${currentRangeHours}&limit=10`),
    fetchJson('/api/tax-summary'),
  ]);

  let anyOk = false;

  if (statusR.status === 'fulfilled') {
    try {
      renderHeader(statusR.value);
      renderPosition(statusR.value.activePosition);
      renderBans(statusR.value);
      anyOk = true;
    } catch (err) { console.error('[Dashboard] header render', err); }
  } else {
    console.error('[Dashboard] /api/status', statusR.reason);
  }

  if (historyR.status === 'fulfilled') {
    try {
      renderChart(historyR.value);
      anyOk = true;
    } catch (err) { console.error('[Dashboard] chart render', err); }
    if (!chartLoaded) { hideChartLoader(); chartLoaded = true; }
  } else {
    console.error('[Dashboard] /api/history', historyR.reason);
  }

  if (activityR.status === 'fulfilled') {
    try {
      renderActivity(activityR.value);
      anyOk = true;
    } catch (err) { console.error('[Dashboard] activity render', err); }
  } else {
    console.error('[Dashboard] /api/activity', activityR.reason);
  }

  if (taxR.status === 'fulfilled') {
    try { renderTax(taxR.value); anyOk = true; }
    catch (err) { console.error('[Dashboard] tax render', err); }
  } else {
    console.error('[Dashboard] /api/tax-summary', taxR.reason);
  }

  if (anyOk) lastSuccessAt = Date.now();
  renderFooter();
}

setupThemeSwitcher();
setupRangeButtons();
initChart();
tick();
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1000);
