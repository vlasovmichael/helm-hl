// ─────────────────────────────────────────────────────────────────────────────
//  Тест ВЫХОДОВ для зафиксированного входа fade-high-ER.
//  Вход (locked): fade хода |move|≥T за moveLb баров, когда Kaufman ER (erWin) ≥ p66.
//  Варьируем только выход и сравниваем expectancy/сделку, win%, риск, OOS-split.
//
//  Запуск: node scripts/backtestExits.js [--erWin 16] [--moveLb 2] [--thr 3]
//          [--rt 0.10] [--chunks 5] [--cooldownBars 2]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const ER_W = parseInt(arg('erWin', '16'), 10);
const MOVE_LB = parseInt(arg('moveLb', '2'), 10);
const THR = parseFloat(arg('thr', '3'));
const RT = parseFloat(arg('rt', '0.10'));
const CHUNKS = parseInt(arg('chunks', '5'), 10);
const COOLDOWN = parseInt(arg('cooldownBars', '2'), 10);

const db = new Database('candles.db', { readonly: true });
const all = db.prepare('SELECT coin,t,o,h,l,c FROM candles ORDER BY coin,t').all();
db.close();
const byCoin = new Map();
for (const r of all) {
  let a = byCoin.get(r.coin);
  if (!a) byCoin.set(r.coin, (a = []));
  a.push(r);
}
const tMin = all.reduce((m, r) => Math.min(m, r.t), Infinity);
const tMax = all.reduce((m, r) => Math.max(m, r.t), -Infinity);

function er(bars, i) {
  if (i < ER_W) return null;
  const net = Math.abs(bars[i].c - bars[i - ER_W].c);
  let vol = 0;
  for (let k = i - ER_W + 1; k <= i; k++) vol += Math.abs(bars[k].c - bars[k - 1].c);
  return vol > 0 ? net / vol : null;
}

// собираем входы fade-high-ER (порог ER берём как p66 по всем событиям ≥THR)
const raw = [];
const startI = Math.max(ER_W, MOVE_LB);
for (const bars of byCoin.values()) {
  let last = new Map();
  for (let i = startI; i < bars.length - 1; i++) {
    const move = ((bars[i].c - bars[i - MOVE_LB].c) / bars[i - MOVE_LB].c) * 100;
    if (Math.abs(move) < THR) continue;
    const dir = move > 0 ? 'up' : 'down';
    if (last.has(dir) && i - last.get(dir) < COOLDOWN) continue;
    last.set(dir, i);
    const e = er(bars, i);
    if (e == null) continue;
    raw.push({ bars, i, t: bars[i].t, side: move > 0 ? 'SHORT' : 'LONG', entry: bars[i].c, er: e });
  }
}
const ersSorted = raw.map((r) => r.er).sort((a, b) => a - b);
const p66 = ersSorted[Math.floor(ersSorted.length * (2 / 3))];
const entries = raw.filter((r) => r.er >= p66);

// симуляция выхода → реализованный net % за сделку (+ число баров удержания)
function simulate(en, exit) {
  const { bars, i, side, entry } = en;
  const up = (p) => (side === 'SHORT' ? entry * (1 + p / 100) : entry * (1 - p / 100)); // против нас
  const dn = (p) => (side === 'SHORT' ? entry * (1 - p / 100) : entry * (1 + p / 100)); // в нашу
  const stopPx = exit.stop != null ? up(exit.stop) : null;
  const tgtPx = exit.tgt != null ? dn(exit.tgt) : null;
  const sret = (px) => (side === 'SHORT' ? ((entry - px) / entry) * 100 : ((px - entry) / entry) * 100);
  for (let k = i + 1; k <= i + exit.hold && k < bars.length; k++) {
    const b = bars[k];
    const hitStop = stopPx != null && (side === 'SHORT' ? b.h >= stopPx : b.l <= stopPx);
    const hitTgt = tgtPx != null && (side === 'SHORT' ? b.l <= tgtPx : b.h >= tgtPx);
    if (hitStop) return { r: sret(stopPx) - RT, bars: k - i }; // двойное касание → стоп
    if (hitTgt) return { r: sret(tgtPx) - RT, bars: k - i };
    if (k - i >= exit.hold) break;
  }
  const lastK = Math.min(i + exit.hold, bars.length - 1);
  return { r: sret(bars[lastK].c) - RT, bars: lastK - i }; // выход по времени (close)
}

const EXITS = [
  { name: 'stop1.5/tgt1.5 (база)', stop: 1.5, tgt: 1.5, hold: 8 },
  { name: 'stop2.5/tgt2.5', stop: 2.5, tgt: 2.5, hold: 8 },
  { name: 'stop2/tgt4 (2:1)', stop: 2, tgt: 4, hold: 8 },
  { name: 'time 1ч (4 бар), стоп3', stop: 3, tgt: null, hold: 4 },
  { name: 'time 2ч (8 бар), стоп3', stop: 3, tgt: null, hold: 8 },
  { name: 'time 2ч, БЕЗ стопа', stop: null, tgt: null, hold: 8 },
  { name: 'time 4ч (16 бар), стоп4', stop: 4, tgt: null, hold: 16 },
];

const f = (x, d = 2) => (x == null ? '  —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
function summarize(list) {
  const r = list.map((x) => x.r);
  const n = r.length;
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const pf = losses.length
    ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))
    : Infinity;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const worst = Math.min(...r);
  const hold = list.reduce((a, x) => a + x.bars, 0) / n;
  return { n, mean, win: wins.length / n, pf, sd, worst, hold };
}

console.log(
  `\n═══ Тест выходов · вход fade-high-ER ≥${THR}% (ER≥p66=${p66.toFixed(2)}) · ${entries.length} сделок · RT=${RT}% ═══`,
);
console.log('expect = средний net%/сделку · PF = profit factor · hold = ср. баров (×15м)\n');
console.log(
  'выход'.padEnd(26) + 'n'.padStart(5) + 'expect'.padStart(9) + 'win'.padStart(7) +
    'PF'.padStart(7) + 'worst'.padStart(8) + 'hold'.padStart(7),
);
const results = EXITS.map((ex) => ({ ex, sim: entries.map((en) => simulate(en, ex)) }));
for (const { ex, sim } of results) {
  const s = summarize(sim);
  console.log(
    ex.name.padEnd(26) +
      String(s.n).padStart(5) +
      `${f(s.mean)}%`.padStart(9) +
      `${(s.win * 100).toFixed(0)}%`.padStart(7) +
      (s.pf === Infinity ? '  inf' : f(s.pf).padStart(7)) +
      `${f(s.worst, 1)}%`.padStart(8) +
      `${s.hold.toFixed(1)}`.padStart(7),
  );
}

// OOS-split: лучший по expect, при PF>1 и worst разумном
const ranked = results
  .map((r) => ({ ...r, s: summarize(r.sim) }))
  .filter((r) => r.s.pf > 1 && r.s.worst > -6) // risk-bounded: без бомб типа -46%
  .sort((a, b) => b.s.mean - a.s.mean);
const best = ranked[0];
if (best) {
  console.log(`\n══ OOS 5-split лучшего выхода: «${best.ex.name}» ══`);
  const span = tMax - tMin;
  const dstr = (t) => new Date(t).toISOString().slice(5, 10);
  for (let ch = 0; ch < CHUNKS; ch++) {
    const lo = tMin + (span / CHUNKS) * ch;
    const hi = tMin + (span / CHUNKS) * (ch + 1);
    const sub = entries
      .map((en, idx) => ({ t: en.t, r: best.sim[idx] }))
      .filter((x) => x.t >= lo && x.t < hi)
      .map((x) => x.r);
    if (sub.length < 5) { console.log(`  [${dstr(lo)}→${dstr(hi)}] n=${sub.length} (мало)`); continue; }
    const s = summarize(sub);
    console.log(
      `  [${dstr(lo)}→${dstr(hi)}] n=${String(s.n).padStart(4)}  ` +
        `expect ${f(s.mean)}%  win ${(s.win * 100).toFixed(0)}%  PF ${f(s.pf)}  worst ${f(s.worst, 1)}%`,
    );
  }
}
