#!/usr/bin/env node
/**
 * Terminal dashboard — blessed-contrib
 * Usage: node tools/tui.js [--url http://localhost:3010]
 *
 * Keys:
 *   1/2/3    switch orderbook coin (BTC / ETH / SOL)
 *   Tab      cycle orderbook coin
 *   j / ↓   scroll activity down
 *   k / ↑   scroll activity up
 *   r        force refresh all
 *   q / Esc  quit
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
  urlIdx !== -1
    ? args[urlIdx + 1]
    : process.env.DASHBOARD_URL || "http://localhost:3010";
const HL_API = "https://api.hyperliquid.xyz/info";

// Basic Auth header for dashboard (optional)
const AUTH_USER = process.env.DASHBOARD_AUTH_USER || "";
const AUTH_PASS = process.env.DASHBOARD_AUTH_PASS || "";
const AUTH_HEADER =
  AUTH_USER && AUTH_PASS
    ? "Basic " + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64")
    : null;
const OB_COINS = ["BTC", "ETH", "SOL"];
const OB_DEPTH = 8;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const opts = { headers: {} };
    if (AUTH_HEADER && url.startsWith(BASE)) opts.headers["Authorization"] = AUTH_HEADER;
    const req = mod
      .get(url, opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 401) { reject(new Error("401 Unauthorized — set DASHBOARD_AUTH_USER/PASS")); return; }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("JSON parse: " + e.message));
          }
        });
      })
      .on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("JSON parse"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

// ── Screen & grid ─────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true,
  title: "HL Scanner",
  fullUnicode: true,
});
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// Left col 0-7
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

const activityLog = grid.set(5, 0, 7, 8, contrib.log, {
  label: " {cyan-fg}ACTIVITY{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  scrollable: true,
  mouse: true,
  keys: true,
  style: { scrollbar: { bg: "cyan" } },
  scrollbar: { ch: "│" },
});

// Right col 8-11
const statusBox = grid.set(0, 8, 3, 4, blessed.box, {
  label: " {cyan-fg}STATUS{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  padding: { left: 1, right: 1 },
  content: " Loading…",
});

const obBox = grid.set(3, 8, 6, 4, blessed.box, {
  label: " {cyan-fg}ORDER BOOK{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  padding: { left: 0, right: 0 },
  content: " Loading…",
});

const pnlBox = grid.set(9, 8, 3, 4, blessed.box, {
  label: " {cyan-fg}PnL{/cyan-fg} ",
  tags: true,
  border: { type: "line", fg: "cyan" },
  padding: { left: 1, right: 1 },
  content: " Loading…",
});

// ── State ─────────────────────────────────────────────────────────────────────
let obCoinIdx = 0;

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtPnl(v) {
  if (v == null || isNaN(v)) return "{white-fg}—{/white-fg}";
  const s = (v >= 0 ? "+" : "") + v.toFixed(2);
  return v >= 0 ? `{green-fg}${s}{/green-fg}` : `{red-fg}${s}{/red-fg}`;
}

function fmtDot(status) {
  if (status === "ok") return "{green-fg}●{/green-fg}";
  if (status === "booting") return "{yellow-fg}●{/yellow-fg}";
  return "{red-fg}●{/red-fg}";
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
  const map = {
    hunter_short: "SHORT",
    hunter_long: "LONG ",
    trend_follow: "CHILL",
    carry: "CARRY",
    manual: "HAND ",
  };
  return map[id] || (id || "—").padEnd(5);
}

function bar(frac, width = 9) {
  const full = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return "█".repeat(full) + "░".repeat(width - full);
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
  const strat = data.slotStrategy
    ? `{blue-fg}${strategyTag(data.slotStrategy)}{/blue-fg}`
    : "—";
  statusBox.setContent(
    ` Bot     ${dot} {white-fg}${data.status || "?"}{/white-fg}\n` +
      ` Uptime  {white-fg}${fmtUptime(data.uptimeMs)}{/white-fg}\n` +
      ` Tick    {white-fg}${fmtAge(data.tickAgeMs)}{/white-fg}\n` +
      ` Slot    {${slotColor}}${data.slot || "?"}{/${slotColor}}\n` +
      ` Coin    ${coin}\n` +
      ` Strat   ${strat}`
  );
}

function renderEquity(data, err) {
  if (err || !data?.points || data.points.length < 2) {
    equityChart.setData([
      { title: "eq", x: ["—"], y: [0], style: { line: "cyan" } },
    ]);
    return;
  }
  const pts = data.points;
  const eq = data.currentEquity || 0;

  const step = Math.max(1, Math.floor(pts.length / 6));
  const xs = pts.map((p, i) => {
    if (i % step !== 0) return "";
    const d = new Date(p.ts);
    return (
      d.getHours().toString().padStart(2, "0") +
      ":" +
      d.getMinutes().toString().padStart(2, "0")
    );
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
  if (err) {
    activityLog.log(`{red-fg}Error: ${err}{/red-fg}`);
    return;
  }
  if (!data?.events) return;

  const sorted = [...data.events].sort((a, b) => b.ts - a.ts).slice(0, 30);
  activityLog.setContent("");

  for (const ev of sorted) {
    const d = new Date(ev.ts);
    const time =
      d.getHours().toString().padStart(2, "0") +
      ":" +
      d.getMinutes().toString().padStart(2, "0");
    const tag = `{blue-fg}${strategyTag(ev.strategy_id)}{/blue-fg}`;
    const coin = `{yellow-fg}${(ev.coin || "?").padEnd(6)}{/yellow-fg}`;

    let line;
    if (ev.kind === "open") {
      line = ` {white-fg}${time}{/white-fg}  ${coin}  ${tag}  {cyan-fg}OPEN{/cyan-fg}  $${(ev.sizeUsd || 0).toFixed(0)}`;
    } else {
      const reason = ev.reason ? `  {white-fg}${ev.reason}{/white-fg}` : "";
      line = ` {white-fg}${time}{/white-fg}  ${coin}  ${tag}  ${fmtPnl(ev.pnl)}${reason}`;
    }
    activityLog.log(line);
  }
}

function renderOrderBook(data, err) {
  const label =
    " {cyan-fg}ORDER BOOK{/cyan-fg}  " +
    OB_COINS.map((c, i) => {
      const k = `[${i + 1}]`;
      return i === obCoinIdx
        ? `{cyan-fg}{bold}${k}${c}{/bold}{/cyan-fg}`
        : `{white-fg}${k}${c}{/white-fg}`;
    }).join(" ") +
    " ";
  obBox.setLabel(label);

  if (err || !data?.levels) {
    obBox.setContent(`\n  {red-fg}${err || "No data"}{/red-fg}`);
    return;
  }

  const asks = (data.levels[1] || []).slice(0, OB_DEPTH).reverse();
  const bids = (data.levels[0] || []).slice(0, OB_DEPTH);
  const allSizes = [...asks, ...bids].map((l) => parseFloat(l.sz));
  const maxSz = Math.max(...allSizes, 0.001);

  const lines = [];

  for (const lvl of asks) {
    const px = parseFloat(lvl.px);
    const sz = parseFloat(lvl.sz);
    const b = bar(sz / maxSz);
    const pxStr = formatPrice(px).padStart(11);
    const szStr = sz.toFixed(3).padStart(8);
    lines.push(` {red-fg}${pxStr}  ${b}  ${szStr}{/red-fg}`);
  }

  if (asks.length && bids.length) {
    const topAsk = parseFloat(asks[asks.length - 1].px);
    const topBid = parseFloat(bids[0].px);
    const mid = ((topAsk + topBid) / 2);
    const spread = ((topAsk - topBid) / mid * 100).toFixed(3);
    const midStr = formatPrice(mid).padStart(11);
    lines.push(` {white-fg}${"─".repeat(11)}  {bold}${midStr}{/bold}  ${spread}%{/white-fg}`);
  }

  for (const lvl of bids) {
    const px = parseFloat(lvl.px);
    const sz = parseFloat(lvl.sz);
    const b = bar(sz / maxSz);
    const pxStr = formatPrice(px).padStart(11);
    const szStr = sz.toFixed(3).padStart(8);
    lines.push(` {green-fg}${pxStr}  ${b}  ${szStr}{/green-fg}`);
  }

  obBox.setContent(lines.join("\n"));
}

function formatPrice(px) {
  if (px < 1) return px.toFixed(5);
  if (px < 100) return px.toFixed(3);
  if (px < 10000) return px.toFixed(2);
  return px.toFixed(1);
}

function renderPnl(data, err) {
  if (err || !data?.periods) {
    pnlBox.setContent(` {red-fg}${err || "Loading…"}{/red-fg}`);
    return;
  }
  const p = data.periods;
  const wr = (period) => {
    if (!period?.count) return " —  ";
    return Math.round((period.wins / period.count) * 100).toString().padStart(3) + "%";
  };
  const ct = (period) => String(period?.count || 0).padStart(3) + "tr";
  pnlBox.setContent(
    ` Today  ${fmtPnl(p.today?.totalPnl)}  {white-fg}${ct(p.today)}  ${wr(p.today)}{/white-fg}\n` +
      ` Week   ${fmtPnl(p.week?.totalPnl)}  {white-fg}${ct(p.week)}  ${wr(p.week)}{/white-fg}\n` +
      ` All    ${fmtPnl(p.all?.totalPnl)}  {white-fg}${ct(p.all)}  ${wr(p.all)}{/white-fg}`
  );
}

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function fetchStatus() {
  try {
    renderStatus(await get(`${BASE}/api/status`), null);
  } catch (e) {
    renderStatus(null, e.message);
  }
}

async function fetchEquity() {
  try {
    renderEquity(await get(`${BASE}/api/history?hours=24`), null);
  } catch (e) {
    renderEquity(null, e.message);
  }
}

async function fetchActivity() {
  try {
    renderActivity(await get(`${BASE}/api/activity?limit=30&hours=48`), null);
  } catch (e) {
    renderActivity(null, e.message);
  }
}

async function fetchPnl() {
  try {
    renderPnl(await get(`${BASE}/api/pnl-summary`), null);
  } catch (e) {
    renderPnl(null, e.message);
  }
}

async function fetchOrderBook() {
  const coin = OB_COINS[obCoinIdx];
  try {
    renderOrderBook(await post(HL_API, { type: "l2Book", coin }), null);
  } catch (e) {
    renderOrderBook(null, e.message);
  }
}

async function refreshAll() {
  await Promise.all([fetchStatus(), fetchEquity(), fetchActivity(), fetchPnl()]);
}

// ── Keys ──────────────────────────────────────────────────────────────────────
screen.key(["q", "escape", "C-c"], () => process.exit(0));

screen.key("r", async () => {
  await Promise.all([refreshAll(), fetchOrderBook()]);
  screen.render();
});

screen.key("tab", () => {
  obCoinIdx = (obCoinIdx + 1) % OB_COINS.length;
  fetchOrderBook().then(() => screen.render());
});

for (let i = 0; i < OB_COINS.length; i++) {
  const idx = i;
  screen.key(String(i + 1), () => {
    obCoinIdx = idx;
    fetchOrderBook().then(() => screen.render());
  });
}

screen.key(["j", "down"], () => {
  activityLog.scroll(1);
  screen.render();
});
screen.key(["k", "up"], () => {
  activityLog.scroll(-1);
  screen.render();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
screen.render();

await Promise.all([refreshAll(), fetchOrderBook()]);
screen.render();

setInterval(async () => {
  await fetchOrderBook();
  screen.render();
}, 3_000);

setInterval(async () => {
  await fetchStatus();
  screen.render();
}, 15_000);

setInterval(async () => {
  await Promise.all([fetchEquity(), fetchActivity(), fetchPnl()]);
  screen.render();
}, 30_000);
