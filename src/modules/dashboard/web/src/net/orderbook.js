// ─────────────────────────────────────────────────
//  Order-book Imbalance (HL public WS)
//  Subscribes to l2Book for the coin currently shown in price-card and renders
//  a bid/ask imbalance bar (sum of USD-notional within ±0.5% of mid).
//  Своё WS-состояние, без зависимостей от остального main.js.
// ─────────────────────────────────────────────────

const OB_RANGE = 0.005;
let obWs = null;
let obCoin = null;
let obReconnectTimer = null;

export function subscribeOrderBook(coin) {
  if (obCoin === coin && obWs && obWs.readyState === WebSocket.OPEN) return;
  if (obReconnectTimer) {
    clearTimeout(obReconnectTimer);
    obReconnectTimer = null;
  }
  obCoin = coin;
  if (obWs) {
    try {
      obWs.close();
    } catch {}
    obWs = null;
  }
  if (!coin) {
    renderOrderBookBar(null);
    return;
  }
  openObWs(coin);
}

function openObWs(coin) {
  let ws;
  try {
    ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  } catch {
    return;
  }
  obWs = ws;
  ws.onopen = () => {
    if (obCoin !== coin || obWs !== ws) return;
    ws.send(
      JSON.stringify({
        method: "subscribe",
        subscription: { type: "l2Book", coin },
      }),
    );
  };
  ws.onmessage = (e) => {
    if (obCoin !== coin || obWs !== ws) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.channel === "l2Book" && msg.data && msg.data.coin === coin) {
        renderOrderBookBar(msg.data);
      }
    } catch {}
  };
  ws.onclose = () => {
    if (obWs !== ws) return;
    obWs = null;
    if (obCoin === coin) {
      obReconnectTimer = setTimeout(() => {
        if (obCoin === coin) openObWs(coin);
      }, 2000);
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function renderOrderBookBar(data) {
  const wrap = document.getElementById("orderbook-bar");
  if (!wrap) return;
  if (!data || !Array.isArray(data.levels) || data.levels.length < 2) {
    wrap.style.display = "none";
    return;
  }
  const bids = data.levels[0] || [];
  const asks = data.levels[1] || [];
  if (!bids.length || !asks.length) {
    wrap.style.display = "none";
    return;
  }
  const bestBid = Number(bids[0].px);
  const bestAsk = Number(asks[0].px);
  if (!(bestBid > 0) || !(bestAsk > 0)) {
    wrap.style.display = "none";
    return;
  }
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - OB_RANGE);
  const hi = mid * (1 + OB_RANGE);
  let bidUsd = 0,
    askUsd = 0;
  for (const lv of bids) {
    const px = Number(lv.px),
      sz = Number(lv.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    if (px < lo) break;
    bidUsd += px * sz;
  }
  for (const lv of asks) {
    const px = Number(lv.px),
      sz = Number(lv.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    if (px > hi) break;
    askUsd += px * sz;
  }
  const total = bidUsd + askUsd;
  if (total <= 0) {
    wrap.style.display = "none";
    return;
  }
  const bidPct = (bidUsd / total) * 100;
  const askPct = 100 - bidPct;
  wrap.style.display = "flex";
  const bidEl = document.getElementById("orderbook-bid");
  const askEl = document.getElementById("orderbook-ask");
  const labelEl = document.getElementById("orderbook-label");
  if (bidEl) bidEl.style.flexBasis = bidPct.toFixed(2) + "%";
  if (askEl) askEl.style.flexBasis = askPct.toFixed(2) + "%";
  if (labelEl)
    labelEl.textContent = `bids ${bidPct.toFixed(0)}% / asks ${askPct.toFixed(0)}% · ±0.5%`;
}
