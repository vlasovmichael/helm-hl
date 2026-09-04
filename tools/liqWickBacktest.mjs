// ─────────────────────────────────────────────────────────────────────────────
//  Liquidation-Wick Fade — БЭКТЕСТ по 1m-свечам + resting-limit модель заливки.
//
// 🚨 Замер по дрейфу mid-цены физически пропускает ликвидационные фитили: они
// живут в трейд-принтах, а не в mid. Здесь детект по LOW/HIGH 1m-свечи, а вход —
// ЛИМИТКОЙ, заранее висящей в зоне вика (маркетом такое не поймать: цена там
// доли секунды). Свечи исторические и бесплатные → считаем сразу, без forward.
//
//  МОДЕЛЬ. На каждой свече T:
//    • down-wick (фейд = LONG): глубина = (open−low)/open·100. Если ≥ ENTRY_PCT →
//      лимитка налита по entry = open·(1−ENTRY_PCT/100) (консервативно: НЕ по low,
//      а по своей цене). Дальше цель/стоп ± от entry.
//    • up-wick (фейд = SHORT): симметрично по high.
//  Исход считаем со свечи T+1..T+HORIZON по high/low. Если в одной свече задеты
//  и цель, и стоп — засчитываем СТОП (консервативно). Ни то ни то → выход по
//  close последней свечи (timeout). Внутрисвечной отскок в T НЕ засчитываем
//  (его маркетом всё равно не снять) — только диагностируем.
//
//  ⚠️ Модель оптимистична в одном: считает, что лимитка ТАМ была. В forward это
//  значит держать сетку лимиток на споте — отдельный вопрос. Здесь — «был бы эдж».
//
//  Запуск: node tools/liqWickBacktest.mjs [--coins 50] [--days 10]
//          [--wick 3] [--target 1.5] [--stop 1.5] [--horizon 60] [--fee 0.05]
// ─────────────────────────────────────────────────────────────────────────────

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const API = 'https://api.hyperliquid.xyz/info';

const N_COINS   = parseInt(arg('coins', '50'), 10);
const DAYS      = parseFloat(arg('days', '10'));
const ENTRY_PCT = parseFloat(arg('wick', '3'));      // глубина лимитки = мин. вик
const TARGET_PCT= parseFloat(arg('target', '1.5'));
const STOP_PCT  = parseFloat(arg('stop', '1.5'));
const HORIZON   = parseInt(arg('horizon', '60'), 10); // свечей на ведение
const FEE_PCT   = parseFloat(arg('fee', '0.05'));     // maker-in + taker-out ~
const COOLDOWN  = HORIZON;                             // не открывать перекрытия
const NOW = Date.now();
const START = NOW - DAYS * 86400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(body, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(400 * (i + 1)); }
  }
}

async function fetchCandles(coin) {
  const out = [];
  const CHUNK = 5000 * 60_000; // ≤5000 1m-свечей за запрос (иначе HL 500-ит)
  let winStart = START;
  for (let guard = 0; guard < 30 && winStart < NOW; guard++) {
    const winEnd = Math.min(NOW, winStart + CHUNK);
    const c = await post({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime: winStart, endTime: winEnd } });
    if (Array.isArray(c) && c.length) {
      for (const k of c) out.push({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c });
      winStart = c[c.length - 1].t + 60_000;
    } else {
      winStart = winEnd; // пустое окно — двигаемся дальше
    }
    await sleep(150);
  }
  // дедуп по времени + сортировка
  const seen = new Set(); const clean = [];
  for (const k of out.sort((a, b) => a.t - b.t)) { if (seen.has(k.t)) continue; seen.add(k.t); clean.push(k); }
  return clean;
}

// Один фейд от свечи idx. Возвращает событие или null.
function simulate(rows, idx, side) {
  const c = rows[idx];
  const entry = side === 'long' ? c.o * (1 - ENTRY_PCT / 100) : c.o * (1 + ENTRY_PCT / 100);
  // Заливка: down-wick — low должен дойти до entry; up-wick — high.
  const filled = side === 'long' ? c.l <= entry : c.h >= entry;
  if (!filled) return null;
  const target = side === 'long' ? entry * (1 + TARGET_PCT / 100) : entry * (1 - TARGET_PCT / 100);
  const stop   = side === 'long' ? entry * (1 - STOP_PCT / 100)   : entry * (1 + STOP_PCT / 100);
  // Диагностика: внутрисвечной отскок (close T относительно entry).
  const sameCandleFav = side === 'long' ? (c.c - entry) / entry * 100 : (entry - c.c) / entry * 100;

  let reason = 'timeout', fillPct = null;
  const end = Math.min(rows.length - 1, idx + HORIZON);
  for (let j = idx + 1; j <= end; j++) {
    const k = rows[j];
    const hitTarget = side === 'long' ? k.h >= target : k.l <= target;
    const hitStop   = side === 'long' ? k.l <= stop   : k.h >= stop;
    if (hitStop) { reason = 'stop'; fillPct = -STOP_PCT; break; }       // стоп раньше цели (консервативно)
    if (hitTarget) { reason = 'target'; fillPct = TARGET_PCT; break; }
  }
  if (fillPct === null) {
    const last = rows[end];
    fillPct = side === 'long' ? (last.c - entry) / entry * 100 : (entry - last.c) / entry * 100;
  }
  return { side, reason, net_pct: fillPct - FEE_PCT, wick_pct: side === 'long' ? (c.o - c.l) / c.o * 100 : (c.h - c.o) / c.o * 100, sameCandleFav, ts: c.t };
}

function scanCoin(coin, rows) {
  const events = [];
  let cooldownUntil = -1;
  for (let i = 0; i < rows.length; i++) {
    if (i < cooldownUntil) continue;
    const c = rows[i];
    const downWick = (c.o - c.l) / c.o * 100;
    const upWick   = (c.h - c.o) / c.o * 100;
    let ev = null;
    if (downWick >= ENTRY_PCT) ev = simulate(rows, i, 'long');
    else if (upWick >= ENTRY_PCT) ev = simulate(rows, i, 'short');
    if (ev) { ev.coin = coin; events.push(ev); cooldownUntil = i + COOLDOWN; }
  }
  return events;
}

const stat = (a) => {
  const n = a.length; if (!n) return null;
  const m = a.reduce((x, r) => x + r.net_pct, 0) / n;
  const sd = Math.sqrt(a.reduce((x, r) => x + (r.net_pct - m) ** 2, 0) / Math.max(1, n - 1));
  const win = a.filter((r) => r.net_pct > 0).length / n * 100;
  return { n, exp: m, sd, t: m / (sd / Math.sqrt(n)), win, sum: m * n };
};
const f = (s) => s ? `n=${String(s.n).padEnd(5)} win=${s.win.toFixed(0).padStart(3)}% exp=${s.exp.toFixed(3)}% t=${s.t.toFixed(2).padStart(6)} sum=${s.sum.toFixed(1)}%` : '—';

async function main() {
  console.log(`[liq-wick] окно=${DAYS}д coins=${N_COINS} wick/entry=${ENTRY_PCT}% target=${TARGET_PCT}% stop=${STOP_PCT}% horizon=${HORIZON}м fee=${FEE_PCT}%`);
  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
  const universe = meta.universe
    .map((u, i) => ({ coin: u.name, vlm: +(ctxs[i]?.dayNtlVlm || 0) }))
    .filter((u) => u.vlm > 0)
    .sort((a, b) => b.vlm - a.vlm)
    .slice(0, N_COINS);
  console.log(`[liq-wick] юниверс (top vlm): ${universe.slice(0, 12).map((u) => u.coin).join(', ')}…`);

  const all = [];
  for (const { coin } of universe) {
    try {
      const rows = await fetchCandles(coin);
      if (rows.length < HORIZON + 2) continue;
      const evs = scanCoin(coin, rows);
      all.push(...evs);
      process.stdout.write(`\r[liq-wick] ${coin.padEnd(10)} свечей=${rows.length} событий=${evs.length}  всего=${all.length}   `);
    } catch (e) { process.stdout.write(`\r[liq-wick] ${coin}: ${e.message}\n`); }
  }
  console.log('\n');

  const longs = all.filter((r) => r.side === 'long');
  const shorts = all.filter((r) => r.side === 'short');
  console.log('══ РЕЗУЛЬТАТ ══');
  console.log('ALL         ', f(stat(all)));
  console.log('LONG (down) ', f(stat(longs)));
  console.log('SHORT (up)  ', f(stat(shorts)));
  console.log('');
  // По глубине вика
  console.log('── по глубине фактического вика ──');
  for (const [lo, hi] of [[3, 5], [5, 8], [8, 15], [15, 999]]) {
    const b = all.filter((r) => r.wick_pct >= lo && r.wick_pct < hi);
    console.log(`  ${lo}-${hi === 999 ? '∞' : hi}%   `, f(stat(b)));
  }
  // Выходы
  const byReason = {}; for (const r of all) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  console.log('\nexits:', JSON.stringify(byReason));
  // Диагностика внутрисвечного отскока
  const snap = all.filter((r) => r.sameCandleFav > TARGET_PCT).length;
  console.log(`внутрисвечной отскок ≥ цель (close T): ${(snap / all.length * 100).toFixed(0)}% (${snap}/${all.length}) — этот эдж маркетом НЕ снять`);
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
