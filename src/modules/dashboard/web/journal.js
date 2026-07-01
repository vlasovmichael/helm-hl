import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  journal.html — журнал чтения графика (дрилл «на сутки вперёд»).
//  Читает свечи/цену HL напрямую (publicWS/REST), ничего не торгует.
//  Цикл: читаю (разметка сценариев) → проверяю (прошлая) → журнал. По 3 якорным
//  монетам (BTC/HYPE/SOL) + любая своя. Хранение — localStorage. 2026-06-30.
// ─────────────────────────────────────────────────

import { bindTheme } from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { analyzeMultiTF } from "../../chartCoach.js";

mountTopnav("journal");
bindTheme();

const COINS = ["BTC", "HYPE", "SOL"];
const KEY = "helm_chartjournal_v1";
const COINS_KEY = "helm_cj_coins";
let coin = "BTC";
let customCoins = JSON.parse(localStorage.getItem(COINS_KEY) || "[]");
const allCoins = () => [...COINS, ...customCoins];

const SEED_DATE = "2026-06-30";
const SEED = {
  BTC: { trend: "down", regime: "range", px: "$59.3k",
    resAbove: "60.2–60.8k / 61.9k", supBelow: "58.9k / 58.3k / 58.0k (лоу недели)",
    scenA: "держит пол 58.3–58.9 → отскок к 60.2–60.8 (продать ралли, не купить разворот)",
    scenB: "теряет 58.06k на объёме → продолжение вниз, воздух ~56k (выше вероятность по тренду 1D)",
    bias: "продавать ралли в 60.2–60.8; лонг против тренда = нож", rr: "шорт от 60.5, стоп за 61.1, цель 58.3 → ~1:3" },
  HYPE: { trend: "range", regime: "range", px: "$65.4",
    resAbove: "67.8 (хай 29.06) / 69.6", supBelow: "64.9 (лоу сегодня) / 60.5–60.9 / 58.3 (лоу недели)",
    scenA: "держит 63.9–64.9 → дотолкнёт к 67.8, дальше 69.6", scenB: "теряет 64 → назад в зону 60.5–58.3",
    bias: "сильнее битка (decorrel ~0.46); покупать откаты к опоре / продавать в 67.8–69.6. Стопы ШИРЕ — размах 6–12%/день",
    rr: "лонг от 65 на удержании 64.9, стоп под 63.8, цель 67.8 → ~1:2.5" },
  SOL: { trend: "up", regime: "up", px: "$73.6",
    resAbove: "76.6 (хай 29.06) / выше — воздух", supBelow: "73.3 (лоу сегодня) / 70.2–70.4 / 68 / 64 (лоу недели)",
    scenA: "держит 70.4–73.3 → повтор к 76.6 и выше", scenB: "теряет 70 → откат к 68, затем 64",
    bias: "сильнейший из трёх, против слабости битка; покупать откаты к 70–73, 76.6 = потолок/цель фиксации",
    rr: "лонг лучше ждать отката к 70.4 (стоп под 70, цель 76.6 → ~1:2); от 73.3 R:R узкий" },
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
  const el = G("px"); const prev = lastPx[coin];
  el.textContent = px ? "$" + fmtPx(px) : "—";
  if (px && prev != null && px !== prev) { el.classList.remove("j-up", "j-down"); void el.offsetWidth; el.classList.add(px > prev ? "j-up" : "j-down"); }
  if (px) lastPx[coin] = px;
}
async function loadAnchor() {
  const conn = G("conn"); conn.textContent = "загрузка HL…";
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
    const price = parseFloat(mids[coin]); setPx(price);
    renderCoach(price, c4r, c1r, c5r);
    const D = cd.map((c) => ({ o: +c.o, h: +c.h, l: +c.l, c: +c.c })); const cur = D[D.length - 1];
    const dchg = dayChg(D); const e = G("dchg");
    e.textContent = (dchg >= 0 ? "+" : "") + dchg.toFixed(2) + "%"; e.className = "j-daychg " + (dchg >= 0 ? "j-up" : "j-down");
    let hi = -1, lo = 1e12; D.slice(-7).forEach((c) => { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); });
    renderRail(price, lo, hi, cur);
    currentAtrPct = atrPctOf(D); renderCalc();
    const first = D[0].c, last = cur.c; const t = G("trend200");
    const dir = last > first * 1.01 ? ["▲ вверх", "j-up"] : last < first * 0.99 ? ["▼ вниз", "j-down"] : ["≈ боковик", ""];
    t.textContent = dir[0]; t.className = "j-v " + dir[1];
    renderVsBtc(dchg, btcd);
    conn.textContent = "HL · обновлено " + new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    conn.textContent = "HL недоступен — цену смотри в TradingView"; setPx(null);
  }
}
function renderRail(price, lo, hi, cur) {
  const span = (hi - lo) || 1; const pct = (v) => Math.max(2, Math.min(98, ((v - lo) / span) * 100));
  G("pin").style.left = pct(price) + "%"; G("pinPx").textContent = "$" + fmtPx(price);
  const bl = pct(cur.l), bh = pct(cur.h);
  const band = G("band"); band.style.left = bl + "%"; band.style.width = Math.max(bh - bl, 0) + "%";
  G("legLow").textContent = "$" + fmtPx(lo); G("legHigh").textContent = "$" + fmtPx(hi);
  const rawPct = ((price - lo) / span) * 100;
  let read, col;
  if (rawPct < 22) { read = "у пола диапазона"; col = "var(--red)"; }
  else if (rawPct < 42) { read = "ниже середины"; col = "var(--text-secondary)"; }
  else if (rawPct < 58) { read = "середина диапазона"; col = "var(--text-secondary)"; }
  else if (rawPct < 78) { read = "выше середины"; col = "var(--text-secondary)"; }
  else { read = "у потолка диапазона"; col = "var(--green)"; }
  const r = G("rangeRead"); r.textContent = read; r.style.color = col;
}
function renderVsBtc(dchg, btcd) {
  const wrap = G("vsWrap"), el = G("vsbtc");
  if (coin === "BTC" || !btcd) {
    if (coin === "BTC") { wrap.style.display = "flex"; el.innerHTML = '<span style="color:var(--text-muted)">— якорь</span>'; }
    else wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  const btcChg = dayChg(btcd.map((c) => ({ o: +c.o, c: +c.c }))); const rel = dchg - btcChg;
  const corr = Math.sign(dchg) === Math.sign(btcChg) && dchg !== 0;
  el.innerHTML = `<span class="j-vschip"><span class="j-num ${rel >= 0 ? "j-up" : "j-down"}">${rel >= 0 ? "+" : ""}${rel.toFixed(1)}%</span><span class="j-badge ${corr ? "corr" : "div"}">${corr ? "следует" : "расходится"}</span></span>`;
}

// ── авто-разбор 4h/1h/5m «куда и когда» ──
const mkCandles = (arr) => (Array.isArray(arr) ? arr.map((k) => ({ open: +k.o, high: +k.h, low: +k.l, close: +k.c })) : []);
const BIAS_TXT = { LONG: "bias: LONG", SHORT: "bias: SHORT", STAND_ASIDE: "в стороне" };
const TF_TREND = { up: ["↑ вверх", "up"], down: ["↓ вниз", "down"], flat: ["→ боковик", "flat"] };
function tfCell(tf, role, d) {
  const tr = TF_TREND[d.trend] || TF_TREND.flat;
  const bits = [];
  if (d.rsi != null) bits.push("RSI " + d.rsi);
  if (d.atrPct != null) bits.push("ATR " + d.atrPct + "%");
  if (d.triggerReady != null) bits.push(d.triggerReady ? "триггер ✓" : "триггера нет");
  const sub = bits.length ? `<div class="j-tf-sub">${bits.join(" · ")}</div>` : "";
  return `<div class="j-tf">
    <div class="j-tf-head"><span><span class="j-tf-tf">${tf}</span> <span class="j-tf-role">${role}</span></span><span class="j-tf-trend ${tr[1]}">${tr[0]}</span></div>
    <div class="j-tf-note">${d.note}</div>${sub}</div>`;
}
function renderCoach(price, c4r, c1r, c5r) {
  const vEl = G("coachVerdict"), tEl = G("coachTfs"), nEl = G("coachNote");
  const out = analyzeMultiTF({ candles4h: mkCandles(c4r), candles1h: mkCandles(c1r), candles5m: mkCandles(c5r), price });
  if (!out.ok) {
    vEl.className = "j-coach-verdict neutral";
    vEl.innerHTML = '<div class="j-vh">Мало данных для разбора — HL не отдал свечи (попробуй обновить)</div>';
    tEl.innerHTML = ""; nEl.textContent = ""; return;
  }
  const v = out.verdict;
  vEl.className = "j-coach-verdict " + v.tone;
  vEl.innerHTML = `<div class="j-vh">${v.headline}<span class="j-bias ${out.bias}">${BIAS_TXT[out.bias] || out.bias}</span></div><div class="j-vd">${v.detail}</div>`;
  tEl.innerHTML = tfCell("4h", "направление", out.tf.h4) + tfCell("1h", "зона + стоп", out.tf.h1) + tfCell("5m", "тайминг", out.tf.m5);
  nEl.textContent = out.disclaimer;
}

// ── сегменты ──
let curTrend = "", curReg = "";
function wireSeg(id, set) {
  const el = G(id);
  el.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { el.querySelectorAll("button").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); set(b.dataset.v); };
  });
  return { set(v) { el.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.v === v)); } };
}
const segT = wireSeg("segTrend", (v) => (curTrend = v)), segR = wireSeg("segReg", (v) => (curReg = v));

function readForm() {
  return { trend: curTrend, regime: curReg, resAbove: G("resAbove").value.trim(), supBelow: G("supBelow").value.trim(), scenA: G("scenA").value.trim(), scenB: G("scenB").value.trim(), bias: G("bias").value.trim(), rr: G("rr").value.trim(), px: G("px").textContent, ts: Date.now() };
}
function fillForm(e) {
  curTrend = e?.trend || ""; curReg = e?.regime || ""; segT.set(curTrend); segR.set(curReg);
  ["resAbove", "supBelow", "scenA", "scenB", "bias", "rr"].forEach((k) => (G(k).value = e?.[k] || ""));
}

const TR = { up: ["вверх", "up"], down: ["вниз", "down"], range: ["боковик", "range"], "": ["—", ""] };
function pill(v) { const t = TR[v] || TR[""]; return `<span class="j-pill ${t[1]}">${t[0]}</span>`; }

function prevEntry() {
  const e = entries(coin); const days = Object.keys(e).filter((d) => d !== todayKey()).sort();
  return days.length ? { date: days[days.length - 1], data: e[days[days.length - 1]] } : null;
}
function renderYesterday() {
  const p = prevEntry(), body = G("yBody"), box = G("yGradeBox");
  if (!p) { body.innerHTML = '<p class="j-empty">Прошлой записи по этой монете ещё нет. Заполни сегодня — завтра проверишь, какой сценарий включился.</p>'; box.style.display = "none"; return; }
  const d = p.data;
  body.innerHTML = `
    <div class="j-kv"><b>${p.date}</b> · цена тогда <span class="j-mono">${d.px || "—"}</span></div>
    <div class="j-kv"><b>Тренд</b> ${pill(d.trend)} &nbsp;&nbsp; <b>Режим</b> ${d.regime === "up" ? "тренд" : d.regime === "range" ? "диапазон" : "—"}</div>
    <div class="j-kv"><b>Сверху</b> <span class="j-mono">${d.resAbove || "—"}</span></div>
    <div class="j-kv"><b>Снизу</b> <span class="j-mono">${d.supBelow || "—"}</span></div>
    <div class="j-kv"><b>A:</b> ${d.scenA || "—"}</div>
    <div class="j-kv"><b>B:</b> ${d.scenB || "—"}</div>
    <div class="j-kv"><b>Уклон:</b> ${d.bias || "—"} &nbsp; <b>R:R:</b> ${d.rr || "—"}</div>
    ${d.grade ? `<div class="j-kv j-grade"><b>Вывод:</b> ${d.grade}</div>` : ""}`;
  box.style.display = "block"; G("grade").value = d.grade || "";
  G("saveGrade").onclick = () => { d.grade = G("grade").value.trim(); entries(coin)[p.date] = d; saveDb(); renderYesterday(); renderHist(); flashSaved(); };
}
function renderHist() {
  G("histCoin").textContent = coin; const e = entries(coin); const days = Object.keys(e).sort().reverse(); const h = G("hist");
  if (!days.length) { h.innerHTML = '<p class="j-empty">Пусто.</p>'; return; }
  h.innerHTML = days.map((d) => {
    const x = e[d];
    return `<details class="j-log-item"><summary><span class="j-date">${d}</span> ${pill(x.trend)} ${x.bias ? '<span style="color:var(--text-secondary)">' + x.bias.slice(0, 42) + (x.bias.length > 42 ? "…" : "") + "</span>" : ""} ${x.grade ? '<span class="j-done">✓ разобрано</span>' : ""}</summary>
      <div class="j-log-body">
        <div class="j-kv"><b>Сверху</b> <span class="j-mono">${x.resAbove || "—"}</span> · <b>Снизу</b> <span class="j-mono">${x.supBelow || "—"}</span></div>
        <div class="j-kv"><b>A:</b> ${x.scenA || "—"}</div><div class="j-kv"><b>B:</b> ${x.scenB || "—"}</div>
        ${x.grade ? `<div class="j-kv j-grade"><b>Вывод:</b> ${x.grade}</div>` : ""}
      </div></details>`;
  }).join("");
}
function flashSaved() { const s = G("saved"); s.classList.add("show"); setTimeout(() => s.classList.remove("show"), 1500); }
G("save").onclick = () => { entries(coin)[todayKey()] = { ...(entries(coin)[todayKey()] || {}), ...readForm() }; saveDb(); flashSaved(); renderHist(); };

// ── вкладки монет ──
function renderTabs() {
  G("tabs").innerHTML = allCoins().map((c) =>
    `<button class="j-tab${c === coin ? " active" : ""}" data-coin="${c}">${c}${COINS.includes(c) ? "" : `<span class="j-rm" data-rm="${c}" title="Убрать">×</span>`}</button>`,
  ).join("") + `<button class="j-tab j-addbtn" id="addCoin" title="Добавить монету">+</button>`;
}
function showAddInput() {
  const add = G("addCoin"); if (!add) return;
  const inp = document.createElement("input"); inp.className = "j-coininput"; inp.placeholder = "тикер…"; inp.maxLength = 12;
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
    switchCoin(match); return true;
  } catch (err) { return false; }
}
function removeCoin(c) {
  customCoins = customCoins.filter((x) => x !== c); localStorage.setItem(COINS_KEY, JSON.stringify(customCoins));
  if (coin === c) switchCoin("BTC"); else renderTabs();
}
G("tabs").addEventListener("click", (e) => {
  const rm = e.target.closest(".j-rm"); if (rm) { e.stopPropagation(); removeCoin(rm.dataset.rm); return; }
  if (e.target.closest("#addCoin")) { showAddInput(); return; }
  const t = e.target.closest(".j-tab"); if (t && t.dataset.coin) switchCoin(t.dataset.coin);
});

// ── калькулятор стопа/размера ──
const CALC_KEY = "helm_cj_calc";
const num = (id) => { const v = parseFloat((G(id).value || "").replace(/[,\s]/g, "")); return Number.isFinite(v) ? v : null; };
const WALLET_LEV_CAP = 10; // практический потолок плеча кошелька (как в боте)
function renderCalc() {
  const out = G("calcOut"), sideEl = G("calcSide");
  const entry = num("calcEntry"), stop = num("calcStop"), target = num("calcTarget");
  const eq = num("calcEq"), risk = num("calcRisk");
  // запоминаем депо/риск (стабильные)
  localStorage.setItem(CALC_KEY, JSON.stringify({ eq: G("calcEq").value, risk: G("calcRisk").value }));
  if (!entry || !stop || entry <= 0 || stop <= 0 || entry === stop) {
    sideEl.textContent = ""; out.innerHTML = '<div class="j-calc-row"><b>Введи вход и стоп</b><span class="v">—</span></div>'; return;
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
      ? `<small style="color:var(--red)">уже ATR(1D)≈${currentAtrPct.toFixed(2)}% — вынесет фитилём</small>`
      : `<small style="color:var(--green)">шире ATR(1D)≈${currentAtrPct.toFixed(2)}% ✓</small>`;
  }
  rows.push(`<div class="j-calc-row"><b>Дистанция до стопа</b><span class="v">${stopDist.toFixed(2)}%${atrNote}</span></div>`);
  // размер от риска
  if (eq && risk && eq > 0 && risk > 0) {
    const riskUsd = (eq * risk) / 100;
    const sizeUsd = riskUsd / (stopDist / 100);
    const lev = sizeUsd / eq;
    const levHot = lev > WALLET_LEV_CAP;
    rows.push(`<div class="j-calc-row"><b>Риск на сделку</b><span class="v">$${riskUsd.toFixed(2)}<small>${risk}% от $${eq.toFixed(0)}</small></span></div>`);
    rows.push(`<div class="j-calc-row"><b>Размер позиции</b><span class="v">$${sizeUsd.toFixed(2)}<small style="color:${levHot ? "var(--red)" : "var(--text-muted)"}">плечо ~${lev.toFixed(1)}×${levHot ? ` › потолок ${WALLET_LEV_CAP}×` : ""}</small></span></div>`);
  } else {
    rows.push('<div class="j-calc-row"><b>Размер позиции</b><span class="v">—<small>впиши депо и риск %</small></span></div>');
  }
  // R:R до цели
  if (target && target > 0) {
    const valid = long ? target > entry : target < entry;
    if (valid) {
      const rr = Math.abs(target - entry) / Math.abs(entry - stop);
      const col = rr >= 2 ? "var(--green)" : rr < 1 ? "var(--red)" : "var(--text-secondary)";
      rows.push(`<div class="j-calc-row"><b>R:R до цели</b><span class="v" style="color:${col}">1 : ${rr.toFixed(2)}</span></div>`);
    } else {
      rows.push(`<div class="j-calc-row"><b>R:R до цели</b><span class="v"><small style="color:var(--red)">цель не на стороне ${long ? "лонга (выше входа)" : "шорта (ниже входа)"}</small></span></div>`);
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
  G("anchorDate").textContent = "разметка на " + todayKey();
  fillForm(entries(c)[todayKey()] || null); renderYesterday(); renderHist();
  loadAnchor(); if (liveTimer) clearInterval(liveTimer); liveTimer = setInterval(loadAnchor, 20000);
}
wireHelp();
wireCalc();
switchCoin("BTC");
