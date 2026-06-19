// ─────────────────────────────────────────────────────────────────────────────
//  Рыночный режим vs fade-high-ER: объясняет ли МАКРО-состояние рынка нестабильность
//  эджа во времени (backtestRegime показал: эдж тащит одно окно, OOS-провал).
//
//  Гипотеза: fade выдохшегося хода (|move|≥T/30m, ER монеты ≥ erHi) прибылен НЕ всегда,
//  а только в определённом РЫНОЧНОМ режиме. Кандидаты-признаки режима (на момент входа):
//    · btcER   — Kaufman ER самого BTC (рынок трендит или пилит)
//    · btcVol  — реализованная вола BTC за окно (штиль / шторм)
//    · breadth — сколько монет пампит/дампит (≥T) в ±30м (штиль против мании)
//
//  Для каждого признака бьём fade-сделки на терцили и смотрим 120m edge/win.
//  Признак, который чисто отделяет прибыльные от мёртвых, = и есть классификатор.
//  Плюс OOS-split: половина старых / половина свежих дней — выживает ли разделение.
//
//  Запуск: node scripts/backtestMarketRegime.js [--erWin 16] [--moveLb 2] [--rt 0.10]
//          [--erHi 0.47] [--T 3] [--cooldownBars 2] [--hor 8]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const ER_W = parseInt(arg('erWin', '16'), 10); // окно ER в барах (16=4ч)
const MOVE_LB = parseInt(arg('moveLb', '2'), 10); // окно «хода» (2=30м)
const RT = parseFloat(arg('rt', '0.10')); // round-trip costs %
const ER_HI = parseFloat(arg('erHi', '0.47')); // порог «высокого ER» монеты (p66 из regime-теста)
const T = parseFloat(arg('T', '3')); // порог хода %
const COOLDOWN = parseInt(arg('cooldownBars', '2'), 10);
const HOR = parseInt(arg('hor', '8'), 10); // горизонт исхода (8=120м)
const BREADTH_WIN = 2; // ±2 бара (±30м) для подсчёта массовости

const db = new Database('candles.db', { readonly: true });
const all = db.prepare('SELECT coin,t,o,h,l,c FROM candles ORDER BY coin,t').all();
db.close();

const byCoin = new Map();
for (const r of all) {
  let a = byCoin.get(r.coin);
  if (!a) byCoin.set(r.coin, (a = []));
  a.push(r);
}

// BTC-бары + индекс по времени для макро-признаков
const btc = byCoin.get('BTC') || [];
const btcIdxByT = new Map(btc.map((b, i) => [b.t, i]));
const btcTimes = btc.map((b) => b.t);
function btcIdxAt(t) {
  if (btcIdxByT.has(t)) return btcIdxByT.get(t);
  // ближайший бар не позже t
  let lo = 0, hi = btcTimes.length - 1, res = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (btcTimes[m] <= t) { res = m; lo = m + 1; } else hi = m - 1;
  }
  return res;
}
function efficiencyRatio(bars, i, w) {
  if (i < w) return null;
  const net = Math.abs(bars[i].c - bars[i - w].c);
  let vol = 0;
  for (let k = i - w + 1; k <= i; k++) vol += Math.abs(bars[k].c - bars[k - 1].c);
  return vol > 0 ? net / vol : null;
}
function realizedVol(bars, i, w) {
  if (i < w) return null;
  let v = 0;
  for (let k = i - w + 1; k <= i; k++) v += Math.abs((bars[k].c - bars[k - 1].c) / bars[k - 1].c) * 100;
  return v;
}

const signedClose = (side, e, c) => (side === 'LONG' ? ((c - e) / e) * 100 : ((e - c) / e) * 100);

// ── Детект fade-событий (move≥T, ER монеты ≥ ER_HI) ──────────────────────────
const startI = Math.max(ER_W, MOVE_LB);
const events = [];
for (const bars of byCoin.values()) {
  let last = new Map();
  for (let i = startI; i < bars.length - 1; i++) {
    const move = ((bars[i].c - bars[i - MOVE_LB].c) / bars[i - MOVE_LB].c) * 100;
    if (Math.abs(move) < T) continue;
    const dir = move > 0 ? 'up' : 'down';
    if (last.has(dir) && i - last.get(dir) < COOLDOWN) continue;
    last.set(dir, i);
    const er = efficiencyRatio(bars, i, ER_W);
    if (er == null || er < ER_HI) continue; // только высокий ER (как в построенной стратегии)
    const entry = bars[i].c;
    const fadeSide = move > 0 ? 'SHORT' : 'LONG';
    const exit = bars[i + HOR] ? signedClose(fadeSide, entry, bars[i + HOR].c) : null;
    if (exit == null) continue;
    // макро-признаки на момент t
    const bi = btcIdxAt(bars[i].t);
    const btcER = bi >= 0 ? efficiencyRatio(btc, bi, ER_W) : null;
    const btcVol = bi >= 0 ? realizedVol(btc, bi, ER_W) : null;
    events.push({ t: bars[i].t, edge: exit - RT, btcER, btcVol, breadth: 0 });
  }
}

// breadth: сколько fade-событий в ±BREADTH_WIN баров (±30м) вокруг каждого
const STEP = 15 * 60 * 1000;
const tCount = new Map();
for (const e of events) tCount.set(e.t, (tCount.get(e.t) || 0) + 1);
for (const e of events) {
  let b = 0;
  for (let d = -BREADTH_WIN; d <= BREADTH_WIN; d++) b += tCount.get(e.t + d * STEP) || 0;
  e.breadth = b;
}

// ── Статистика ───────────────────────────────────────────────────────────────
const ret = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7));
const pct = (x) => (x == null ? ' — ' : `${(x * 100).toFixed(0)}%`.padStart(4));
function stat(list) {
  const r = list.map((e) => e.edge);
  return {
    n: r.length,
    mean: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
    win: r.length ? r.filter((x) => x > 0).length / r.length : null,
  };
}
function line(label, list) {
  if (list.length < 20) return console.log(`${label.padEnd(30)} n=${String(list.length).padStart(4)} (мало)`);
  const s = stat(list);
  console.log(`${label.padEnd(30)} n=${String(s.n).padStart(4)}  120m ${ret(s.mean)} / ${pct(s.win)}`);
}
const quantile = (sorted, q) => sorted[Math.floor(sorted.length * q)];

function byTercile(feat, label) {
  const ev = events.filter((e) => e[feat] != null);
  if (ev.length < 60) return console.log(`\n[${label}] мало данных (${ev.length})`);
  const vals = ev.map((e) => e[feat]).sort((a, b) => a - b);
  const p33 = quantile(vals, 1 / 3), p66 = quantile(vals, 2 / 3);
  console.log(`\n──── режим = ${label}  (p33=${p33.toFixed(2)} p66=${p66.toFixed(2)}) ────`);
  line('  низкий', ev.filter((e) => e[feat] <= p33));
  line('  средний', ev.filter((e) => e[feat] > p33 && e[feat] < p66));
  line('  высокий', ev.filter((e) => e[feat] >= p66));
}

console.log(`\n═══ Рыночный режим vs fade-high-ER ═══`);
console.log(`fade: |ход|≥${T}%/30м, ER монеты≥${ER_HI}, выход 120м, RT=${RT}%`);
console.log(`${events.length} fade-событий · ${byCoin.size} монет · BTC-баров ${btc.length}\n`);
line('ВСЁ fade-high-ER', events);

byTercile('btcER', 'BTC ER (тренд рынка)');
byTercile('btcVol', 'BTC вола (штиль/шторм)');
byTercile('breadth', 'breadth (массовость движа)');

// ── OOS: лучший признак на старой половине → проверка на свежей ───────────────
console.log('\n══ OOS: разделение по breadth, старая половина vs свежая ══');
const sorted = [...events].sort((a, b) => a.t - b.t);
const mid = sorted[Math.floor(sorted.length / 2)].t;
const half = (name, arr) => {
  const vals = arr.map((e) => e.breadth).sort((a, b) => a - b);
  const p33 = quantile(vals, 1 / 3), p66 = quantile(vals, 2 / 3);
  console.log(`── ${name} (n=${arr.length}, breadth p33=${p33} p66=${p66}) ──`);
  line('  breadth низкий (штиль)', arr.filter((e) => e.breadth <= p33));
  line('  breadth высокий (мания)', arr.filter((e) => e.breadth >= p66));
};
half('СТАРАЯ половина', sorted.filter((e) => e.t < mid));
half('СВЕЖАЯ половина', sorted.filter((e) => e.t >= mid));
