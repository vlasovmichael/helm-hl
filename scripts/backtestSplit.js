// ─────────────────────────────────────────────────────────────────────────────
//  Out-of-sample split-тест для exhaustion-fade.
//  Бьёт историю на N равных по времени отрезков и считает эдж ≥3%/≥5% в каждом
//  ОТДЕЛЬНО. Эдж реален, если держится во всех отрезках; иначе — режим/везение.
//
//  Запуск: node scripts/backtestSplit.js [--chunks 3] [--lookback 30] [--rt 0.10]
//          [--tgt 1.5] [--stop 1.5] [--cooldown 1800] [--step 300]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DB_PATH = arg('db', 'hl_snapshot.db');
const CHUNKS = parseInt(arg('chunks', '3'), 10);
const L = parseInt(arg('lookback', '30'), 10);
const STEP = parseInt(arg('step', '300'), 10);
const RT = parseFloat(arg('rt', '0.10'));
const TGT = parseFloat(arg('tgt', '1.5'));
const STOP = parseFloat(arg('stop', '1.5'));
const COOLDOWN = parseInt(arg('cooldown', '1800'), 10);
const TOL = 90;
const THRESHOLDS = [3, 5];
const HORIZONS = [3600, 7200]; // 60/120м

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare('SELECT ts, coin, mark, oi FROM samples ORDER BY ts').all();
db.close();

const byCoin = new Map();
let tMin = Infinity;
let tMax = -Infinity;
for (const r of rows) {
  if (r.mark == null) continue;
  let c = byCoin.get(r.coin);
  if (!c) byCoin.set(r.coin, (c = new Map()));
  c.set(r.ts, { mark: r.mark, oi: r.oi });
  if (r.ts < tMin) tMin = r.ts;
  if (r.ts > tMax) tMax = r.ts;
}
function sampleAt(coin, ts) {
  const c = byCoin.get(coin);
  if (!c) return null;
  const hit = c.get(ts);
  if (hit) return hit;
  for (let d = 60; d <= TOL; d += 60) {
    if (c.get(ts + d)) return c.get(ts + d);
    if (c.get(ts - d)) return c.get(ts - d);
  }
  return null;
}
const priceAt = (coin, ts) => sampleAt(coin, ts)?.mark ?? null;
const signed = (side, e, f) => (side === 'LONG' ? ((f - e) / e) * 100 : ((e - f) / e) * 100);

// генерим все сигналы ≥min(THRESHOLDS) один раз
const sigs = [];
const lastFire = new Map();
for (const coin of byCoin.keys()) {
  const c = byCoin.get(coin);
  for (let ts = tMin + L * 60; ts <= tMax; ts += STEP) {
    const now = c.get(ts);
    if (!now) continue;
    const past = sampleAt(coin, ts - L * 60);
    if (!past) continue;
    const move = ((now.mark - past.mark) / past.mark) * 100;
    if (Math.abs(move) < THRESHOLDS[0]) continue;
    const side = move > 0 ? 'SHORT' : 'LONG';
    const key = `${coin}|${side}`;
    if (lastFire.get(key) != null && ts - lastFire.get(key) < COOLDOWN) continue;
    lastFire.set(key, ts);
    const sg = { ts, coin, side, move, entry: now.mark, ret: {} };
    for (const h of HORIZONS) {
      const fut = priceAt(coin, ts + h);
      sg.ret[h] = fut == null ? null : signed(side, now.mark, fut);
    }
    const H = HORIZONS[HORIZONS.length - 1];
    let touch = null;
    for (let t = ts + 60; t <= ts + H; t += 60) {
      const p = priceAt(coin, t);
      if (p == null) continue;
      const r = signed(side, now.mark, p);
      if (r >= TGT) { touch = 'tgt'; break; }
      if (r <= -STOP) { touch = 'stop'; break; }
    }
    sg.touch = touch;
    sigs.push(sg);
  }
}

const span = tMax - tMin;
const chunkOf = (ts) => Math.min(CHUNKS - 1, Math.floor(((ts - tMin) / span) * CHUNKS));
const pct = (x) => (x == null ? '  — ' : `${(x * 100).toFixed(0)}%`.padStart(4));
const ret = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7));
const dstr = (ts) => new Date(ts * 1000).toISOString().slice(5, 10);

function stat(list, h) {
  const r = list.map((s) => s.ret[h]).filter((x) => x != null).map((x) => x - RT);
  return {
    n: r.length,
    mean: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
    win: r.length ? r.filter((x) => x > 0).length / r.length : null,
  };
}
function touchRate(list) {
  const ft = list.filter((s) => s.touch != null);
  return { n: ft.length, r: ft.length ? ft.filter((s) => s.touch === 'tgt').length / ft.length : null };
}

console.log(`\n═══ Split-тест · lookback ${L}m · ${CHUNKS} отрезка · RT=${RT}% · ±${TGT}/${STOP}% ═══`);
console.log('Эдж реален, если 60m/120m win и touch держатся ВО ВСЕХ отрезках.\n');

for (const T of THRESHOLDS) {
  console.log(`──────── |ход| ≥ ${T}% ────────`);
  for (let ch = 0; ch < CHUNKS; ch++) {
    const lo = tMin + Math.floor((span / CHUNKS) * ch);
    const hi = tMin + Math.floor((span / CHUNKS) * (ch + 1));
    const list = sigs.filter((s) => Math.abs(s.move) >= T && chunkOf(s.ts) === ch);
    const h60 = stat(list, 3600);
    const h120 = stat(list, 7200);
    const tc = touchRate(list);
    console.log(
      `  [${dstr(lo)}→${dstr(hi)}] n=${String(list.length).padStart(4)}  ` +
        `60m ${ret(h60.mean)}/${pct(h60.win)}  ` +
        `120m ${ret(h120.mean)}/${pct(h120.win)}  ` +
        `│ touch ±${TGT}: ${pct(tc.r)} (n=${tc.n})`,
    );
  }
  console.log('');
}
