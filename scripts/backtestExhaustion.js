// ─────────────────────────────────────────────────────────────────────────────
//  Exhaustion-fade backtest (Hunter-тезис) для карточки Hot Movers.
//
//  НЕ логика карточки. Прямая проверка идеи «всё скуплено, выдохлась → шорт»:
//  резкий ход за lookback мин → fade ПРОТИВ него (памп→short, дамп→long), с
//  фильтрами по поведению OI. Меряем forward-доходность 30/60/120 мин, win-rate,
//  first-touch ±target. Net of fees. Свип по lookback × порог × OI-режим.
//
//  Запуск:  node scripts/backtestExhaustion.js [--db hl_snapshot.db] [--step 300]
//           [--rt 0.10] [--tgt 1.5] [--stop 1.5] [--cooldown 1800]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DB_PATH = arg('db', 'hl_snapshot.db');
const STEP = parseInt(arg('step', '300'), 10);
const RT = parseFloat(arg('rt', '0.10'));
const TGT = parseFloat(arg('tgt', '1.5'));
const STOP = parseFloat(arg('stop', '1.5'));
const COOLDOWN = parseInt(arg('cooldown', '1800'), 10);
const TOL = 90;

const LOOKBACKS = [15, 30, 60]; // мин — за сколько меряем «ход»
const THRESHOLDS = [2, 3, 5]; // % — порог хода для входа в fade
const HORIZONS = [1800, 3600, 7200]; // 30/60/120 мин

// ── load ─────────────────────────────────────────────────────────────────────
console.log(`[load] ${DB_PATH} …`);
const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare('SELECT ts, coin, mark, oi, funding FROM samples ORDER BY ts').all();
db.close();

const byCoin = new Map();
for (const r of rows) {
  if (r.mark == null) continue;
  let c = byCoin.get(r.coin);
  if (!c) byCoin.set(r.coin, (c = new Map()));
  c.set(r.ts, { mark: r.mark, oi: r.oi, funding: r.funding });
}
let tMin = Infinity;
let tMax = -Infinity;
for (const r of rows) {
  if (r.ts < tMin) tMin = r.ts;
  if (r.ts > tMax) tMax = r.ts;
}
console.log(
  `[load] ${rows.length} rows · ${byCoin.size} coins · ${((tMax - tMin) / 86400).toFixed(1)}d`,
);

function sampleAt(coin, ts) {
  const c = byCoin.get(coin);
  if (!c) return null;
  const hit = c.get(ts);
  if (hit) return hit;
  for (let d = 60; d <= TOL; d += 60) {
    const a = c.get(ts + d);
    if (a) return a;
    const b = c.get(ts - d);
    if (b) return b;
  }
  return null;
}
const priceAt = (coin, ts) => sampleAt(coin, ts)?.mark ?? null;

const signed = (side, entry, fut) =>
  side === 'LONG' ? ((fut - entry) / entry) * 100 : ((entry - fut) / entry) * 100;

// ── generate signals per lookback (магнитуда хода + OI-режим сохраняются) ──────
const coins = [...byCoin.keys()];
const byLookback = new Map(); // L -> [signals]

for (const L of LOOKBACKS) {
  const sigs = [];
  const lastFire = new Map(); // coin|side -> ts
  for (const coin of coins) {
    const c = byCoin.get(coin);
    for (let ts = tMin + L * 60; ts <= tMax; ts += STEP) {
      const now = c.get(ts);
      if (!now) continue;
      const past = sampleAt(coin, ts - L * 60);
      if (!past) continue;
      const move = ((now.mark - past.mark) / past.mark) * 100;
      if (Math.abs(move) < THRESHOLDS[0]) continue; // ниже минимального порога
      const side = move > 0 ? 'SHORT' : 'LONG'; // FADE против хода
      const key = `${coin}|${side}`;
      const prev = lastFire.get(key);
      if (prev != null && ts - prev < COOLDOWN) continue;
      lastFire.set(key, ts);
      const oiChange =
        now.oi != null && past.oi != null && past.oi > 0
          ? ((now.oi - past.oi) / past.oi) * 100
          : null;
      sigs.push({ ts, coin, side, move, oiChange, funding: now.funding, entry: now.mark });
    }
  }
  // forward-исходы
  for (const sg of sigs) {
    sg.ret = {};
    for (const h of HORIZONS) {
      const fut = priceAt(sg.coin, sg.ts + h);
      sg.ret[h] = fut == null ? null : signed(sg.side, sg.entry, fut);
    }
    const H = HORIZONS[HORIZONS.length - 1];
    let touch = null;
    for (let t = sg.ts + 60; t <= sg.ts + H; t += 60) {
      const p = priceAt(sg.coin, t);
      if (p == null) continue;
      const r = signed(sg.side, sg.entry, p);
      if (r >= TGT) {
        touch = 'tgt';
        break;
      }
      if (r <= -STOP) {
        touch = 'stop';
        break;
      }
    }
    sg.touch = touch;
  }
  byLookback.set(L, sigs);
}

// ── aggregate / print ────────────────────────────────────────────────────────
function agg(list) {
  const o = {};
  for (const h of HORIZONS) {
    const r = list.map((s) => s.ret[h]).filter((x) => x != null).map((x) => x - RT);
    o[h] = {
      mean: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
      win: r.length ? r.filter((x) => x > 0).length / r.length : null,
    };
  }
  const ft = list.filter((s) => s.touch != null);
  o.touch = ft.length ? ft.filter((s) => s.touch === 'tgt').length / ft.length : null;
  o.touchN = ft.length;
  return o;
}
const pct = (x) => (x == null ? '  — ' : `${(x * 100).toFixed(0)}%`.padStart(4));
const ret = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}%`.padStart(8));

function row(label, list) {
  if (list.length < 5) {
    console.log(`${label.padEnd(34)} n=${String(list.length).padStart(4)}  (мало)`);
    return;
  }
  const a = agg(list);
  console.log(
    `${label.padEnd(34)} n=${String(list.length).padStart(4)}  ` +
      `30m ${ret(a[1800].mean)}/${pct(a[1800].win)}  ` +
      `60m ${ret(a[3600].mean)}/${pct(a[3600].win)}  ` +
      `120m ${ret(a[7200].mean)}/${pct(a[7200].win)}  ` +
      `│ touch ±${TGT}: ${pct(a.touch)} (n=${a.touchN})`,
  );
}

console.log(`\n═══ Exhaustion-FADE · RT=${RT}% · target/stop ±${TGT}/${STOP}% · cooldown ${COOLDOWN / 60}m ═══`);
console.log('FADE против хода (памп→short, дамп→long). net = после комиссии; формат mean/win.\n');

const FILTERS = [
  ['все', () => true],
  ['OI↓ (распродажа поз.)', (s) => s.oiChange != null && s.oiChange <= -1],
  ['OI↑ (свежие поз.)', (s) => s.oiChange != null && s.oiChange >= 1],
  ['fund в сторону хода', (s) =>
    s.funding != null && (s.side === 'SHORT' ? s.funding > 0 : s.funding < 0)],
];

for (const L of LOOKBACKS) {
  const all = byLookback.get(L);
  console.log(`── lookback ${L}m ──`);
  for (const T of THRESHOLDS) {
    const base = all.filter((s) => Math.abs(s.move) >= T);
    for (const [fname, ffn] of FILTERS) {
      row(`  |ход|≥${T}%  ${fname}`, base.filter(ffn));
    }
  }
  console.log('');
}
