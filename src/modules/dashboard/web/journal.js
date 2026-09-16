// ─────────────────────────────────────────────────
//  Journal — журнал чтения графика (дрилл «на сутки вперёд»).
//  Читает свечи/цену HL напрямую (publicWS/REST), ничего не торгует.
//  Цикл: читаю (разметка сценариев) → проверяю (прошлая) → журнал. По 3 якорным
//  монетам (BTC/HYPE/SOL) + любая своя. Хранение — localStorage.
//
//  🚨 Страница держит СВОЙ сокет к HL и 20-секундный опрос свечей: и то, и
//  другое обязано гаснуть при уходе, иначе сокет переподключается вечно.
// ─────────────────────────────────────────────────
import "./src/styles/journal.scss";
import { icon, paintIcons } from "./src/core/icon.js";
import { analyzeMultiTF } from "../../chartCoach.js";
import { segmented } from "./src/core/ui.js";
import { mountTradeLog, setUrlCoin } from "./src/features/tradeLog.js";

const COINS = ["BTC", "HYPE", "SOL"];
const KEY = "helm_chartjournal_v1";
const COINS_KEY = "helm_cj_coins";
let coin = "BTC";
let customCoins = JSON.parse(localStorage.getItem(COINS_KEY) || "[]");
const allCoins = () => [...COINS, ...customCoins];

const SEED_DATE = "2026-06-30";
const SEED = {
  BTC: { trend: "down", regime: "range", px: "$59.3k",
    resAbove: "60.2–60.8k / 61.9k", supBelow: "58.9k / 58.3k / 58.0k (week low)",
    scenA: "holds the 58.3–58.9 floor → bounce to 60.2–60.8 (sell the rally, do not buy the turn)",
    scenB: "loses 58.06k on volume → continuation down, air pocket ~56k (more likely with the 1D trend)",
    bias: "sell rallies into 60.2–60.8; a long against the trend is a knife", rr: "short from 60.5, stop beyond 61.1, target 58.3 → ~1:3" },
  HYPE: { trend: "range", regime: "range", px: "$65.4",
    resAbove: "67.8 (Jun 29 high) / 69.6", supBelow: "64.9 (today's low) / 60.5–60.9 / 58.3 (week low)",
    scenA: "holds 63.9–64.9 → pushes to 67.8, then 69.6", scenB: "loses 64 → back into the 60.5–58.3 zone",
    bias: "stronger than BTC (decorrelation ~0.46); buy pullbacks to support / sell into 67.8–69.6. WIDER stops — 6–12% daily range",
    rr: "long from 65 while 64.9 holds, stop under 63.8, target 67.8 → ~1:2.5" },
  SOL: { trend: "up", regime: "up", px: "$73.6",
    resAbove: "76.6 (Jun 29 high) / above that, air", supBelow: "73.3 (today's low) / 70.2–70.4 / 68 / 64 (week low)",
    scenA: "holds 70.4–73.3 → retest of 76.6 and higher", scenB: "loses 70 → pullback to 68, then 64",
    bias: "strongest of the three against BTC weakness; buy pullbacks to 70–73, 76.6 = ceiling / take-profit target",
    rr: "better to wait for a pullback to 70.4 for a long (stop under 70, target 76.6 → ~1:2); from 73.3 the R:R is thin" },
};

const db = JSON.parse(localStorage.getItem(KEY) || "{}");
if (!Object.keys(db).length) {
  for (const c of COINS) db[c] = { [SEED_DATE]: { ...SEED[c], ts: Date.parse(SEED_DATE) } };
  localStorage.setItem(KEY, JSON.stringify(db));
}
function saveDb() { localStorage.setItem(KEY, JSON.stringify(db)); }
function entries(c) { return db[c] || (db[c] = {}); }
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function fmtPx(n) {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 4 });
}
const G = (id) => document.getElementById(id);

// ── HL (только чтение публичного REST) ──
async function hl(body) {
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
let liveTimer = null, lastPx = {};
let lastCandles = null; // свечи последнего loadAnchor — для пересчёта разбора на WS-цене
let lastRail = null;    // {lo,hi,cur} рельса — для живого пина
let currentAtrPct = null; // ATR(≤7,1D) в % к последней цене — подсказка по ширине стопа
function dayChg(D) { const c = D[D.length - 1]; return ((c.c - c.o) / c.o) * 100; }
// Средний истинный диапазон по дневным барам (в % к последнему закрытию). Грубый
// ориентир «нормального» дневного хода: стоп уже него = высокий шанс выноса фитилём.
function atrPctOf(D) {
  if (!D || D.length < 2) return null;
  const trs = [];
  for (let i = 1; i < D.length; i++) {
    const c = D[i], p = D[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const w = trs.slice(-7);
  const atr = w.reduce((a, b) => a + b, 0) / w.length;
  const last = D[D.length - 1].c;
  return last > 0 ? (atr / last) * 100 : null;
}
function setPx(px) {
  const el = G("px"); if (!el) return;
  const prev = lastPx[coin];
  el.textContent = px ? "$" + fmtPx(px) : "—";
  if (px && prev != null && px !== prev) { el.classList.remove("j-up", "j-down"); void el.offsetWidth; el.classList.add(px > prev ? "j-up" : "j-down"); }
  if (px) lastPx[coin] = px;
}
async function loadAnchor() {
  const conn = G("conn"); if (!conn) return;
  conn.textContent = "loading HL…";
  try {
    const now = Date.now(), day = 864e5;
    const snap = (interval, from) => hl({ type: "candleSnapshot", req: { coin, interval, startTime: now - from, endTime: now } });
    // Разбор-свечи гасят ошибку в null (429 не должен рушить цену/рельс).
    const soft = (p) => p.catch(() => null);
    const [mids, cd, c4r, c1r, c5r, btcd] = await Promise.all([
      hl({ type: "allMids" }),
      snap("1d", 9 * day),
      soft(snap("4h", 15 * day)),   // ~90 баров для EMA20/50
      soft(snap("1h", 6 * day)),    // ~144 бара
      soft(snap("5m", 12 * 3600e3)),// ~144 бара
      coin !== "BTC" ? soft(hl({ type: "candleSnapshot", req: { coin: "BTC", interval: "1d", startTime: now - 9 * day, endTime: now } })) : Promise.resolve(null),
    ]);
    // Ответ мог приехать уже после ухода со страницы — писать его некуда.
    if (!G("conn")) return;
    const price = parseFloat(mids[coin]); setPx(price);
    lastCandles = { coin, c4r, c1r, c5r };
    renderCoach(price, c4r, c1r, c5r);
    const D = cd.map((c) => ({ o: +c.o, h: +c.h, l: +c.l, c: +c.c })); const cur = D[D.length - 1];
    const dchg = dayChg(D); const e = G("dchg");
    e.textContent = (dchg >= 0 ? "+" : "") + dchg.toFixed(2) + "%"; e.className = "j-daychg " + (dchg >= 0 ? "j-up" : "j-down");
    let hi = -1, lo = 1e12; D.slice(-7).forEach((c) => { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); });
    lastRail = { coin, lo, hi, cur };
    renderRail(price, lo, hi, cur);
    currentAtrPct = atrPctOf(D); renderCalc();
    const first = D[0].c, last = cur.c; const t = G("trend200");
    const dir = last > first * 1.01 ? [`${icon("rising")} up`, "j-up"] : last < first * 0.99 ? [`${icon("falling")} down`, "j-down"] : [`${icon("flat")} range`, ""];
    // 🚨 innerHTML, а не textContent: icon() возвращает РАЗМЕТКУ, и в
    // textContent она печаталась пользователю как «<svg xmlns=…> up».
    t.innerHTML = dir[0]; t.className = "j-v " + dir[1];
    renderVsBtc(dchg, btcd);
    conn.textContent = wsAlive ? "HL · live (WS)" : "HL · updated " + new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    if (!G("conn")) return;
    conn.textContent = "HL unavailable — check the price in TradingView"; setPx(null);
  }
}

// ── live-цена по WS (allMids): цена/пин/разбор обновляются раз в секунду.
// Свечи по-прежнему тянет REST-цикл (20с) — WS даёт только свежий mid, и
// разбор пересчитывается чистой функцией на кэшированных свечах.
let ws = null, wsAlive = false, lastWsRender = 0;
let wsRetryTimer = null, wsStopped = false;
function wireWs() {
  if (wsStopped) return;
  let sock;
  try { sock = new WebSocket("wss://api.hyperliquid.xyz/ws"); } catch { return; }
  ws = sock;
  sock.onopen = () => { wsAlive = true; sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } })); };
  sock.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const mids = m?.data?.mids; if (!mids) return;
    const px = parseFloat(mids[coin]); if (!(px > 0)) return;
    const now = Date.now();
    if (now - lastWsRender < 1000) return; // не чаще 1 Гц — разбор пересчитывать чаще незачем
    lastWsRender = now;
    if (!G("conn")) return;
    setPx(px);
    if (lastRail?.coin === coin) renderRail(px, lastRail.lo, lastRail.hi, lastRail.cur);
    if (lastCandles?.coin === coin) renderCoach(px, lastCandles.c4r, lastCandles.c1r, lastCandles.c5r);
    G("conn").textContent = "HL · live (WS)";
  };
  // 🚨 Переподключаемся, только пока страница жива и сокет наш: иначе уход со
  // страницы оставляет за собой бесконечный цикл реконнектов.
  sock.onclose = () => {
    wsAlive = false;
    if (wsStopped || ws !== sock) return;
    wsRetryTimer = setTimeout(wireWs, 5000);
  };
  sock.onerror = () => { try { sock.close(); } catch { /* already closed */ } };
}
function stopWs() {
  wsStopped = true;
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  const sock = ws;
  ws = null;
  wsAlive = false;
  try { sock?.close(); } catch { /* already closed */ }
}
function renderRail(price, lo, hi, cur) {
  const span = (hi - lo) || 1; const pct = (v) => Math.max(2, Math.min(98, ((v - lo) / span) * 100));
  G("pin").style.left = pct(price) + "%"; G("pinPx").textContent = "$" + fmtPx(price);
  const bl = pct(cur.l), bh = pct(cur.h);
  const band = G("band"); band.style.left = bl + "%"; band.style.width = Math.max(bh - bl, 0) + "%";
  G("legLow").textContent = "$" + fmtPx(lo); G("legHigh").textContent = "$" + fmtPx(hi);
  const rawPct = ((price - lo) / span) * 100;
  let read, col;
  if (rawPct < 22) { read = "at the range floor"; col = "var(--red)"; }
  else if (rawPct < 42) { read = "below the middle"; col = "var(--text-secondary)"; }
  else if (rawPct < 58) { read = "middle of the range"; col = "var(--text-secondary)"; }
  else if (rawPct < 78) { read = "above the middle"; col = "var(--text-secondary)"; }
  else { read = "at the range ceiling"; col = "var(--green)"; }
  const r = G("rangeRead"); r.textContent = read; r.style.color = col;
}
function renderVsBtc(dchg, btcd) {
  const wrap = G("vsWrap"), el = G("vsbtc");
  if (coin === "BTC" || !btcd) {
    if (coin === "BTC") { wrap.hidden = false; el.innerHTML = '<span class="j-vs-none">— anchor</span>'; }
    else wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const btcChg = dayChg(btcd.map((c) => ({ o: +c.o, c: +c.c }))); const rel = dchg - btcChg;
  const corr = Math.sign(dchg) === Math.sign(btcChg) && dchg !== 0;
  el.innerHTML = `<span class="j-vschip"><span class="j-num ${rel >= 0 ?"j-up" : "j-down"}">${rel >= 0 ? "+" : ""}${rel.toFixed(1)}%</span><span class="j-badge ${corr ?"corr" : "div"}">${corr ? "tracks" : "diverges"}</span></span>`;
}

// ── авто-разбор 4h/1h/5m «куда и когда» ──
const mkCandles = (arr) => (Array.isArray(arr) ? arr.map((k) => ({ open: +k.o, high: +k.h, low: +k.l, close: +k.c })) : []);
const BIAS_TXT = { LONG: "bias: LONG", SHORT: "bias: SHORT", STAND_ASIDE: "stand aside" };
const TF_TREND = {
  up: [`${icon("rising")} up`, "up"],
  down: [`${icon("falling")} down`, "down"],
  flat: [`${icon("flat")} range`, "flat"],
};
function tfCell(tf, role, d) {
  const tr = TF_TREND[d.trend] || TF_TREND.flat;
  const bits = [];
  if (d.rsi != null) bits.push("RSI " + d.rsi);
  if (d.atrPct != null) bits.push("ATR " + d.atrPct + "%");
  if (d.triggerReady != null) bits.push(d.triggerReady ? `trigger ${icon("check")}` : "no trigger");
  const sub = bits.length ? `<div class="j-tf-sub">${bits.join(" · ")}</div>` : "";
  return `<div class="j-tf">
    <div class="j-tf-head"><span><span class="j-tf-tf">${tf}</span> <span class="j-tf-role">${role}</span></span><span class="j-tf-trend ${tr[1]}">${tr[0]}</span></div>
    <div class="j-tf-note">${d.note}</div>${sub}</div>`;
}
function renderCoach(price, c4r, c1r, c5r) {
  const vEl = G("coachVerdict"), tEl = G("coachTfs"), nEl = G("coachNote");
  if (!vEl) return;
  const out = analyzeMultiTF({ candles4h: mkCandles(c4r), candles1h: mkCandles(c1r), candles5m: mkCandles(c5r), price });
  if (!out.ok) {
    vEl.className = "j-coach-verdict neutral";
    vEl.innerHTML = '<div class="j-vh">Not enough data — HL returned no candles (try refreshing)</div>';
    tEl.innerHTML = ""; nEl.textContent = ""; return;
  }
  const v = out.verdict;
  vEl.className = "j-coach-verdict " + v.tone;
  vEl.innerHTML = `<div class="j-vh">${v.headline}<span class="j-bias ${out.bias}">${BIAS_TXT[out.bias] || out.bias}</span></div><div class="j-vd">${v.detail}</div>`;
  tEl.innerHTML = tfCell("4h", "direction", out.tf.h4) + tfCell("1h", "zone + stop", out.tf.h1) + tfCell("5m", "timing", out.tf.m5);
  nEl.textContent = out.disclaimer;
}

// ── сегменты ──
let curTrend = "", curReg = "";
let segT = null, segR = null;
function wireSeg(id, set) {
  const el = G(id);
  const mark = (v) => el.querySelectorAll(".seg__btn").forEach((b) => {
    const on = b.dataset.v === v;
    b.classList.toggle("is-on", on); b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  el.querySelectorAll(".seg__btn").forEach((b) => {
    b.onclick = () => { mark(b.dataset.v); set(b.dataset.v); };
  });
  return { set: mark };
}

function readForm() {
  return { trend: curTrend, regime: curReg, resAbove: G("resAbove").value.trim(), supBelow: G("supBelow").value.trim(), scenA: G("scenA").value.trim(), scenB: G("scenB").value.trim(), bias: G("bias").value.trim(), rr: G("rr").value.trim(), px: G("px").textContent, ts: Date.now() };
}
function fillForm(e) {
  curTrend = e?.trend || ""; curReg = e?.regime || ""; segT.set(curTrend); segR.set(curReg);
  ["resAbove", "supBelow", "scenA", "scenB", "bias", "rr"].forEach((k) => (G(k).value = e?.[k] || ""));
}

const TR = { up: ["up", "up"], down: ["down", "down"], range: ["range", "range"], "": ["—", ""] };
function pill(v) { const t = TR[v] || TR[""]; return `<span class="j-pill ${t[1]}">${t[0]}</span>`; }

function prevEntry() {
  const e = entries(coin); const days = Object.keys(e).filter((d) => d !== todayKey()).sort();
  return days.length ? { date: days[days.length - 1], data: e[days[days.length - 1]] } : null;
}
function renderYesterday() {
  const p = prevEntry(), body = G("yBody"), box = G("yGradeBox");
  if (!p) { body.innerHTML = '<p class="j-empty">No previous entry for this coin yet. Fill one in today and check tomorrow which scenario fired.</p>'; box.style.display = "none"; return; }
  const d = p.data;
  body.innerHTML = `
    <div class="j-kv"><b>${p.date}</b> · price then <span class="j-mono">${d.px || "—"}</span></div>
    <div class="j-kv"><b>Trend</b> ${pill(d.trend)} &nbsp;&nbsp; <b>Regime</b> ${d.regime === "up" ? "trend" : d.regime === "range" ? "range" : "—"}</div>
    <div class="j-kv"><b>Above</b> <span class="j-mono">${d.resAbove || "—"}</span></div>
    <div class="j-kv"><b>Below</b> <span class="j-mono">${d.supBelow || "—"}</span></div>
    <div class="j-kv"><b>A:</b> ${d.scenA || "—"}</div>
    <div class="j-kv"><b>B:</b> ${d.scenB || "—"}</div>
    <div class="j-kv"><b>Bias:</b> ${d.bias || "—"} &nbsp; <b>R:R:</b> ${d.rr || "—"}</div>
    ${d.grade ? `<div class="j-kv j-grade"><b>Takeaway:</b> ${d.grade}</div>` : ""}`;
  box.style.display = "block"; G("grade").value = d.grade || "";
  G("saveGrade").onclick = () => { d.grade = G("grade").value.trim(); entries(coin)[p.date] = d; saveDb(); renderYesterday(); renderHist(); flashSaved(); };
}
function renderHist() {
  G("histCoin").textContent = coin; const e = entries(coin); const days = Object.keys(e).sort().reverse(); const h = G("hist");
  if (!days.length) { h.innerHTML = '<p class="j-empty">Empty.</p>'; return; }
  h.innerHTML = days.map((d) => {
    const x = e[d];
    return `<details class="j-log-item"><summary><span class="j-date">${d}</span> ${pill(x.trend)} ${x.bias ? '<span class="j-log-bias">' + x.bias.slice(0, 42) + (x.bias.length > 42 ? "…" : "") + "</span>" : ""} ${x.grade ? `<span class="j-done">${icon("check")} reviewed</span>` : ""}</summary>
      <div class="j-log-body">
        <div class="j-kv"><b>Above</b> <span class="j-mono">${x.resAbove || "—"}</span> · <b>Below</b> <span class="j-mono">${x.supBelow || "—"}</span></div>
        <div class="j-kv"><b>A:</b> ${x.scenA || "—"}</div><div class="j-kv"><b>B:</b> ${x.scenB || "—"}</div>
        ${x.grade ? `<div class="j-kv j-grade"><b>Takeaway:</b> ${x.grade}</div>` : ""}
      </div></details>`;
  }).join("");
}
function flashSaved() { const s = G("saved"); s.classList.add("show"); setTimeout(() => s.classList.remove("show"), 1500); }

// ── вкладки монет ──
function renderTabs() {
  G("tabs").innerHTML = allCoins().map((c) =>
    `<button class="tabs__tab${c === coin ? " is-active" : ""}" data-coin="${c}">${c}${COINS.includes(c) ? "" : `<span class="j-rm" data-rm="${c}" data-card="Remove">${icon("close")}</span>`}</button>`,
  ).join("") + `<button class="tabs__tab j-addbtn" id="addCoin" data-card="Add a coin">+</button>`;
}
function showAddInput() {
  const add = G("addCoin"); if (!add) return;
  const inp = document.createElement("input"); inp.className = "field field--ticker j-coininput"; inp.placeholder = "ticker…"; inp.maxLength = 12;
  add.replaceWith(inp); inp.focus();
  const done = () => { if (document.body.contains(inp)) renderTabs(); };
  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { const ok = await addCoinByTicker(inp.value); if (!ok) { inp.classList.add("err"); inp.select(); } }
    else if (e.key === "Escape") { done(); }
  });
  inp.addEventListener("blur", () => setTimeout(done, 120));
}
async function addCoinByTicker(raw) {
  const t = (raw || "").trim(); if (!t) return false;
  try {
    const mids = await hl({ type: "allMids" });
    const match = Object.keys(mids).find((k) => k.toLowerCase() === t.toLowerCase());
    if (!match) return false;
    if (!allCoins().includes(match)) { customCoins.push(match); localStorage.setItem(COINS_KEY, JSON.stringify(customCoins)); }
    switchCoin(match); setUrlCoin(match); return true;
  } catch (err) { return false; }
}
function removeCoin(c) {
  customCoins = customCoins.filter((x) => x !== c); localStorage.setItem(COINS_KEY, JSON.stringify(customCoins));
  if (coin === c) switchCoin("BTC"); else renderTabs();
}

// ── калькулятор стопа/размера ──
const CALC_KEY = "helm_cj_calc";
const num = (id) => { const v = parseFloat((G(id).value || "").replace(/[,\s]/g, "")); return Number.isFinite(v) ? v : null; };
const WALLET_LEV_CAP = 10; // практический потолок плеча кошелька (как в боте)
function renderCalc() {
  const out = G("calcOut"), sideEl = G("calcSide");
  if (!out) return;
  const entry = num("calcEntry"), stop = num("calcStop"), target = num("calcTarget");
  const eq = num("calcEq"), risk = num("calcRisk");
  // запоминаем депо/риск (стабильные)
  localStorage.setItem(CALC_KEY, JSON.stringify({ eq: G("calcEq").value, risk: G("calcRisk").value }));
  if (!entry || !stop || entry <= 0 || stop <= 0 || entry === stop) {
    sideEl.textContent = ""; out.innerHTML = '<div class="j-calc-row"><b>Enter entry and stop</b><span class="v">—</span></div>'; return;
  }
  const long = stop < entry;
  sideEl.textContent = long ? "LONG" : "SHORT";
  sideEl.className = "j-coin-sub " + (long ? "j-up" : "j-down");
  const stopDist = (Math.abs(entry - stop) / entry) * 100;
  const rows = [];
  // дистанция стопа + сверка с ATR
  let atrNote = "";
  if (currentAtrPct != null) {
    atrNote = stopDist < currentAtrPct
      ? `<small class="j-calc-bad">already ATR(1D)≈${currentAtrPct.toFixed(2)}% — a wick will take it out</small>`
      : `<small class="j-calc-ok">wider than ATR(1D)≈${currentAtrPct.toFixed(2)}% ${icon("check")}</small>`;
  }
  rows.push(`<div class="j-calc-row"><b>Distance to stop</b><span class="v">${stopDist.toFixed(2)}%${atrNote}</span></div>`);
  // размер от риска
  if (eq && risk && eq > 0 && risk > 0) {
    const riskUsd = (eq * risk) / 100;
    const sizeUsd = riskUsd / (stopDist / 100);
    const lev = sizeUsd / eq;
    const levHot = lev > WALLET_LEV_CAP;
    rows.push(`<div class="j-calc-row"><b>Risk per trade</b><span class="v">$${riskUsd.toFixed(2)}<small>${risk}% of $${eq.toFixed(0)}</small></span></div>`);
    rows.push(`<div class="j-calc-row"><b>Position size</b><span class="v">$${sizeUsd.toFixed(2)}<small class="${levHot ? "j-calc-bad" : "j-calc-dim"}">leverage ~${lev.toFixed(1)}×${levHot ? ` › cap ${WALLET_LEV_CAP}×` : ""}</small></span></div>`);
  } else {
    rows.push('<div class="j-calc-row"><b>Position size</b><span class="v">—<small>fill in account and risk %</small></span></div>');
  }
  // R:R до цели
  if (target && target > 0) {
    const valid = long ? target > entry : target < entry;
    if (valid) {
      const rr = Math.abs(target - entry) / Math.abs(entry - stop);
      const tone = rr >= 2 ? "j-calc-ok" : rr < 1 ? "j-calc-bad" : "";
      rows.push(`<div class="j-calc-row"><b>R:R to target</b><span class="v ${tone}">1 : ${rr.toFixed(2)}</span></div>`);
    } else {
      rows.push(`<div class="j-calc-row"><b>R:R to target</b><span class="v"><small class="j-calc-bad">target is not on the ${long ? "long side (above entry)" : "short side (below entry)"}</small></span></div>`);
    }
  }
  out.innerHTML = rows.join("");
}
// ── обучающая панель ──
const HELP_KEY = "helm_cj_help_seen";
function showHelp(v) { G("helpCard").style.display = v ? "" : "none"; }
function wireHelp() {
  showHelp(localStorage.getItem(HELP_KEY) !== "1");
  G("helpClose").onclick = () => { localStorage.setItem(HELP_KEY, "1"); showHelp(false); };
  G("helpToggle").onclick = () => showHelp(G("helpCard").style.display === "none");
}

function wireCalc() {
  const saved = JSON.parse(localStorage.getItem(CALC_KEY) || "{}");
  if (saved.eq) G("calcEq").value = saved.eq;
  if (saved.risk) G("calcRisk").value = saved.risk;
  ["calcEntry", "calcStop", "calcTarget", "calcEq", "calcRisk"].forEach((id) => G(id).addEventListener("input", renderCalc));
  G("calcFill").onclick = () => { if (lastPx[coin]) { G("calcEntry").value = String(lastPx[coin]); renderCalc(); } };
  renderCalc();
}

function switchCoin(c) {
  coin = c; renderTabs();
  G("anchorCoin").textContent = c; G("histCoin").textContent = c;
  G("anchorDate").textContent = "markup for " + todayKey();
  fillForm(entries(c)[todayKey()] || null); renderYesterday(); renderHist();
  loadAnchor();
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(loadAnchor, 20000);
}
// ── вкладки: дрилл графика / журнал сделок (?view=trades) ──
const VIEWS = [
  { value: "drill", label: "Chart drill" },
  { value: "trades", label: "Trade log" },
];
function setView(view) {
  const trades = view === "trades";
  G("journalViews").innerHTML = segmented({ options: VIEWS, value: view, name: "view" });
  for (const id of ["drillView", "tabs", "helpToggle", "conn"]) G(id).hidden = trades;
  G("tradeLogView").hidden = !trades;
  const url = new URL(location.href);
  if (trades) url.searchParams.set("view", "trades");
  else url.searchParams.delete("view");
  history.replaceState(null, "", url);
  if (trades) {
    mountTradeLog();
    return;
  }
  // Монета в адресе могла смениться в Trade log — дрилл открывает её же.
  const linked = url.searchParams.get("coin");
  if (linked && linked.toUpperCase() !== coin.toUpperCase()) addCoinByTicker(linked);
}

function view() {
  return `
    <div class="j-wrap">
      <div class="j-toolbar">
        <div id="journalViews"></div>
        <nav class="tabs j-nav" id="tabs"></nav>
        <button
          class="j-help-btn"
          id="helpToggle"
          type="button"
          data-card="How to use the journal"
          aria-label="How to use"
        >
          <i data-icon="help"></i>
        </button>
        <span class="j-status" id="conn">…</span>
      </div>

      <div id="drillView">
      <!-- Обучающая панель: что это и что делать -->
      <section class="j-card j-help" id="helpCard">
        <div class="j-help-head">
          <h2 class="j-card-title j-card-title--flush">
            <span class="j-idx">why</span> How to use the journal
          </h2>
          <button class="btn btn--ghost btn--sm j-help-x" id="helpClose" type="button">
            Got it, hide
          </button>
        </div>
        <p class="j-help-lead">
          This is a drill for learning to read a chart <b>a day ahead</b>. Not to guess
          price (that is a coin flip), but to map the terrain and keep yourself from
          entering against the trend. A morning long against a falling BTC is exactly
          the mistake this page insures against.
        </p>
        <div class="j-help-steps">
          <div class="j-help-step">
            <span class="j-idx">read</span>
            <div>
              <b>Mark up one coin a day.</b> 1D trend (which way the wind blows),
              levels above and below (where the walls are), two scenarios “if X → A / if
              Y → B”, and a base bias. One or two minutes per coin. The “Bearing” scale
              at the top shows where price sits in the weekly range — near the floor or
              near the ceiling.
            </div>
          </div>
          <div class="j-help-step">
            <span class="j-idx">size</span>
            <div>
              <b>Stop and size before entry.</b> Enter your entry and stop → size is
              computed <b>from risk</b> (you lose exactly the set % of the account at the
              stop), not from “how much I can stomach”. A red “already ATR” means the stop
              is too tight and a wick will take it out.
            </div>
          </div>
          <div class="j-help-step">
            <span class="j-idx">review</span>
            <div>
              <b>Next day, review it.</b> Which scenario fired? Were the levels right?
              Write a short takeaway. This is where pattern recognition accumulates — not
              from reading, but from checking your own markups.
            </div>
          </div>
        </div>
        <p class="j-help-rule">
          One rule that saves money:
          <b>do not long against the 1D trend and do not short against it.</b> The goal
          of the drill is not to guess direction but to train level markup and regime
          choice. Twenty or thirty entries and structure starts reading itself.
        </p>
      </section>

      <!-- HERO · Пеленг -->
      <section class="j-card">
        <div class="j-hero-head">
          <div>
            <span class="j-coin-name" id="anchorCoin">BTC</span>
            <span class="j-coin-sub" id="anchorDate"></span>
          </div>
          <div class="j-price-block">
            <span class="j-price j-mono" id="px">—</span>
            <span class="j-daychg" id="dchg">—</span>
          </div>
        </div>

        <div class="j-bearing">
          <div class="j-rail" id="rail">
            <!-- 🚨 Положение полосы и пина считает renderRail: left/width ставит
                 JS, поэтому они инлайновые (см. core/_utilities.scss). -->
            <div class="j-band" id="band" style="left: 50%; width: 0"></div>
            <div class="j-pin" id="pin" style="left: 50%">
              <span class="j-dot"></span
              ><span class="j-lab j-mono" id="pinPx"></span>
            </div>
          </div>
          <div class="j-legend">
            <span class="j-end lo"
              ><small>7d low</small><span id="legLow">—</span></span
            >
            <span class="j-read" id="rangeRead">—</span>
            <span class="j-end hi"
              ><small>7d high</small><span id="legHigh">—</span></span
            >
          </div>
        </div>

        <div class="j-meta-row">
          <div class="j-meta">
            <span class="j-k">7d trend</span
            ><span class="j-v" id="trend200">—</span>
          </div>
          <div class="j-meta" id="vsWrap">
            <span class="j-k">vs BTC today</span
            ><span class="j-v" id="vsbtc">—</span>
          </div>
        </div>

        <p class="j-principle">
          First answer “trend or range” — from the structure of highs and lows plus
          EMA200 — and only then look at RSI. Do not long against the 1D trend and do
          not short against it.
        </p>
      </section>

      <!-- Авто-разбор 4h/1h/5m: куда (направление) и когда (тайминг) -->
      <section class="j-card j-coach" id="coachCard">
        <h2 class="j-card-title">
          <span class="j-idx">breakdown</span> Where and when · 4h → 1h → 5m
          <span class="j-status j-status--right" id="coachStatus"></span>
        </h2>
        <div class="j-coach-verdict neutral" id="coachVerdict">
          <div class="j-vh">Reading the market…</div>
        </div>
        <div class="j-tf-grid" id="coachTfs"></div>
        <p class="j-coach-note" id="coachNote"></p>
      </section>

      <div class="j-cols">
        <section class="j-card">
          <h2 class="j-card-title">
            <span class="j-idx">read</span> Markup for tomorrow
            <span class="j-saved" id="saved"><i data-icon="check"></i>saved</span>
          </h2>
          <div class="j-field">
            <label class="j-f">1D trend</label>
            <div class="seg seg--wide" id="segTrend" role="group">
              <button type="button" class="seg__btn seg__btn--long" data-v="up" aria-pressed="false"><i data-icon="rising"></i>up</button
              ><button type="button" class="seg__btn seg__btn--flat" data-v="range" aria-pressed="false"><i data-icon="flat"></i>range</button
              ><button type="button" class="seg__btn seg__btn--short" data-v="down" aria-pressed="false"><i data-icon="falling"></i>down</button>
            </div>
          </div>
          <div class="j-field">
            <label class="j-f">Regime</label>
            <div class="seg seg--wide" id="segReg" role="group">
              <button type="button" class="seg__btn" data-v="up" aria-pressed="false">trend</button
              ><button type="button" class="seg__btn" data-v="range" aria-pressed="false">range</button>
            </div>
          </div>
          <div class="j-field j-row2">
            <div>
              <label class="j-f">Resistance above</label
              ><input class="field field--block field--lg" type="text" id="resAbove" placeholder="60.8k / 61.9k" />
            </div>
            <div>
              <label class="j-f">Support below</label
              ><input class="field field--block field--lg" type="text" id="supBelow" placeholder="58.9k / 58.0k" />
            </div>
          </div>
          <div class="j-field">
            <label class="j-f">Scenario A — if…</label
            ><textarea
              class="field field--block field--lg"
              id="scenA"
              placeholder="holds 58k → bounce to 60.8 (sell the rally)"
            ></textarea>
          </div>
          <div class="j-field">
            <label class="j-f">Scenario B — if…</label
            ><textarea
              class="field field--block field--lg"
              id="scenB"
              placeholder="loses 58.0k on volume → down to 56k"
            ></textarea>
          </div>
          <div class="j-field j-row2">
            <div>
              <label class="j-f">Base bias</label
              ><input class="field field--block field--lg" type="text" id="bias" placeholder="sell the bounces" />
            </div>
            <div>
              <label class="j-f">Plan R:R</label
              ><input class="field field--block field--lg" type="text" id="rr" placeholder="1:3, stop beyond 61.1" />
            </div>
          </div>
          <button class="btn btn--primary j-btn" id="save" type="button">Save markup</button>
        </section>

        <section class="j-card">
          <h2 class="j-card-title">
            <span class="j-idx">review</span> Yesterday’s markup
          </h2>
          <div id="yBody">
            <p class="j-empty">
              No previous entry for this coin yet. Fill one in today and tomorrow you can
              check which scenario fired.
            </p>
          </div>
          <!-- 🚨 Блок показывает/прячет renderYesterday через style.display —
               поэтому здесь инлайн, а не класс. -->
          <div id="yGradeBox" style="display: none">
            <div class="j-field">
              <label class="j-f"
                >Which scenario fired? Were the levels right?</label
              ><textarea
                class="field field--block field--lg"
                id="grade"
                placeholder="B fired, broke 58 as expected; the 60.8 level was exact"
              ></textarea>
            </div>
            <button class="btn j-btn ghost" id="saveGrade" type="button">Save the takeaway</button>
          </div>
        </section>
      </div>

      <section class="j-card">
        <h2 class="j-card-title">
          <span class="j-idx">size</span> Stop and size
          <span class="j-coin-sub" id="calcSide"></span>
        </h2>
        <div class="j-field j-calc-grid">
          <div>
            <label class="j-f">Entry $</label
            ><input
              class="field field--block field--lg"
              type="text"
              id="calcEntry"
              inputmode="decimal"
              placeholder="59300"
            />
          </div>
          <div>
            <label class="j-f">Stop $</label
            ><input
              class="field field--block field--lg"
              type="text"
              id="calcStop"
              inputmode="decimal"
              placeholder="61100"
            />
          </div>
          <div>
            <label class="j-f">Target $ (opt.)</label
            ><input
              class="field field--block field--lg"
              type="text"
              id="calcTarget"
              inputmode="decimal"
              placeholder="58300"
            />
          </div>
          <div>
            <label class="j-f">Account $</label
            ><input
              class="field field--block field--lg"
              type="text"
              id="calcEq"
              inputmode="decimal"
              placeholder="50"
            />
          </div>
          <div>
            <label class="j-f">Risk % of account</label
            ><input
              class="field field--block field--lg"
              type="text"
              id="calcRisk"
              inputmode="decimal"
              placeholder="2"
            />
          </div>
        </div>
        <button class="btn j-btn ghost j-calc-fill" id="calcFill" type="button">
          Entry = current price
        </button>
        <div class="j-calc-out" id="calcOut"></div>
        <p class="j-calc-hint">
          Stop level first (below support / above resistance, plus a buffer), size
          second — not the other way round. Size is computed so that hitting the stop
          costs exactly the risk you set.
        </p>
      </section>

      <section class="j-card">
        <h2 class="j-card-title">
          <span class="j-idx">journal</span> History ·
          <span id="histCoin">BTC</span>
        </h2>
        <div id="hist"><p class="j-empty">Empty.</p></div>
      </section>

      <p class="j-footnote">
        The goal of the drill is to check level markup and regime choice, not to
        guess direction — that is a coin flip. Twenty or thirty entries and structure
        reads itself. The edge is still in the exit; reading is what keeps you from
        fighting the trend and lets you set sensible stops.
      </p>
      </div>

      <!-- Trade log: журнал сделок, пишется из закрытых сделок (features/tradeLog.js) -->
      <div id="tradeLogView" hidden>
        <section class="j-card">
          <div class="card-header">
            <div class="card-title">Overview</div>
            <div class="card-tools">
              <span id="tj-filter"></span>
              <span class="card-meta" id="tj-period"></span>
            </div>
          </div>
          <div id="tj-overview"></div>
        </section>

        <section class="j-card">
          <div class="card-header">
            <div class="card-title">This week</div>
            <div class="card-meta" id="tj-week-meta"></div>
          </div>
          <div id="tj-week"></div>
        </section>

        <section class="j-card">
          <div class="card-header">
            <div class="card-title">Where the result comes from</div>
            <div class="card-tools" id="tj-dims"></div>
          </div>
          <div class="table-wrap">
            <table class="table table--compact">
              <thead>
                <tr>
                  <th>Group</th>
                  <th class="num">Trades</th>
                  <th class="num">Win rate</th>
                  <th class="num">Net</th>
                  <th class="num">Avg / trade</th>
                  <th
                    class="num"
                    data-card="Range the average per trade lands in 95% of the time, resampling whole days. If it spans zero, this group is not distinguishable from break-even yet."
                  >
                    95% CI
                  </th>
                </tr>
              </thead>
              <tbody id="tj-breakdown"></tbody>
            </table>
          </div>
        </section>

        <section class="j-card">
          <div class="card-header">
            <div class="card-title">Recent trades</div>
            <div class="card-meta" id="tj-trades-meta"></div>
          </div>
          <div class="table-wrap">
            <table class="table table--compact table--sticky-head">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Coin</th>
                  <th>Side</th>
                  <th>Session</th>
                  <th data-card="Direction of the last hour at entry, relative to the trade side">1h trend</th>
                  <th class="num">Hold</th>
                  <th class="num" data-card="Best and worst unrealized move while the trade was open">Peak / worst</th>
                  <th class="num">Net</th>
                  <th class="num">Net %</th>
                  <th data-card="Accent marks describe the entry; grey marks describe the outcome and are not used in the breakdown">Marks</th>
                </tr>
              </thead>
              <tbody id="tj-trades"></tbody>
            </table>
          </div>
        </section>
      </div>
    </div>`;
}

export default {
  title: "Helm · Journal",
  nav: "journal",

  render(outlet) {
    outlet.innerHTML = view();

    segT = wireSeg("segTrend", (v) => (curTrend = v));
    segR = wireSeg("segReg", (v) => (curReg = v));

    G("save").onclick = () => {
      entries(coin)[todayKey()] = { ...(entries(coin)[todayKey()] || {}), ...readForm() };
      saveDb(); flashSaved(); renderHist();
    };
    G("tabs").addEventListener("click", (e) => {
      const rm = e.target.closest(".j-rm"); if (rm) { e.stopPropagation(); removeCoin(rm.dataset.rm); return; }
      if (e.target.closest("#addCoin")) { showAddInput(); return; }
      const t = e.target.closest(".tabs__tab"); if (t && t.dataset.coin) { switchCoin(t.dataset.coin); setUrlCoin(t.dataset.coin); }
    });
    G("journalViews").addEventListener("click", (e) => {
      const button = e.target.closest("[data-view]");
      if (button) setView(button.dataset.view);
    });

    wireHelp();
    wireCalc();
    // Монета помнится между заходами — возвращаемся к той, что была открыта.
    switchCoin(coin);
    setView(new URLSearchParams(location.search).get("view") === "trades" ? "trades" : "drill");

    // <i data-icon="…"> в статической разметке → настоящие svg.
    paintIcons();

    wsStopped = false;
    wireWs();

    return () => {
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      stopWs();
    };
  },
};
