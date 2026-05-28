#!/usr/bin/env node
/**
 * Terminal dashboard — blessed-contrib
 * Usage: node tools/tui.js [--url http://localhost:3010]
 *
 * Keys:
 *   1/2/3    switch orderbook coin
 *   Tab      cycle orderbook coin
 *   j/k ↓↑  navigate activity list
 *   Enter    show trade detail
 *   r        force refresh all
 *   q/Esc    quit
 */

import { createRequire } from "module";
import https from "https";
import http from "http";

const require = createRequire(import.meta.url);
const blessed = require("blessed");
const contrib = require("blessed-contrib");

// ── Config ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const BASE =
  urlIdx !== -1 ? args[urlIdx + 1] : process.env.DASHBOARD_URL || "http://localhost:3010";
const HL_API = "https://api.hyperliquid.xyz/info";
const OB_COINS = ["BTC", "ETH", "SOL"];
const OB_DEPTH = 8;

const AUTH_USER = process.env.DASHBOARD_USER || process.env.DASHBOARD_AUTH_USER || "";
const AUTH_PASS = process.env.DASHBOARD_PASS || process.env.DASHBOARD_AUTH_PASS || "";
let SESSION_COOKIE = "";

// ── HTTP ──────────────────────────────────────────────────────────────────────
function login() {
  return new Promise((resolve, reject) => {
    if (!AUTH_USER || !AUTH_PASS) { resolve(); return; }
    const body = `user=${encodeURIComponent(AUTH_USER)}&pass=${encodeURIComponent(AUTH_PASS)}`;
    const u = new URL(`${BASE}/login`);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port || 80, path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode === 401) { reject(new Error("Login failed — wrong credentials")); return; }
          const found = (res.headers["set-cookie"] || []).find((c) => c.startsWith("hl-session="));
          if (found) SESSION_COOKIE = found.split(";")[0];
          resolve();
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = url.startsWith("https") ? https : http;
    const headers = url.startsWith(BASE) && SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (url.startsWith("https") ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 401) { reject(new Error("401 Unauthorized")); return; }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("JSON parse")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname, port: 443, path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("JSON parse")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

// ── Screen & grid ─────────────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: "HL Scanner", fullUnicode: true });
// 12 rows: top 11 for content, bottom 1 for key hints
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

const equityChart = grid.set(0, 0, 5, 8, contrib.line, {
  label: " {cyan-fg}EQUITY{/cyan-fg}  24h ",
  tags: true,
  showLegend: false,
  xLabelPadding: 1,
  xPadding: 2,
  wholeNumbersOnly: false,
  style: { line: "cyan", text: "white", baseline: "black" },
  border: { type: "line", fg: "cyan" },
});

const activityList = grid.set(5, 0, 6, 8, blessed.list, {
  label: " {cyan-fg}ACTIVITY{/cyan-fg}  {white-fg}j/k=navigate  Enter=detail{/white-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  scrollable: true,
  mouse: true,
  keys: true,
  vi: true,
  style: {
    selected: { bg: "cyan", fg: "black", bold: true },
    item: { fg: "white" },
    scrollbar: { bg: "cyan" },
  },
  scrollbar: { ch: "│" },
  padding: { left: 0 },
});

const statusBox = grid.set(0, 8, 3, 4, blessed.box, {
  label: " {cyan-fg}STATUS{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  padding: { left: 1 },
  content: " Loading...",
});

const obBox = grid.set(3, 8, 6, 4, blessed.box, {
  label: " {cyan-fg}ORDER BOOK{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  padding: { left: 0 },
  content: " Loading...",
});

const pnlBox = grid.set(9, 8, 2, 4, blessed.box, {
  label: " {cyan-fg}PnL{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  padding: { left: 1 },
  content: " Loading...",
});

// Bottom hint bar (row 11)
const hintBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  style: { bg: "cyan", fg: "black" },
  content: "",
});

function updateHintBar() {
  const coin = OB_COINS[obCoinIdx];
  hintBar.setContent(
    ` {black-fg}{bold}[q]{/bold} quit  {bold}[r]{/bold} refresh  {bold}[1]BTC [2]ETH [3]SOL{/bold}  coin: {bold}${coin}{/bold}  {bold}[j/k]{/bold} navigate  {bold}[Enter]{/bold} detail  {bold}[Tab]{/bold} cycle{/black-fg}`
  );
}

// Detail popup (hidden by default)
const detailBox = blessed.box({
  parent: screen,
  top: "center",
  left: "center",
  width: "50%",
  height: "40%",
  tags: true,
  border: { type: "line", fg: "yellow" },
  label: " {yellow-fg}TRADE DETAIL{/yellow-fg} ",
  hidden: true,
  padding: { left: 2, right: 2, top: 1 },
  style: { bg: "black", fg: "white" },
  scrollable: true,
  keys: true,
  vi: true,
});

// ── State ─────────────────────────────────────────────────────────────────────
let obCoinIdx = 0;
let prevMidPrice = null;
let priceDir = " ";
let activityData = [];

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtPnl(v) {
  if (v == null || isNaN(v)) return "{white-fg}—{/white-fg}";
  const s = (v >= 0 ? "+" : "") + v.toFixed(2);
  return v >= 0 ? `{green-fg}${s}{/green-fg}` : `{red-fg}${s}{/red-fg}`;
}

function fmtDot(status) {
  if (status === "ok") return "{green-fg}[OK]{/green-fg}";
  if (status === "booting") return "{yellow-fg}[..]{/yellow-fg}";
  return "{red-fg}[!!]{/red-fg}";
}

function fmtUptime(ms) {
  if (!ms) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtAge(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function strategyTag(id) {
  const map = { hunter_short: "SHORT", hunter_long: "LONG ", trend_follow: "CHILL", carry: "CARRY", manual: "HAND " };
  return map[id] || (id || "—").padEnd(5);
}

function bar(frac, width = 9) {
  const full = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return "#".repeat(full) + ".".repeat(width - full);
}

function fmtPrice(px) {
  if (px < 1) return px.toFixed(5);
  if (px < 100) return px.toFixed(3);
  if (px < 10000) return px.toFixed(2);
  return px.toFixed(1);
}

function flash(widget, color = "yellow") {
  const orig = widget.border?.fg || "cyan";
  widget.style.border = { fg: color };
  widget.border.fg = color;
  screen.render();
  setTimeout(() => {
    widget.style.border = { fg: orig };
    widget.border.fg = orig;
    screen.render();
  }, 300);
}

// ── Renderers ─────────────────────────────────────────────────────────────────
function renderStatus(data, err) {
  if (err || !data) {
    statusBox.setContent(` {red-fg}${err || "No data"}{/red-fg}`);
    return;
  }
  const dot = fmtDot(data.status);
  const slotColor = data.slot === "ACTIVE" ? "green-fg" : "white-fg";
  const coin = data.slotCoin ? `{yellow-fg}${data.slotCoin}{/yellow-fg}` : "—";
  const strat = data.slotStrategy ? `{blue-fg}${strategyTag(data.slotStrategy)}{/blue-fg}` : "—";
  statusBox.setContent(
    ` Bot    ${dot}\n` +
    ` Up     {white-fg}${fmtUptime(data.uptimeMs)}{/white-fg}\n` +
    ` Tick   {white-fg}${fmtAge(data.tickAgeMs)}{/white-fg}\n` +
    ` Slot   {${slotColor}}${data.slot || "?"}{/${slotColor}}\n` +
    ` Coin   ${coin}\n` +
    ` Strat  ${strat}`
  );
}

function renderEquity(data, err) {
  if (err || !data?.points || data.points.length < 2) {
    equityChart.setData([{ title: "eq", x: ["—"], y: [0], style: { line: "cyan" } }]);
    return;
  }
  const pts = data.points;
  const eq = data.currentEquity || 0;
  const step = Math.max(1, Math.floor(pts.length / 6));
  const xs = pts.map((p, i) => {
    if (i % step !== 0 && i !== pts.length - 1) return "";
    const d = new Date(p.ts);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  });
  const ys = pts.map((p) => p.equity);
  const delta = eq - (ys[0] || eq);
  const lineColor = delta >= 0 ? "green" : "red";
  const deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(2);
  const labelColor = delta >= 0 ? "green-fg" : "red-fg";

  equityChart.options.style.line = lineColor;
  equityChart.setData([{ title: "eq", x: xs, y: ys, style: { line: lineColor } }]);
  equityChart.setLabel(
    ` {cyan-fg}EQUITY{/cyan-fg}  {white-fg}$${eq.toFixed(2)}{/white-fg}  {${labelColor}}${deltaStr}{/${labelColor}}  24h `
  );
}

function renderActivity(data, err) {
  if (err) { activityList.clearItems(); activityList.addItem(`{red-fg}${err}{/red-fg}`); return; }
  if (!data?.events) return;

  activityData = [...data.events].sort((a, b) => b.ts - a.ts).slice(0, 40);
  const selectedIdx = activityList.selected || 0;

  activityList.clearItems();
  for (const ev of activityData) {
    const d = new Date(ev.ts);
    const time = d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
    const tag = strategyTag(ev.strategy_id);
    const coin = (ev.coin || "?").padEnd(6);

    let line;
    if (ev.kind === "open") {
      line = ` ${time}  ${coin}  ${tag}  OPEN  $${(ev.sizeUsd || 0).toFixed(0)}`;
    } else {
      const pnl = ev.pnl != null ? ((ev.pnl >= 0 ? "+" : "") + ev.pnl.toFixed(2)).padStart(7) : "      —";
      const reason = ev.reason ? `  ${ev.reason}` : "";
      line = ` ${time}  ${coin}  ${tag}  ${pnl}${reason}`;
    }
    activityList.addItem(line);
  }

  // Restore selection if valid
  if (selectedIdx < activityData.length) activityList.select(selectedIdx);
  flash(activityList, "cyan");
}

function renderOrderBook(data, err) {
  const label =
    " {cyan-fg}ORDER BOOK{/cyan-fg}  " +
    OB_COINS.map((c, i) => {
      const k = `[${i + 1}]`;
      return i === obCoinIdx ? `{black-fg}{cyan-bg}${k}${c}{/cyan-bg}{/black-fg}` : `{white-fg}${k}${c}{/white-fg}`;
    }).join(" ") + " ";
  obBox.setLabel(label);

  if (err || !data?.levels) {
    obBox.setContent(`\n  {red-fg}${err || "No data"}{/red-fg}`);
    return;
  }

  const asks = (data.levels[1] || []).slice(0, OB_DEPTH).reverse();
  const bids = (data.levels[0] || []).slice(0, OB_DEPTH);
  const allSizes = [...asks, ...bids].map((l) => parseFloat(l.sz));
  const maxSz = Math.max(...allSizes, 0.001);

  let newMid = null;
  if (asks.length && bids.length) {
    newMid = (parseFloat(asks[asks.length - 1].px) + parseFloat(bids[0].px)) / 2;
    if (prevMidPrice !== null) {
      priceDir = newMid > prevMidPrice ? "{green-fg}^{/green-fg}" : newMid < prevMidPrice ? "{red-fg}v{/red-fg}" : " ";
    }
    prevMidPrice = newMid;
  }

  const lines = [];

  for (const lvl of asks) {
    const px = parseFloat(lvl.px);
    const sz = parseFloat(lvl.sz);
    const b = bar(sz / maxSz);
    const pxStr = fmtPrice(px).padStart(10);
    const szStr = sz.toFixed(3).padStart(7);
    lines.push(` {red-fg}${pxStr}  ${b} ${szStr}{/red-fg}`);
  }

  if (newMid !== null) {
    const spread = ((parseFloat(asks[asks.length - 1].px) - parseFloat(bids[0].px)) / newMid * 100).toFixed(3);
    const midStr = fmtPrice(newMid).padStart(10);
    lines.push(` {white-fg}${"-".repeat(10)}  ${priceDir} ${midStr}  ${spread}%{/white-fg}`);
  }

  for (const lvl of bids) {
    const px = parseFloat(lvl.px);
    const sz = parseFloat(lvl.sz);
    const b = bar(sz / maxSz);
    const pxStr = fmtPrice(px).padStart(10);
    const szStr = sz.toFixed(3).padStart(7);
    lines.push(` {green-fg}${pxStr}  ${b} ${szStr}{/green-fg}`);
  }

  obBox.setContent(lines.join("\n"));
}

function renderPnl(data, err) {
  if (err || !data?.periods) {
    pnlBox.setContent(` {red-fg}${err || "Loading..."}{/red-fg}`);
    return;
  }
  const p = data.periods;
  const wr = (period) => (!period?.count ? " —  " : Math.round((period.wins / period.count) * 100).toString().padStart(3) + "%");
  const ct = (period) => String(period?.count || 0).padStart(3) + "tr";
  pnlBox.setContent(
    ` Today  ${fmtPnl(p.today?.totalPnl)}  {white-fg}${ct(p.today)}  ${wr(p.today)}{/white-fg}\n` +
    ` Week   ${fmtPnl(p.week?.totalPnl)}  {white-fg}${ct(p.week)}  ${wr(p.week)}{/white-fg}\n` +
    ` All    ${fmtPnl(p.all?.totalPnl)}  {white-fg}${ct(p.all)}  ${wr(p.all)}{/white-fg}`
  );
}

function showTradeDetail() {
  const idx = activityList.selected;
  if (idx == null || !activityData[idx]) return;
  const ev = activityData[idx];
  const d = new Date(ev.ts);
  const lines = [
    `Coin:     {yellow-fg}${ev.coin || "?"}{/yellow-fg}`,
    `Strategy: {blue-fg}${strategyTag(ev.strategy_id)}{/blue-fg}`,
    `Type:     {cyan-fg}${ev.kind || "close"}{/cyan-fg}`,
    `Time:     ${d.toLocaleString()}`,
    `PnL:      ${fmtPnl(ev.pnl)}`,
    ev.reason ? `Reason:   {white-fg}${ev.reason}{/white-fg}` : "",
    ev.sizeUsd ? `Size:     {white-fg}$${ev.sizeUsd.toFixed(2)}{/white-fg}` : "",
    ev.entryPrice ? `Entry:    {white-fg}${ev.entryPrice}{/white-fg}` : "",
    "",
    "{white-fg}[q/Esc] close{/white-fg}",
  ].filter(Boolean);

  detailBox.setContent(lines.map((l) => "  " + l).join("\n"));
  detailBox.show();
  detailBox.focus();
  screen.render();
}

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function fetchStatus() {
  try { renderStatus(await get(`${BASE}/api/status`), null); }
  catch (e) { renderStatus(null, e.message); }
}

async function fetchEquity() {
  try { renderEquity(await get(`${BASE}/api/history?hours=24`), null); }
  catch (e) { renderEquity(null, e.message); }
}

async function fetchActivity() {
  try { renderActivity(await get(`${BASE}/api/activity?limit=40&hours=48`), null); }
  catch (e) { renderActivity(null, e.message); }
}

async function fetchPnl() {
  try { renderPnl(await get(`${BASE}/api/pnl-summary`), null); }
  catch (e) { renderPnl(null, e.message); }
}

async function fetchOrderBook() {
  const coin = OB_COINS[obCoinIdx];
  try { renderOrderBook(await post(HL_API, { type: "l2Book", coin }), null); }
  catch (e) { renderOrderBook(null, e.message); }
}

async function refreshAll() {
  await Promise.all([fetchStatus(), fetchEquity(), fetchActivity(), fetchPnl()]);
}

// ── Keys ──────────────────────────────────────────────────────────────────────
screen.key(["q", "escape", "C-c"], () => {
  if (detailBox.visible) { detailBox.hide(); activityList.focus(); screen.render(); return; }
  process.exit(0);
});

detailBox.key(["q", "escape"], () => {
  detailBox.hide();
  activityList.focus();
  screen.render();
});

screen.key("r", async () => {
  await Promise.all([refreshAll(), fetchOrderBook()]);
  screen.render();
});

screen.key("tab", () => {
  obCoinIdx = (obCoinIdx + 1) % OB_COINS.length;
  prevMidPrice = null;
  updateHintBar();
  fetchOrderBook().then(() => screen.render());
});

for (let i = 0; i < OB_COINS.length; i++) {
  const idx = i;
  screen.key(String(i + 1), () => {
    obCoinIdx = idx;
    prevMidPrice = null;
    updateHintBar();
    flash(obBox, "yellow");
    fetchOrderBook().then(() => screen.render());
  });
}

activityList.key(["enter"], showTradeDetail);
activityList.on("select", showTradeDetail);

// j/k navigation
screen.key(["j", "down"], () => {
  if (detailBox.visible) return;
  activityList.down(1);
  screen.render();
});
screen.key(["k", "up"], () => {
  if (detailBox.visible) return;
  activityList.up(1);
  screen.render();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
updateHintBar();
activityList.focus();
screen.render();

await login();
await Promise.all([refreshAll(), fetchOrderBook()]);
activityList.focus();
screen.render();

setInterval(async () => { await fetchOrderBook(); screen.render(); }, 3_000);
setInterval(async () => { await fetchStatus(); screen.render(); }, 15_000);
setInterval(async () => {
  await Promise.all([fetchEquity(), fetchActivity(), fetchPnl()]);
  screen.render();
}, 30_000);
