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

const REFRESH_MS = 10_000;
let equityChart = null;
let priceChart = null;
let priceSeries = null;
let entryPriceLine = null;
let currentPriceLine = null;
let liveCandle = null; // {time, open, high, low, close}
let currentInterval = '1m';
const INTERVAL_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
let lastSuccessAt = 0;
let currentRangeHours = 24;
let chartLoaded = false;
let socket = null;
const lastAnimatedValues = new Map();
let currentCoinInPos = null;
let lastPos = null;

// ── WebSocket ───────────────────────────────────

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  socket = new WebSocket(wsUrl);
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        renderHeader(msg.data);
        renderPosition(msg.data.activePosition);
        renderBans(msg.data);
        handlePriceChartUpdate(msg.data.activePosition);
        lastSuccessAt = Date.now();
        renderFooter();
      } else if (msg.type === 'logs:init') {
        ingestLogs(msg.entries || [], true);
      } else if (msg.type === 'log') {
        ingestLogs([msg.entry], false);
      }
    } catch (err) { console.error('[WS] Error:', err); }
  };
  socket.onclose = () => setTimeout(initWebSocket, 5000);
}

// ── Number Animation (Rabbit Style) ────────────────

function updateAnimatedNumber(elId, newValueStr) {
  const el = document.getElementById(elId);
  if (!el) return;
  const prev = lastAnimatedValues.get(elId) || "";
  if (prev === newValueStr) return;

  const oldStr = prev || newValueStr;
  lastAnimatedValues.set(elId, newValueStr);
  
  el.innerHTML = "";
  const maxLength = Math.max(oldStr.length, newValueStr.length);
  const oldPadded = oldStr.padStart(maxLength, " ");
  const newPadded = newValueStr.padStart(maxLength, " ");

  for (let i = 0; i < maxLength; i++) {
    const charOld = oldPadded[i];
    const charNew = newPadded[i];
    
    if (charOld === charNew) {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    } else if (/[0-9]/.test(charNew)) {
      const reel = document.createElement("div");
      reel.className = "digit-reel";
      const digits = (/[0-9]/.test(charOld)) ? [charOld, charNew] : [charNew];
      digits.forEach(d => {
        const s = document.createElement("span");
        s.textContent = d;
        reel.appendChild(s);
      });
      el.appendChild(reel);
      if (digits.length > 1) {
        requestAnimationFrame(() => {
          reel.style.transform = `translateY(-1.1em)`;
        });
      }
    } else {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    }
  }
}

// ── Price Chart Logic ────────────────────────────

async function handlePriceChartUpdate(pos) {
  const card = document.getElementById('price-card');
  if (!pos) {
    card.style.display = 'none';
    currentCoinInPos = null;
    lastPos = null;
    if (priceChart) { priceChart.remove(); priceChart = null; priceSeries = null; entryPriceLine = null; currentPriceLine = null; }
    return;
  }
  lastPos = pos;

  card.style.display = 'block';
  document.getElementById('price-title').textContent = `Price Performance: #${pos.coin}`;

  let currentPrice = pos.entryPrice;
  if (Number.isFinite(pos.currentPrice) && pos.currentPrice > 0) {
    currentPrice = pos.currentPrice;
  } else if (pos.currentPnl && pos.sizeUsd > 0 && pos.entryPrice > 0) {
    const qty = pos.sizeUsd / pos.entryPrice;
    currentPrice = pos.entryPrice + (pos.currentPnl.price / qty);
  }

  document.getElementById('price-meta').textContent = `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

  if (currentCoinInPos !== pos.coin) {
    currentCoinInPos = pos.coin;
    await fetchAndRenderCandles(pos, currentPrice);
  } else if (priceSeries) {
    tickLiveCandle(currentPrice, pos);
    updateCurrentLine(currentPrice);
  }
}

async function fetchAndRenderCandles(pos, currentPrice) {
  try {
    const candles = await fetchJson(`/api/candles?coin=${pos.coin}&interval=${currentInterval}`);
    if (!Array.isArray(candles) || candles.length === 0) return;

    const data = candles
      .map(c => ({
        time: Math.floor(c.t / 1000),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
      }))
      .filter(d => Number.isFinite(d.open) && Number.isFinite(d.close))
      .sort((a, b) => a.time - b.time);

    initPriceChart();
    priceSeries.setData(data);
    const last = data[data.length - 1];
    liveCandle = { time: last.time, open: last.open, high: last.high, low: last.low, close: last.close };
    setEntryLine(pos.entryPrice);
    setCurrentLine(currentPrice);
    priceChart.timeScale().fitContent();
  } catch (err) { console.error('[PriceChart] fetch error:', err); }
}

function initPriceChart() {
  const container = document.getElementById('price-chart');
  if (!container) return;
  if (priceChart) { priceChart.remove(); priceChart = null; }

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = css('--text-muted') || (isDark ? '#71717A' : '#52525B');
  const gridColor = css('--grid-line') || (isDark ? '#1F1F23' : '#E4E4E7');
  const bgColor = css('--card-bg') || (isDark ? '#131316' : '#FFFFFF');

  priceChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: 'solid', color: bgColor },
      textColor,
      fontFamily: 'JetBrains Mono, monospace',
    },
    grid: {
      vertLines: { color: gridColor },
      horzLines: { color: gridColor },
    },
    rightPriceScale: { borderColor: gridColor },
    timeScale: { borderColor: gridColor, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    handleScroll: true,
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  priceSeries = priceChart.addCandlestickSeries({
    upColor: '#22C55E',
    downColor: '#EF4444',
    borderUpColor: '#22C55E',
    borderDownColor: '#EF4444',
    wickUpColor: '#22C55E',
    wickDownColor: '#EF4444',
  });

  if (!window.__priceChartResizeBound) {
    window.__priceChartResizeBound = true;
    window.addEventListener('resize', () => {
      if (priceChart && container) priceChart.resize(container.clientWidth, container.clientHeight);
    });
  }
}

function setEntryLine(price) {
  if (!priceSeries || !Number.isFinite(price)) return;
  if (entryPriceLine) priceSeries.removePriceLine(entryPriceLine);
  entryPriceLine = priceSeries.createPriceLine({
    price,
    color: '#71717A',
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: 'Entry',
  });
}

function setCurrentLine(price) {
  if (!priceSeries || !Number.isFinite(price)) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#635BFF';
  if (currentPriceLine) priceSeries.removePriceLine(currentPriceLine);
  currentPriceLine = priceSeries.createPriceLine({
    price,
    color: accent,
    lineWidth: 1,
    lineStyle: 0,
    axisLabelVisible: true,
    title: 'Now',
  });
}

function updateCurrentLine(price) {
  if (!currentPriceLine || !Number.isFinite(price)) return setCurrentLine(price);
  currentPriceLine.applyOptions({ price });
}

function tickLiveCandle(price, pos) {
  if (!priceSeries || !Number.isFinite(price)) return;
  const step = INTERVAL_SECONDS[currentInterval] || 60;
  const now = Math.floor(Date.now() / 1000);
  const bucket = now - (now % step);

  if (!liveCandle || bucket > liveCandle.time + step) {
    // окно сильно сдвинулось — рефетчим (подтянем все пропущенные свечи)
    fetchAndRenderCandles(pos, price);
    return;
  }

  if (bucket > liveCandle.time) {
    // новый bucket — стартуем свечу с close предыдущей
    liveCandle = { time: bucket, open: liveCandle.close, high: price, low: price, close: price };
  } else {
    liveCandle.high = Math.max(liveCandle.high, price);
    liveCandle.low = Math.min(liveCandle.low, price);
    liveCandle.close = price;
  }
  priceSeries.update(liveCandle);
}

// ── Performance Chart (EQUITY) — RESTORING ORIGINAL STYLE ──

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
  if (!equityChart) return;
  const ctx = equityChart.ctx;
  const accent = cssVar('--accent');
  const textMuted = cssVar('--text-muted');
  const grid = cssVar('--grid-line');
  const cardBg = cssVar('--card-bg');
  const border = cssVar('--border');
  const textSec = cssVar('--text-secondary');
  const textPri = cssVar('--text-primary');

  equityChart.data.datasets[0].borderColor = accent;
  equityChart.data.datasets[0].backgroundColor = makeGradient(ctx);
  equityChart.data.datasets[0].pointBackgroundColor = accent;
  equityChart.data.datasets[0].pointBorderColor = cardBg;

  equityChart.options.plugins.tooltip.backgroundColor = cardBg;
  equityChart.options.plugins.tooltip.borderColor = border;
  equityChart.options.plugins.tooltip.titleColor = textSec;
  equityChart.options.plugins.tooltip.bodyColor = textPri;

  equityChart.options.scales.x.ticks.color = textMuted;
  equityChart.options.scales.y.ticks.color = textMuted;
  equityChart.options.scales.y.grid.color = grid;
}

function initEquityChart() {
  const canvas = document.getElementById('equity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  equityChart = new Chart(ctx, {
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
}

// ── Theme & Helpers ──────────────────────────────

const THEME_KEY = 'hl-scanner-theme';
function getStoredTheme() { return localStorage.getItem(THEME_KEY) || 'auto'; }
function applyTheme(mode) {
  const root = document.documentElement;
  const resolved = mode === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  root.setAttribute('data-theme', resolved);
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === mode));
  if (equityChart) { applyChartTheme(); equityChart.update('none'); }
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function fmtUsd(n) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0); }
function fmtPct(n) { return `${(n || 0).toFixed(2)}%`; }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function fmtTime(ts) {
  const d = new Date(ts);
  if (currentRangeHours <= 24) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ── Renderers ───────────────────────────────────

function renderHeader(status) {
  updateAnimatedNumber('equity-value', fmtUsd(status.equity));
  const profit = status.sessionProfit;
  const deltaEl = document.getElementById('equity-delta');
  if (status.sessionStartEquity > 0) {
    const pct = (profit / status.sessionStartEquity) * 100;
    deltaEl.textContent = `${profit >= 0 ? '+' : '-'}${fmtUsd(Math.abs(profit))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) session`;
    deltaEl.className = `delta ${profit >= 0 ? 'positive' : 'negative'}`;
  }
  document.getElementById('mode-pill').textContent = status.mode;
  document.getElementById('uptime-val').textContent = `Uptime: ${formatUptime(status.uptimeMin)}`;
  document.getElementById('available-val').textContent = `Available: ${fmtUsd(status.available)}`;
}

function renderPosition(pos) {
  const container = document.getElementById('position-container');
  if (!pos) { container.innerHTML = '<div class="empty-state">No active positions — bot is IDLE</div>'; return; }
  const pnl = pos.currentPnl;
  let pnlBlock = '';
  if (pnl) {
    const cls = v => v >= 0 ? 'positive' : 'negative';
    const sgn = v => v >= 0 ? '+' : '−';
    pnlBlock = `
      <div class="data-grid" style="margin-top:0.75rem">
        <div class="grid-item"><div class="item-label">Net (Mkt)</div><div class="item-value ${cls(pnl.netMarket)}">${sgn(pnl.netMarket)}$${Math.abs(pnl.netMarket).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Net (Mkr)</div><div class="item-value ${cls(pnl.netMaker)}">${sgn(pnl.netMaker)}$${Math.abs(pnl.netMaker).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Price PnL</div><div class="item-value ${cls(pnl.price)}">${sgn(pnl.price)}$${Math.abs(pnl.price).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Funding</div><div class="item-value ${cls(pnl.funding)}">${sgn(pnl.funding)}$${Math.abs(pnl.funding).toFixed(4)}</div></div>
      </div>`;
  }
  container.innerHTML = `
    <div class="data-grid">
      <div class="grid-item"><div class="item-label">Coin</div><div class="item-value highlight">#${pos.coin}</div></div>
      <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(pos.sizeUsd)}</div></div>
      <div class="grid-item"><div class="item-label">Entry</div><div class="item-value">$${pos.entryPrice}</div></div>
      <div class="grid-item"><div class="item-label">APY · Held</div><div class="item-value">${fmtPct(pos.entryApy)} · ${pos.heldHours.toFixed(1)}h</div></div>
    </div>${pnlBlock}`;
}

function renderBans(status) {
  const container = document.getElementById('bans-container');
  if (!status.runtimeBans?.length) { container.innerHTML = '<div class="empty-state">No active restrictions</div>'; return; }
  container.innerHTML = status.runtimeBans.map(c => `<div style="display:inline-block; background:rgba(239,68,68,0.1); color:var(--red); border:1px solid rgba(239,68,68,0.2); padding:4px 10px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:600; margin:0 8px 8px 0;">#${c}</div>`).join('');
}

async function fetchJson(path) { const r = await fetch(path); if (r.status === 401) window.location.href = '/login'; return r.json(); }

async function tick() {
  const [historyR, activityR, taxR] = await Promise.allSettled([
    fetchJson(`/api/history?hours=${currentRangeHours}`),
    fetchJson(`/api/activity?hours=${currentRangeHours}&limit=10`),
    fetchJson('/api/tax-summary'),
  ]);
  if (historyR.status === 'fulfilled' && historyR.value?.points) {
    equityChart.data.labels = historyR.value.points.map(p => fmtTime(p.ts));
    equityChart.data.datasets[0].data = historyR.value.points.map(p => p.equity);
    equityChart.update();
    if (!chartLoaded) { document.getElementById('chart-loader').classList.add('hidden'); chartLoaded = true; }
  }
  if (activityR.status === 'fulfilled') renderActivity(activityR.value);
  if (taxR.status === 'fulfilled') renderTax(taxR.value);
  lastSuccessAt = Date.now();
  renderFooter();
}

function renderActivity(activity) {
  const container = document.getElementById('activity-container');
  const events = (activity?.events || []).filter(e => e && e.coin);
  if (!events.length) { container.innerHTML = '<div class="empty-state">No events</div>'; return; }
  container.innerHTML = events.map(e => `
    <div class="activity-item">
      <div><span class="activity-kind ${e.kind}">${e.kind.toUpperCase()}</span><span class="activity-coin">#${e.coin}</span></div>
      <div class="activity-pnl ${e.pnl >= 0 ? 'positive' : 'negative'}">${e.pnl >= 0 ? '+' : ''}${(e.pnl || 0).toFixed(4)}</div>
    </div>`).join('');
}

function renderTax(tax) {
  if (!tax) return;
  document.getElementById('tax-costs').textContent = `${(tax.totalCostsPLN || 0).toLocaleString()} PLN`;
  document.getElementById('tax-revenue').textContent = `${(tax.totalRevenuePLN || 0).toLocaleString()} PLN`;
  const profit = tax.netProfitPLN || 0;
  const profitEl = document.getElementById('tax-profit');
  profitEl.textContent = `${profit >= 0 ? '+' : ''}${profit.toLocaleString()} PLN`;
  profitEl.style.color = profit >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('tax-est').textContent = `${(profit > 0 ? profit * 0.19 : 0).toLocaleString()} PLN`;
}

function renderFooter() {
  const footer = document.getElementById('footer-status').querySelector('span');
  if (!footer) return;
  const age = Math.floor((Date.now() - lastSuccessAt) / 1000);
  footer.textContent = age > 15 ? `⚠ Stale (${age}s)` : `Syncing live · WS active`;
}

document.querySelectorAll('.theme-btn').forEach(b => b.addEventListener('click', () => { localStorage.setItem(THEME_KEY, b.dataset.theme); applyTheme(b.dataset.theme); }));
document.querySelectorAll('.range-btn[data-hours]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.range-btn[data-hours]').forEach(r => r.classList.remove('active'));
  b.classList.add('active');
  currentRangeHours = b.dataset.hours;
  tick();
}));

document.querySelectorAll('#price-intervals .range-btn').forEach(b => b.addEventListener('click', async () => {
  if (b.dataset.iv === currentInterval) return;
  document.querySelectorAll('#price-intervals .range-btn').forEach(r => r.classList.remove('active'));
  b.classList.add('active');
  currentInterval = b.dataset.iv;
  liveCandle = null;
  if (lastPos) {
    const px = Number.isFinite(lastPos.currentPrice) && lastPos.currentPrice > 0 ? lastPos.currentPrice : lastPos.entryPrice;
    await fetchAndRenderCandles(lastPos, px);
  }
}));

// ── Live Logs ────────────────────────────────────

const LOG_BUFFER_MAX = 1000;
const logsState = {
  buffer: [],
  lastId: 0,
  level: 'all',
  query: '',
  paused: false,
  renderScheduled: false,
};

function ingestLogs(entries, replace) {
  if (replace) logsState.buffer = [];
  for (const e of entries) {
    if (!e || typeof e.id !== 'number') continue;
    if (e.id <= logsState.lastId && !replace) continue;
    logsState.buffer.push(e);
    if (e.id > logsState.lastId) logsState.lastId = e.id;
  }
  if (logsState.buffer.length > LOG_BUFFER_MAX) {
    logsState.buffer.splice(0, logsState.buffer.length - LOG_BUFFER_MAX);
  }
  scheduleLogRender();
}

function scheduleLogRender() {
  if (logsState.renderScheduled) return;
  logsState.renderScheduled = true;
  requestAnimationFrame(() => {
    logsState.renderScheduled = false;
    renderLogs();
  });
}

function logMatches(e) {
  if (logsState.level !== 'all' && e.level !== logsState.level) return false;
  if (logsState.query && !e.message.toLowerCase().includes(logsState.query)) return false;
  return true;
}

function fmtLogTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const q = escapeHtml(query);
  // case-insensitive replace on the escaped string
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return safe.replace(re, m => `<mark>${m}</mark>`);
}

function renderLogs() {
  const list = document.getElementById('logs-list');
  const empty = document.getElementById('logs-empty');
  const countEl = document.getElementById('logs-count');
  if (!list || !empty || !countEl) return;

  const filtered = logsState.buffer.filter(logMatches);
  countEl.textContent = `${filtered.length} / ${logsState.buffer.length} lines`;

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const viewport = document.getElementById('logs-viewport');
  const wasAtBottom = viewport ? (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30) : true;

  list.innerHTML = filtered.map(e => `
    <div class="log-row log-${e.level}">
      <span class="log-time">${fmtLogTime(e.ts)}</span>
      <span class="log-level">${e.level.toUpperCase()}</span>
      <span class="log-msg">${highlightMatch(e.message, logsState.query)}</span>
    </div>`).join('');

  if (!logsState.paused && wasAtBottom && viewport) {
    viewport.scrollTop = viewport.scrollHeight;
  }
}

function bindLogsUi() {
  const search = document.getElementById('logs-search');
  const pauseBtn = document.getElementById('logs-pause');
  const filters = document.getElementById('logs-filters');
  const viewport = document.getElementById('logs-viewport');

  if (search) {
    search.addEventListener('input', () => {
      logsState.query = search.value.trim().toLowerCase();
      renderLogs();
    });
  }
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      logsState.paused = !logsState.paused;
      pauseBtn.textContent = logsState.paused ? '▶' : '⏸';
      pauseBtn.classList.toggle('active', logsState.paused);
      document.getElementById('logs-status').textContent = logsState.paused ? 'paused' : 'live';
      if (!logsState.paused && viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }
  if (filters) {
    filters.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.logs-filter-btn');
      if (!btn) return;
      filters.querySelectorAll('.logs-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      logsState.level = btn.dataset.level;
      renderLogs();
    });
  }
  // Detect manual scroll up → auto-pause autoscroll until user clicks resume or scrolls back to bottom
  if (viewport) {
    viewport.addEventListener('scroll', () => {
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30;
      if (atBottom && logsState.paused) {
        // user scrolled back to bottom — resume
        logsState.paused = false;
        pauseBtn.textContent = '⏸';
        pauseBtn.classList.remove('active');
        document.getElementById('logs-status').textContent = 'live';
      }
    });
  }
}

async function fetchInitialLogs() {
  try {
    const r = await fetchJson('/api/logs?limit=500');
    if (r && Array.isArray(r.entries)) ingestLogs(r.entries, true);
  } catch (err) { console.error('[Logs] initial fetch failed', err); }
}

bindLogsUi();
fetchInitialLogs();

applyTheme(getStoredTheme());
initEquityChart();
initWebSocket();
tick();
setInterval(tick, REFRESH_MS);
setInterval(renderFooter, 1000);
