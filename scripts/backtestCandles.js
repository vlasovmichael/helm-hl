// ─────────────────────────────────────────────────────────────────────────────
//  Exhaustion-fade на НАСТОЯЩИХ 15m OHLC (candles.db, ~52 дня, free HL backfill).
//  First-touch считается по high/low свечей — честный стоп/таргет, без оптимизма
//  минутных марок. Сразу даёт и общий свод, и split по времени (OOS-гейт).
//
//  Запуск: node scripts/backtestCandles.js [--rt 0.10] [--tgt 1.5] [--stop 1.5]
//          [--chunks 5] [--cooldownBars 2]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const RT = parseFloat(arg('rt', '0.10'));
const TGT = parseFloat(arg('tgt', '1.5'));
const STOP = parseFloat(arg('stop', '1.5'));
const CHUNKS = parseInt(arg('chunks', '5'), 10);
const COOLDOWN = parseInt(arg('cooldownBars', '2'), 10);
const BAR = 15 * 60_000; // 15m в ms
const LOOKBACKS = [2, 4]; // в барах (30м, 60м)
const THRESHOLDS = [3, 5]; // %
const HOR = [2, 4, 8]; // бары вперёд = 30/60/120м
const MAXH = HOR[HOR.length - 1];

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
console.log(
  `[load] ${all.length} свечей · ${byCoin.size} монет · ` +
    `${new Date(tMin).toISOString().slice(0, 10)} → ${new Date(tMax).toISOString().slice(0, 10)} ` +
    `(${((tMax - tMin) / 86400_000).toFixed(0)}d)`,
);

const signedClose = (side, e, c) => (side === 'LONG' ? ((c - e) / e) * 100 : ((e - c) / e) * 100);

// генерим сигналы для заданного lookback; first-touch по high/low
function genSignals(lb) {
  const sigs = [];
  for (const bars of byCoin.values()) {
    let lastIdx = new Map(); // coin+side cooldown (по индексу бара)
    for (let i = lb; i < bars.length - 1; i++) {
      const move = ((bars[i].c - bars[i - lb].c) / bars[i - lb].c) * 100;
      if (Math.abs(move) < THRESHOLDS[0]) continue;
      const side = move > 0 ? 'SHORT' : 'LONG';
      const key = side;
      if (lastIdx.has(key) && i - lastIdx.get(key) < COOLDOWN) continue;
      lastIdx.set(key, i);
      const entry = bars[i].c;
      const sg = { t: bars[i].t, side, move, entry, ret: {} };
      // close-доходность на горизонтах
      for (const h of HOR) {
        const b = bars[i + h];
        sg.ret[h] = b ? signedClose(side, entry, b.c) : null;
      }
      // first-touch ±TGT/STOP по high/low следующих баров (стоп при двойном касании)
      let touch = null;
      const tgtPx = side === 'SHORT' ? entry * (1 - TGT / 100) : entry * (1 + TGT / 100);
      const stpPx = side === 'SHORT' ? entry * (1 + STOP / 100) : entry * (1 - STOP / 100);
      for (let k = i + 1; k <= i + MAXH && k < bars.length; k++) {
        const b = bars[k];
        const hitStop = side === 'SHORT' ? b.h >= stpPx : b.l <= stpPx;
        const hitTgt = side === 'SHORT' ? b.l <= tgtPx : b.h >= tgtPx;
        if (hitStop) { touch = 'stop'; break; } // консервативно: стоп раньше
        if (hitTgt) { touch = 'tgt'; break; }
      }
      sg.touch = touch;
      sigs.push(sg);
    }
  }
  return sigs;
}

const pct = (x) => (x == null ? '  — ' : `${(x * 100).toFixed(0)}%`.padStart(4));
const ret = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7));
function stat(list, h) {
  const r = list.map((s) => s.ret[h]).filter((x) => x != null).map((x) => x - RT);
  return {
    mean: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
    win: r.length ? r.filter((x) => x > 0).length / r.length : null,
  };
}
function touchRate(list) {
  const ft = list.filter((s) => s.touch != null);
  return { n: ft.length, r: ft.length ? ft.filter((s) => s.touch === 'tgt').length / ft.length : null };
}
function rowLine(label, list) {
  if (list.length < 5) return console.log(`${label.padEnd(30)} n=${String(list.length).padStart(4)}  (мало)`);
  const a = stat(list, 4);
  const b = stat(list, 8);
  const tc = touchRate(list);
  console.log(
    `${label.padEnd(30)} n=${String(list.length).padStart(4)}  ` +
      `60m ${ret(a.mean)}/${pct(a.win)}  120m ${ret(b.mean)}/${pct(b.win)}  ` +
      `│ touch ±${TGT}: ${pct(tc.r)} (n=${tc.n})`,
  );
}

console.log(`\n═══ Exhaustion-FADE на 15m OHLC · RT=${RT}% · ±${TGT}/${STOP}% · cooldown ${COOLDOWN}бар ═══`);
console.log('first-touch по high/low (стоп при двойном касании). формат mean/win.\n');

const sigByLb = new Map();
for (const lb of LOOKBACKS) {
  const sigs = genSignals(lb);
  sigByLb.set(lb, sigs);
  console.log(`── lookback ${lb * 15}m ──`);
  for (const T of THRESHOLDS) rowLine(`  |ход|≥${T}% все`, sigs.filter((s) => Math.abs(s.move) >= T));
  console.log('');
}

// ── OOS split по времени (берём lookback 30м = 2 бара) ───────────────────────
console.log(`══ OOS split · lookback 30m · ${CHUNKS} отрезка ══`);
const base = sigByLb.get(2);
const span = tMax - tMin;
const dstr = (t) => new Date(t).toISOString().slice(5, 10);
for (const T of THRESHOLDS) {
  console.log(`── |ход| ≥ ${T}% ──`);
  for (let ch = 0; ch < CHUNKS; ch++) {
    const lo = tMin + (span / CHUNKS) * ch;
    const hi = tMin + (span / CHUNKS) * (ch + 1);
    const list = base.filter((s) => Math.abs(s.move) >= T && s.t >= lo && s.t < hi);
    rowLine(`  [${dstr(lo)}→${dstr(hi)}]`, list);
  }
  console.log('');
}
