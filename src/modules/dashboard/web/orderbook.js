import "./src/styles/orderbook.scss";
import { mountPageHeader } from "./src/core/pageHeader.js";
// ─────────────────────────────────────────────────
//  orderbook.html — живой стакан Hyperliquid (DOM-лесенка).
//  Коннектится НАПРЯМУЮ к публичному WS HL (как web/src/net/orderbook.js),
//  минуя Express и торгового бота — только чтение, ничего не торгует.
//  Заточка под вопрос «где входить»: подсветка крупных лимиток (стен) =
//  реальные уровни поддержки/сопротивления + давление bid/ask у центра.
// ─────────────────────────────────────────────────

import { bindTheme } from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";

mountPageHeader({
  eyebrow: "Order Book",
  title: "Hyperliquid order book · live",
  note:
    "Level confirmation from real resting limit orders. Read only.",
});
mountTopnav("orderbook");
bindTheme();

const COINS = ["HYPE", "SOL", "BTC"];
const WS_URL = "wss://api.hyperliquid.xyz/ws";
const IMB_RANGE = 0.005; // ±0.5% для давления
const WALL_MULT = 3.0; // стена = ≥3× медианы стороны
const DEPTH = 16; // уровней на сторону

let coin = "HYPE";
let ws = null;
let reconnectT = null;

// ── табы монет ──
const tabsEl = document.getElementById("ob-tabs");
COINS.forEach((c) => {
  const b = document.createElement("div");
  b.className = "ob-tab" + (c === coin ? " active" : "");
  b.textContent = c;
  b.dataset.coin = c;
  b.onclick = () => setCoin(c);
  tabsEl.appendChild(b);
});
const customEl = document.getElementById("ob-custom");
customEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && customEl.value.trim()) setCoin(customEl.value.trim().toUpperCase());
});

function setCoin(c) {
  if (c === coin) return;
  coin = c;
  const preset = COINS.includes(c);
  document.querySelectorAll(".ob-tab").forEach((t) => t.classList.toggle("active", t.dataset.coin === c));
  customEl.classList.toggle("active", !preset);
  customEl.value = preset ? "" : c;
  resubscribe();
}

// ── WS ──
function connect() {
  setDot("dead", "reconnecting…");
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    setDot("live", "live · " + coin);
    subscribe();
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.channel === "l2Book" && m.data && m.data.coin === coin) render(m.data);
    } catch {}
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}
function subscribe() {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin } }));
}
function resubscribe() {
  setDot(ws && ws.readyState === 1 ? "live" : "dead", "switching → " + coin);
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  connect();
}
function scheduleReconnect() {
  if (reconnectT) return;
  reconnectT = setTimeout(() => {
    reconnectT = null;
    connect();
  }, 2000);
}
function setDot(cls, txt) {
  const d = document.getElementById("ob-dot");
  d.className = "ob-dot " + cls;
  document.getElementById("ob-connTxt").textContent = txt;
}

// ── форматирование ──
function fmtPx(p) {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(3);
  return p.toPrecision(4);
}
function fmtUsd(v) {
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── рендер ──
function render(data) {
  const bids = (data.levels[0] || []).slice(0, DEPTH).map((l) => ({ px: +l.px, sz: +l.sz }));
  const asks = (data.levels[1] || []).slice(0, DEPTH).map((l) => ({ px: +l.px, sz: +l.sz }));
  if (!bids.length || !asks.length) return;

  const bestBid = bids[0].px,
    bestAsk = asks[0].px;
  const mid = (bestBid + bestAsk) / 2;
  const maxSz = Math.max(...bids.map((b) => b.sz), ...asks.map((a) => a.sz));
  const wallThr = Math.max(median([...bids, ...asks].map((l) => l.sz)) * WALL_MULT, maxSz * 0.5);

  document.getElementById("ob-midPx").textContent = fmtPx(mid);
  const spr = bestAsk - bestBid;
  document.getElementById("ob-spread").textContent = fmtPx(spr) + " (" + ((spr / mid) * 100).toFixed(3) + "%)";

  renderSide("ob-asks", [...asks].reverse(), "ask", maxSz, wallThr, mid);
  renderSide("ob-bids", bids, "bid", maxSz, wallThr, mid);
  renderImbalance(bids, asks, mid);
  renderWalls(bids, asks, wallThr, mid);
}

function renderSide(elId, levels, side, maxSz, wallThr, mid) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  for (const l of levels) {
    const isWall = l.sz >= wallThr;
    const row = document.createElement("div");
    row.className = "ob-row " + side + (isWall ? " wall" : "");
    const w = Math.max(2, (l.sz / maxSz) * 100);
    const dist = ((l.px - mid) / mid) * 100;
    row.innerHTML =
      `<span class="ob-bar" style="width:${w}%"></span>` +
      `<span class="ob-tag"></span>` +
      `<span class="ob-px">${fmtPx(l.px)}</span>` +
      `<span class="ob-sz">${l.sz.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>` +
      `<span class="ob-usd">${(dist >= 0 ? "+" : "") + dist.toFixed(2)}%</span>`;
    el.appendChild(row);
  }
  if (side === "ask") el.scrollTop = el.scrollHeight; // ближние аски — у центра
}

function renderImbalance(bids, asks, mid) {
  const lo = mid * (1 - IMB_RANGE),
    hi = mid * (1 + IMB_RANGE);
  let bUsd = 0,
    aUsd = 0;
  for (const b of bids) {
    if (b.px < lo) break;
    bUsd += b.px * b.sz;
  }
  for (const a of asks) {
    if (a.px > hi) break;
    aUsd += a.px * a.sz;
  }
  const tot = bUsd + aUsd || 1;
  const bp = (bUsd / tot) * 100;
  document.getElementById("ob-imbB").style.flexBasis = bp + "%";
  document.getElementById("ob-imbA").style.flexBasis = 100 - bp + "%";
  document.getElementById("ob-imbBt").textContent = "bids " + bp.toFixed(0) + "% · " + fmtUsd(bUsd);
  document.getElementById("ob-imbAt").textContent = fmtUsd(aUsd) + " · asks " + (100 - bp).toFixed(0) + "%";
  let h;
  if (bp >= 62) h = '<span style="color:var(--ob-bid)">Buyers pressing</span> — backdrop favours upside.';
  else if (bp <= 38) h = '<span style="color:var(--ob-ask)">Sellers pressing</span> — backdrop favours downside.';
  else h = "Balanced — no clear skew.";
  document.getElementById("ob-imbHint").innerHTML = h;
}

function renderWalls(bids, asks, wallThr, mid) {
  const ceil = asks.find((a) => a.sz >= wallThr);
  const floor = bids.find((b) => b.sz >= wallThr);
  const ceilPx = document.getElementById("ob-ceilPx"),
    ceilD = document.getElementById("ob-ceilD");
  const floorPx = document.getElementById("ob-floorPx"),
    floorD = document.getElementById("ob-floorD");
  if (ceil) {
    ceilPx.textContent = fmtPx(ceil.px);
    ceilD.textContent = "+" + (((ceil.px - mid) / mid) * 100).toFixed(2) + "% · " + fmtUsd(ceil.px * ceil.sz);
  } else {
    ceilPx.textContent = "none";
    ceilD.textContent = "";
  }
  if (floor) {
    floorPx.textContent = fmtPx(floor.px);
    floorD.textContent = (((floor.px - mid) / mid) * 100).toFixed(2) + "% · " + fmtUsd(floor.px * floor.sz);
  } else {
    floorPx.textContent = "none";
    floorD.textContent = "";
  }
}

connect();
