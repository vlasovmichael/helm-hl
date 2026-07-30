// ─────────────────────────────────────────────────────────────────────────────
//  Liquidation-Wick Collector — ФОРВАРД-замер фейда ликвидационных фитилей.
//
//  Отдельный процесс (НЕ трогает бота): свой poll 1m-свечей HL, ноль ордеров.
//  Бэктест уперся в лимит HL (1m только ~3.5 дня) → набираем forward. Детект по
//  LOW/HIGH закрытой 1m-свечи (то, что видно на графике), вход — ЛИМИТКОЙ в зоне
//  вика (маркетом такое не снять). Ведение до target/stop/timeout по следующим
//  свечам. События пишем в формате, совместимом с карточкой /lab (buildOverview):
//  { coin, side, entry_ts, exit_ts, entry_px, exit_px, net_pct, exit_reason,
//    mfe_pct, mae_pct, wick_pct }.
//
//  Гипотеза из бэктеста (n=61): мелкие 3–5% флеши мягко mean-reverse, глубокие —
//  нет. Проверяем forward в разных режимах.
//
//  ENV: LIQ_WICK_PCT, LIQ_TARGET_PCT, LIQ_STOP_PCT, LIQ_HORIZON_MIN, LIQ_FEE_PCT,
//       LIQ_COINS, LIQ_POLL_MS, LIQ_BANNED. Запуск: node tools/liqWickCollector.mjs
//       (--tally — вывести текущую статистику и выйти)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const API = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const WICK_PCT   = parseFloat(process.env.LIQ_WICK_PCT   || '3');
const TARGET_PCT = parseFloat(process.env.LIQ_TARGET_PCT || '1.5');
const STOP_PCT   = parseFloat(process.env.LIQ_STOP_PCT   || '1.5');
const HORIZON_MIN= parseInt(process.env.LIQ_HORIZON_MIN  || '60', 10);
const FEE_PCT    = parseFloat(process.env.LIQ_FEE_PCT    || '0.05');
const N_COINS    = parseInt(process.env.LIQ_COINS        || '120', 10);
const POLL_MS    = parseInt(process.env.LIQ_POLL_MS      || '90000', 10);
const BANNED = new Set((process.env.LIQ_BANNED || 'AERO,HMSTR,KAITO,JTO,CASHCAT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

const DIR = path.join('data', 'liq-wick');
const EVENTS = path.join(DIR, 'events.jsonl');
const OPEN = path.join(DIR, 'open.json');
const HORIZON_MS = HORIZON_MIN * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ── Весовой бюджет (2026-07-30) ──────────────────────────────────────────────
// 🚨 Лимит HL /info — 1200 ЕДИНИЦ ВЕСА в минуту на IP, и он ОБЩИЙ для всех
// процессов с этого адреса. candleSnapshot весит 20, значит прежний режим
// (120 монет каждые 90с) жёг ~1600 веса/мин — один этот коллектор перекрывал
// весь лимит IP, а 429 ловил в основном сосед по коробке, живой бот
// (hl-paper-scanner): его собственный бюджет показывал 13% расхода, но отказы
// шли всё равно. Здесь берём МАЛУЮ долю и растягиваем цикл: это форвард-замер
// для карточки /lab, задержка детекта на минуты не портит ничего — вик всё
// равно виден в lookback закрытых свечей, а «вход» и так гипотетический.
const WEIGHT_BUDGET = parseInt(process.env.LIQ_WEIGHT_BUDGET || '250', 10);
const WEIGHT_WINDOW_MS = 60_000;
const WEIGHT_LIGHT = new Set(['l2Book', 'allMids', 'clearinghouseState',
  'spotClearinghouseState', 'orderStatus', 'exchangeStatus']);
const weightOf = (body) => (WEIGHT_LIGHT.has(body?.type) ? 2 : 20);

const spent = [];
let spentSum = 0;
async function reserveWeight(w) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].at >= WEIGHT_WINDOW_MS) spentSum -= spent.shift().w;
    if (spentSum + w <= WEIGHT_BUDGET) { spent.push({ at: now, w }); spentSum += w; return; }
    await sleep(Math.min(Math.max(WEIGHT_WINDOW_MS - (now - spent[0].at) + 5, 25), 2000));
  }
}

async function post(body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      await reserveWeight(weightOf(body));
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) { await sleep(600 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(400 * (i + 1)); }
  }
}

// ── Состояние ────────────────────────────────────────
// open: coin -> активная гипотетика; cooldownUntil: coin -> ts
let open = {};
const cooldownUntil = new Map();

function loadOpen() {
  try { open = JSON.parse(fs.readFileSync(OPEN, 'utf8')) || {}; } catch { open = {}; }
}
function saveOpen() {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(OPEN, JSON.stringify(open)); } catch (e) { log(`saveOpen: ${e.message}`); }
}
function appendEvent(ev) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n'); } catch (e) { log(`appendEvent: ${e.message}`); }
}

async function fetchRecent(coin, count) {
  const end = Date.now();
  const start = end - (count + 2) * 60_000;
  const c = await post({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime: start, endTime: end } });
  if (!Array.isArray(c)) return [];
  return c.map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })).sort((a, b) => a.t - b.t);
}

// Ведём открытую позу по свечам ПОСЛЕ её входа. Возвращает финальное событие или null.
function resolveOpen(pos, rows) {
  const after = rows.filter((k) => k.t > pos.entryTs);
  for (const k of after) {
    const fav = pos.side === 'long' ? (k.h - pos.entryPx) / pos.entryPx * 100 : (pos.entryPx - k.l) / pos.entryPx * 100;
    const adv = pos.side === 'long' ? (k.l - pos.entryPx) / pos.entryPx * 100 : (pos.entryPx - k.h) / pos.entryPx * 100;
    if (fav > pos.mfe) pos.mfe = fav;
    if (adv < pos.mae) pos.mae = adv;
    const hitStop   = pos.side === 'long' ? k.l <= pos.stopPx   : k.h >= pos.stopPx;
    const hitTarget = pos.side === 'long' ? k.h >= pos.targetPx : k.l <= pos.targetPx;
    if (hitStop)   return finalize(pos, k.t, pos.stopPx,  -STOP_PCT, 'stop');
    if (hitTarget) return finalize(pos, k.t, pos.targetPx, TARGET_PCT, 'target');
  }
  // Таймаут: дедлайн прошёл — выходим по close последней свечи.
  if (Date.now() >= pos.deadline && after.length) {
    const last = after[after.length - 1];
    const fillPct = pos.side === 'long' ? (last.c - pos.entryPx) / pos.entryPx * 100 : (pos.entryPx - last.c) / pos.entryPx * 100;
    return finalize(pos, last.t, last.c, fillPct, 'timeout');
  }
  return null;
}

function finalize(pos, exitTs, exitPx, fillPct, reason) {
  return {
    coin: pos.coin, side: pos.side, entry_ts: pos.entryTs, exit_ts: exitTs,
    entry_px: pos.entryPx, exit_px: exitPx, net_pct: fillPct - FEE_PCT,
    exit_reason: reason, mfe_pct: pos.mfe, mae_pct: pos.mae, wick_pct: pos.wickPct,
  };
}

// Детект вика в последней ЗАКРЫТОЙ свече (предпоследняя — последняя может формироваться).
function detectWick(coin, rows) {
  if (rows.length < 2) return null;
  const c = rows[rows.length - 2];
  const downWick = (c.o - c.l) / c.o * 100;
  const upWick   = (c.h - c.o) / c.o * 100;
  const side = downWick >= WICK_PCT ? 'long' : upWick >= WICK_PCT ? 'short' : null;
  if (!side) return null;
  const entryPx = side === 'long' ? c.o * (1 - WICK_PCT / 100) : c.o * (1 + WICK_PCT / 100);
  return {
    coin, side, entryTs: c.t, entryPx,
    targetPx: side === 'long' ? entryPx * (1 + TARGET_PCT / 100) : entryPx * (1 - TARGET_PCT / 100),
    stopPx:   side === 'long' ? entryPx * (1 - STOP_PCT / 100)   : entryPx * (1 + STOP_PCT / 100),
    deadline: c.t + HORIZON_MS, mfe: 0, mae: 0, wickPct: side === 'long' ? downWick : upWick,
  };
}

let universe = [];
let universeAt = 0;
async function refreshUniverse() {
  if (Date.now() - universeAt < 3_600_000 && universe.length) return;
  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
  universe = meta.universe
    .map((u, i) => ({ coin: u.name, vlm: +(ctxs[i]?.dayNtlVlm || 0) }))
    .filter((u) => u.vlm > 0 && !BANNED.has(u.coin.toUpperCase()) && /^[A-Z0-9]+$/.test(u.coin))
    .sort((a, b) => b.vlm - a.vlm).slice(0, N_COINS).map((u) => u.coin);
  universeAt = Date.now();
  log(`universe=${universe.length} (${universe.slice(0, 8).join(', ')}…)`);
}

// Полный обход вселенной теперь ограничен весом, а не sleep'ом: 120 монет × 20
// веса при бюджете 250/мин ≈ 10 мин на круг. Lookback обязан перекрывать круг,
// иначе между визитами к монете выпадут свечи и открытая гипотетика не
// разрешится по target/stop. Одна свеча в запросе ничего не стоит (вес зависит
// от ТИПА запроса, не от count), поэтому берём с запасом.
const CYCLE_MIN = Math.ceil((N_COINS * 20) / WEIGHT_BUDGET);

async function tick() {
  await refreshUniverse();
  const need = HORIZON_MIN + CYCLE_MIN + 10;
  let opened = 0, closed = 0;
  for (const coin of universe) {
    try {
      const rows = await fetchRecent(coin, need);
      if (rows.length < 3) continue;
      // 1) вести открытую
      if (open[coin]) {
        const ev = resolveOpen(open[coin], rows);
        if (ev) {
          appendEvent(ev); delete open[coin]; closed++;
          cooldownUntil.set(coin, Date.now() + HORIZON_MS);
          log(`CLOSE ${coin} ${ev.side} ${ev.exit_reason} net=${ev.net_pct.toFixed(2)}%`);
        }
      }
      // 2) детект нового вика (если нет открытой и не на кулдауне)
      if (!open[coin] && (cooldownUntil.get(coin) || 0) < Date.now()) {
        const w = detectWick(coin, rows);
        if (w) { open[coin] = w; opened++; log(`OPEN ${coin} ${w.side} wick=${w.wickPct.toFixed(1)}% @${w.entryPx.toPrecision(6)}`); }
      }
      await sleep(60);
    } catch (e) { /* монета мигнула — пропускаем тик */ }
  }
  saveOpen();
  if (opened || closed) log(`tick: +${opened} open / ${closed} closed / ${Object.keys(open).length} live`);
}

// ── CLI --tally ──────────────────────────────────────
function tally() {
  let rows = [];
  try { rows = fs.readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const stat = (a) => { const n = a.length; if (!n) return '—'; const m = a.reduce((x, r) => x + r.net_pct, 0) / n; const sd = Math.sqrt(a.reduce((x, r) => x + (r.net_pct - m) ** 2, 0) / Math.max(1, n - 1)); const win = a.filter((r) => r.net_pct > 0).length / n * 100; return `n=${n} win=${win.toFixed(0)}% exp=${m.toFixed(3)}% t=${(m / (sd / Math.sqrt(n))).toFixed(2)} sum=${(m * n).toFixed(1)}%`; };
  console.log('ALL  ', stat(rows));
  console.log('LONG ', stat(rows.filter((r) => r.side === 'long')));
  console.log('SHORT', stat(rows.filter((r) => r.side === 'short')));
  console.log('3-5% ', stat(rows.filter((r) => r.wick_pct >= 3 && r.wick_pct < 5)));
  console.log('5%+  ', stat(rows.filter((r) => r.wick_pct >= 5)));
}

if (process.argv.includes('--tally')) { tally(); process.exit(0); }

// ── main loop ────────────────────────────────────────
loadOpen();
log(`Liq-Wick Collector: wick=${WICK_PCT}% target=${TARGET_PCT}% stop=${STOP_PCT}% horizon=${HORIZON_MIN}m coins=${N_COINS} poll=${POLL_MS}ms | вес ≤${WEIGHT_BUDGET}/мин → круг ≈${CYCLE_MIN}м, lookback ${HORIZON_MIN + CYCLE_MIN + 10}м`);
log(`восстановлено открытых: ${Object.keys(open).length}`);
(async function loop() {
  for (;;) {
    const t0 = Date.now();
    try { await tick(); } catch (e) { log(`tick failed: ${e.message}`); }
    const wait = Math.max(5000, POLL_MS - (Date.now() - t0));
    await sleep(wait);
  }
})();
