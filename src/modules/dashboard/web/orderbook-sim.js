// ─────────────────────────────────────────────────────────────
//  Тренажёр стакана: механика исполнения на управляемой модели.
//  Цена двигается только твоими сделками — модель объясняет ИЗДЕРЖКИ
//  (проскальзывание, цену стоп-маркета в тонкой монете), а не рынок.
// ─────────────────────────────────────────────────────────────

import "./src/styles/orderbook-sim.scss";

const TICK = 0.5,
  DEPTH = 10,
  START_MID = 100;
let asks = [],
  bids = []; // [{px, sz, mine}] — asks по возрастанию, bids по убыванию
let candles = [],
  cur = null;
let lastEaten = new Set(); // цены, съеденные последней сделкой (для подсветки)
let mmRefill = true;
let lastPx = START_MID; // последняя цена сделки — опора, когда сторона выедена дочиста

const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
const px2 = (p) => p.toFixed(2);
const usd = (v) => (Math.abs(v) >= 1000 ? "$" + (v / 1000).toFixed(1) + "k" : "$" + v.toFixed(2));

function genSide(startPx, dir) {
  const out = [];
  for (let i = 0; i < DEPTH; i++) {
    // изредка «стена» — крупная лимитка, чтобы было видно, как цена об неё тормозит
    const wall = Math.random() < 0.15;
    out.push({
      px: +(startPx + dir * i * TICK).toFixed(2),
      sz: Math.round(wall ? rnd(70, 140) : rnd(12, 38)),
      mine: 0,
    });
  }
  return out;
}

function initBook(mid = START_MID) {
  asks = genSide(mid + TICK, +1);
  bids = genSide(mid - TICK, -1);
}

// Если одну сторону выели дочиста — опираемся на оставшуюся, иначе на последнюю
// сделку. Иначе mid прыгал бы к стартовым 100 и «сдвиг цены» врал бы про 0%.
function midPrice() {
  if (bids.length && asks.length) return (bids[0].px + asks[0].px) / 2;
  // Аски выели дочиста — цена ушла ВВЕРХ, а нетронутые биды остались внизу.
  // Брать их за ориентир нельзя: получилось бы, что покупка двинула цену вниз.
  if (bids.length) return Math.max(lastPx, bids[0].px + TICK / 2);
  if (asks.length) return Math.min(lastPx, asks[0].px - TICK / 2);
  return lastPx;
}
function spread() {
  return bids.length && asks.length ? asks[0].px - bids[0].px : 0;
}

/** Восстановление стакана вокруг новой цены. Пользовательские лимитки сохраняются. */
function refill() {
  const mid = midPrice();
  const mine = [];
  for (const l of asks) if (l.mine > 0) mine.push({ side: "ask", px: l.px, sz: l.mine });
  for (const l of bids) if (l.mine > 0) mine.push({ side: "bid", px: l.px, sz: l.mine });

  const bestAsk = Math.ceil((mid + TICK / 2) / TICK) * TICK;
  const bestBid = Math.floor((mid - TICK / 2) / TICK) * TICK;
  asks = genSide(+bestAsk.toFixed(2), +1);
  bids = genSide(+bestBid.toFixed(2), -1);

  for (const m of mine) addLimit(m.side === "ask" ? "sell" : "buy", m.px, m.sz, true);
}

/** Market order. Returns a fill report or null. */
function marketOrder(side, size) {
  const book = side === "buy" ? asks : bids;
  const midBefore = midPrice();
  const eaten = new Set();
  let left = size,
    notional = 0,
    levels = 0;

  while (left > 0 && book.length) {
    const lvl = book[0];
    const take = Math.min(left, lvl.sz);
    notional += take * lvl.px;
    left -= take;
    lvl.sz -= take;
    if (lvl.mine > 0) lvl.mine = Math.max(0, lvl.mine - take);
    eaten.add(lvl.px);
    if (lvl.sz <= 0.0001) {
      book.shift();
      levels++;
    } else break;
  }

  const filled = size - left;
  if (filled <= 0) return null;

  const avg = notional / filled;
  const midAfter = midPrice();
  lastEaten = eaten;
  pushTrade(avg, filled);

  if (mmRefill)
    setTimeout(() => {
      refill();
      lastEaten = new Set();
      render();
    }, 650);

  return {
    side,
    size,
    filled,
    avg,
    notional,
    levels,
    midBefore,
    midAfter,
    slipAbs: side === "buy" ? avg - midBefore : midBefore - avg,
    slipPct: (side === "buy" ? avg / midBefore - 1 : 1 - avg / midBefore) * 100,
    movePct: (midAfter / midBefore - 1) * 100,
    partial: left > 0 ? left : 0,
  };
}

/** Лимитка: добавляет объём в стакан. Пересекла спред — исполняется как маркет. */
function addLimit(side, price, size, silent) {
  const p = +price.toFixed(2);
  if (side === "buy" && asks.length && p >= asks[0].px) {
    return silent ? null : { crossed: true, report: marketOrder("buy", size) };
  }
  if (side === "sell" && bids.length && p <= bids[0].px) {
    return silent ? null : { crossed: true, report: marketOrder("sell", size) };
  }
  const book = side === "buy" ? bids : asks;
  const at = book.find((l) => Math.abs(l.px - p) < 0.001);
  if (at) {
    at.sz += size;
    at.mine += size;
  } else {
    book.push({ px: p, sz: size, mine: size });
    book.sort((a, b) => (side === "buy" ? b.px - a.px : a.px - b.px));
  }
  return { crossed: false };
}

// ── свечи ──────────────────────────────────────────────────
function pushTrade(price, size) {
  lastPx = price;
  if (!cur) cur = { o: price, h: price, l: price, c: price, v: 0 };
  cur.h = Math.max(cur.h, price);
  cur.l = Math.min(cur.l, price);
  cur.c = price;
  cur.v += size;
}
function newCandle() {
  if (cur) {
    candles.push(cur);
    if (candles.length > 40) candles.shift();
  }
  cur = null;
}

// ─────────────────────────────────────────────────────────────
//  Рендер
// ─────────────────────────────────────────────────────────────
function renderLadder(el, levels, side, maxSz) {
  el.innerHTML = "";
  const list = side === "ask" ? [...levels].reverse() : levels;
  for (const l of list) {
    const wall = l.sz > maxSz * 0.55;
    const row = document.createElement("div");
    row.className = `row ${side}${wall ? " wall" : ""}${l.mine > 0 ? " mine" : ""}${lastEaten.has(l.px) ? " eaten" : ""}`;
    row.innerHTML =
      `<span class="tag">${wall ? "WALL" : ""}</span>` +
      `<span class="px">${px2(l.px)}</span>` +
      `<span class="sz">${Math.round(l.sz)}</span>` +
      `<div class="bar" style="width:${Math.max(3, (l.sz / maxSz) * 100)}%"></div>`;
    row.onclick = () => {
      $("lpx").value = px2(l.px);
    };
    el.appendChild(row);
  }
}

function drawChart() {
  const cv = $("chart"),
    ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth,
    h = cv.clientHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const all = cur ? [...candles, cur] : candles;
  if (!all.length) {
    ctx.fillStyle = "#6b7888";
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText("candles appear after the first trade", w / 2, h / 2);
    return;
  }
  const hi = Math.max(...all.map((c) => c.h)),
    lo = Math.min(...all.map((c) => c.l));
  const pad = (hi - lo) * 0.15 || 1;
  const top = hi + pad,
    bot = lo - pad;
  const y = (p) => h - ((p - bot) / (top - bot)) * h;

  // сетка
  ctx.strokeStyle = "#1e2735";
  ctx.fillStyle = "#6b7888";
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = bot + ((top - bot) * i) / 4,
      yy = Math.round(y(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(w - 44, yy);
    ctx.stroke();
    ctx.fillText(p.toFixed(2), w - 40, yy + 3);
  }

  const cw = Math.min(26, (w - 50) / Math.max(all.length, 8));
  all.forEach((c, i) => {
    const x = i * cw + cw / 2,
      up = c.c >= c.o;
    const forming = cur && i === all.length - 1;
    ctx.strokeStyle = ctx.fillStyle = up ? "#2bbf73" : "#f0556b";
    ctx.globalAlpha = forming ? 0.55 : 1;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y(c.h));
    ctx.lineTo(x, y(c.l));
    ctx.stroke();
    const yo = y(c.o),
      yc = y(c.c);
    ctx.fillRect(x - cw * 0.32, Math.min(yo, yc), cw * 0.64, Math.max(2, Math.abs(yc - yo)));
    ctx.globalAlpha = 1;
  });

  if (cur) {
    ctx.strokeStyle = "#e8b84b";
    ctx.setLineDash([3, 3]);
    ctx.globalAlpha = 0.6;
    const yy = Math.round(y(cur.c)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(w - 44, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#e8b84b";
    ctx.textAlign = "left";
    ctx.fillText("candle forming", 4, yy - 5);
  }
}

function render() {
  const maxSz = Math.max(...asks.map((l) => l.sz), ...bids.map((l) => l.sz), 1);
  renderLadder($("asks"), asks, "ask", maxSz);
  renderLadder($("bids"), bids, "bid", maxSz);
  $("midPx").textContent = px2(midPrice());
  $("spread").textContent = px2(spread());
  drawChart();
}

function showFill(r, crossed) {
  if (!r) {
    $("fillCard").innerHTML = '<div class="empty">not enough liquidity — the book is empty</div>';
    return;
  }
  const dir = r.side === "buy" ? "buy" : "sell";
  const rows = [
    ["side", dir, ""],
    [
      "filled",
      `${Math.round(r.filled)}${r.partial ? ` (${Math.round(r.partial)} unfilled)` : ""}`,
      r.partial ? "bad" : "",
    ],
    ["average price", px2(r.avg), ""],
    ["mid before the click", px2(r.midBefore), ""],
    ["slippage", `${px2(r.slipAbs)} / ${r.slipPct.toFixed(3)}%`, "gold"],
    ["extra cost", usd(r.slipAbs * r.filled), "bad"],
    ["levels eaten", String(r.levels), ""],
    [
      "price moved",
      `${r.movePct >= 0 ? "+" : ""}${r.movePct.toFixed(2)}%`,
      r.movePct >= 0 ? "good" : "bad",
    ],
  ];
  $("fillCard").innerHTML =
    (crossed
      ? '<div class="hint" style="margin-bottom:8px"><span class="gold">The limit order crossed the spread</span> → it filled like a market order. A limit order protects you from slippage only while it rests BEHIND the spread.'
      : "") +
    rows.map(([k, v, c]) => `<div class="kv"><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`).join("");
}

// ─────────────────────────────────────────────────────────────
//  Живая глубина HL — сколько $ двигают цену на 0.5%
// ─────────────────────────────────────────────────────────────
async function measureReal() {
  const coin = $("realCoin").value.trim();
  $("realOut").innerHTML = '<div class="empty">requesting…</div>';
  try {
    const meta = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    }).then((r) => r.json());
    const asset = meta.universe.find((a) => a.name.toUpperCase() === coin.toUpperCase());
    if (!asset) throw new Error(`coin "${coin}" not found`);

    const cost = async (name) => {
      const b = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin: name }),
      }).then((r) => r.json());
      const [bd, ak] = b.levels;
      const mid = (Number(bd[0].px) + Number(ak[0].px)) / 2;
      const walk = (levels, target, up) => {
        let sum = 0;
        for (const l of levels) {
          const p = Number(l.px);
          if (up ? p > target : p < target) break;
          sum += p * Number(l.sz);
        }
        return sum;
      };
      return { mid, up: walk(ak, mid * 1.005, true), down: walk(bd, mid * 0.995, false) };
    };

    const [c, btc] = await Promise.all([cost(asset.name), cost("BTC")]);
    const ratio = btc.up / c.up;
    $("realOut").innerHTML =
      `<div class="kv"><span class="k">${asset.name} · up 0.5%</span><span class="v gold">${usd(c.up)}</span></div>` +
      `<div class="kv"><span class="k">${asset.name} · down 0.5%</span><span class="v gold">${usd(c.down)}</span></div>` +
      `<div class="kv"><span class="k">BTC · up 0.5%</span><span class="v">${usd(btc.up)}</span></div>` +
      `<div class="hint" style="margin-top:9px">BTC is <b>${ratio.toFixed(0)}×</b> deeper. Your size moves neither market — depth matters not for the entry but for the <b>stop</b>: the thinner the book, the more a stop-market costs you.</div>`;
  } catch (e) {
    $("realOut").innerHTML = `<div class="hint"><span class="gold">failed:</span> ${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────
//  События
// ─────────────────────────────────────────────────────────────
const qty = () => Math.max(1, Math.round(Number($("qty").value) || 0));
const lpx = () => Number($("lpx").value) || midPrice();

$("mBuy").onclick = () => {
  showFill(marketOrder("buy", qty()), false);
  render();
};
$("mSell").onclick = () => {
  showFill(marketOrder("sell", qty()), false);
  render();
};
$("lBuy").onclick = () => {
  const r = addLimit("buy", lpx(), qty());
  if (r && r.crossed) showFill(r.report, true);
  render();
};
$("lSell").onclick = () => {
  const r = addLimit("sell", lpx(), qty());
  if (r && r.crossed) showFill(r.report, true);
  render();
};
$("newCandle").onclick = () => {
  newCandle();
  render();
};
$("reset").onclick = () => {
  initBook();
  candles = [];
  cur = null;
  lastEaten = new Set();
  $("fillCard").innerHTML = '<div class="empty">make your first trade</div>';
  render();
};
$("mm").onchange = (e) => {
  mmRefill = e.target.checked;
};
$("realBtn").onclick = measureReal;
window.addEventListener("resize", drawChart);

initBook();
render();
