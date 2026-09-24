// ─────────────────────────────────────────────────────────────
//  Тренажёр стакана: механика исполнения на управляемой модели.
//  Цена двигается только твоими сделками — модель объясняет ИЗДЕРЖКИ
//  (проскальзывание, цену стоп-маркета в тонкой монете), а не рынок.
// ─────────────────────────────────────────────────────────────

import "./src/styles/orderbook.scss";
import "./src/styles/orderbook-sim.scss";
import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import { segmented } from "./src/core/ui.js";
import { initReveal } from "./src/core/reveal.js";
import { ladderRows } from "./src/features/bookLadder.js";
import { mountSimChart, drawSimCandles, applySimTheme } from "./src/charts/simChart.js";

mountTopnav("orderbook-sim");
mountPageHeader({
  eyebrow: "Research · execution mechanics",
  title: "Order book trainer",
  note: "Price here moves only from your own trades. This models cost, not the market.",
});
bindTheme([applySimTheme]);
startFooterTimer();

const TICK = 0.5,
  DEPTH = 10,
  START_MID = 100;
let asks = [],
  bids = []; // [{px, sz, mine}] — asks по возрастанию, bids по убыванию
let candles = [],
  cur = null;
let seq = 0; // порядковый номер свечи — её «время» на шкале
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
  if (!cur) cur = { n: seq++, o: price, h: price, l: price, c: price, v: 0 };
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
  const list = side === "ask" ? [...levels].reverse() : levels;
  el.innerHTML = ladderRows(
    list.map((l) => ({
      ...l,
      wall: l.sz > maxSz * 0.55,
      eaten: lastEaten.has(l.px),
    })),
    { side, maxSz, cells: (l) => [px2(l.px), String(Math.round(l.sz)), l.mine > 0 ? `mine ${Math.round(l.mine)}` : ""] },
  );
  if (side === "ask") el.scrollTop = el.scrollHeight;
}

function render() {
  const maxSz = Math.max(...asks.map((l) => l.sz), ...bids.map((l) => l.sz), 1);
  renderLadder($("asks"), asks, "ask", maxSz);
  renderLadder($("bids"), bids, "bid", maxSz);
  $("midPx").textContent = px2(midPrice());
  $("spread").textContent = px2(spread());
  drawSimCandles(candles, cur);
  $("chartHint").hidden = candles.length > 0 || cur != null;
}

const kvTable = (rows) =>
  `<table class="table table--compact obs-kv"><tbody>${rows
    .map(([k, v, c]) => `<tr><td class="muted">${k}</td><td class="num mono ${c}">${v}</td></tr>`)
    .join("")}</tbody></table>`;

function showFill(r, crossed) {
  if (!r) {
    $("fillCard").innerHTML = '<div class="obs-empty">Not enough liquidity — the book is empty.</div>';
    return;
  }
  const rows = [
    ["Side", r.side, ""],
    [
      "Filled",
      `${Math.round(r.filled)}${r.partial ? ` (${Math.round(r.partial)} unfilled)` : ""}`,
      r.partial ? "down" : "",
    ],
    ["Average price", px2(r.avg), ""],
    ["Mid before the click", px2(r.midBefore), ""],
    ["Slippage", `${px2(r.slipAbs)} / ${r.slipPct.toFixed(3)}%`, "obs-warn"],
    ["Extra cost", usd(r.slipAbs * r.filled), "down"],
    ["Levels eaten", String(r.levels), ""],
    ["Price moved", `${r.movePct >= 0 ? "+" : ""}${r.movePct.toFixed(2)}%`, r.movePct >= 0 ? "up" : "down"],
  ];
  $("fillCard").innerHTML =
    (crossed
      ? '<p class="obs-note obs-note--warn">The limit order crossed the spread, so it filled like a market order. A limit order protects you from slippage only while it rests behind the spread.</p>'
      : "") + kvTable(rows);
}

// ─────────────────────────────────────────────────────────────
//  Живая глубина HL — сколько $ двигают цену на 0.5%
// ─────────────────────────────────────────────────────────────
async function measureReal() {
  const coin = $("realCoin").value.trim();
  $("realOut").innerHTML = '<div class="obs-empty">Requesting…</div>';
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
      kvTable([
        [`${asset.name} · up 0.5%`, usd(c.up), "obs-warn"],
        [`${asset.name} · down 0.5%`, usd(c.down), "obs-warn"],
        ["BTC · up 0.5%", usd(btc.up), ""],
      ]) +
      `<p class="obs-note">BTC is <b>${ratio.toFixed(0)}×</b> deeper. Your size moves neither market — depth matters not for the entry but for the <b>stop</b>: the thinner the book, the more a stop-market costs you.</p>`;
  } catch (e) {
    $("realOut").innerHTML = `<p class="obs-note obs-note--warn">Failed: ${e.message}</p>`;
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
  seq = 0;
  $("fillCard").innerHTML = '<div class="obs-empty">Make your first trade.</div>';
  render();
};
function mountRefill() {
  $("mm").innerHTML = segmented({
    name: "mm",
    value: mmRefill ? "on" : "off",
    options: [
      { value: "on", label: "Refill the book" },
      { value: "off", label: "Thin coin" },
    ],
  });
}
$("mm").onclick = (e) => {
  const v = e.target.closest("[data-mm]")?.dataset.mm;
  if (!v) return;
  mmRefill = v === "on";
  mountRefill();
};
$("realBtn").onclick = measureReal;

// Клик по строке стакана подставляет её цену в лимитку.
for (const id of ["asks", "bids"]) {
  $(id).addEventListener("click", (e) => {
    const p = e.target.closest("[data-px]")?.dataset.px;
    if (p) $("lpx").value = px2(Number(p));
  });
}

mountRefill();
initBook();
mountSimChart($("chart")).then(render);
render();
initReveal();
