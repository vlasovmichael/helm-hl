// ─────────────────────────────────────────────────────────────────────────────
//  Forward-edge backtest для карточки Hot Movers.
//
//  Гоняет поминутную историю HL (hl_snapshot.db от hl-collector) через БОЕВУЮ
//  логику карточки (evaluateSetup из src/modules/hotMoversSetup.js) и меряет, что
//  происходило ПОСЛЕ каждого actionable-вердикта: forward-доходность 30/60 мин,
//  win-rate, и first-touch ±target. Net of fees.
//
//  Цель: ответить фактом — есть ли эдж у continuation (trend) vs fade, и в какую
//  сторону. НЕ меняет прод-карточку. Только числа.
//
//  Запуск:  node scripts/backtestForward.js [--db hl_snapshot.db] [--step 300]
//           [--rt 0.10] [--tgt 1.0] [--stop 1.0] [--minScore 3] [--cooldown 1800]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import {
  buildCoinFeatures,
  evaluateSetup,
  computeBreadthFlush,
  deriveAccelKind,
  classifyChase,
  ENTRY_MIN_SCORE,
} from '../src/modules/hotMoversSetup.js';

// ── args ─────────────────────────────────────────────────────────────────────
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DB_PATH = arg('db', 'hl_snapshot.db');
const STEP = parseInt(arg('step', '300'), 10); // шаг перебора eval-точек, сек
const RT = parseFloat(arg('rt', '0.10')); // round-trip cost, % (taker+slippage)
const TGT = parseFloat(arg('tgt', '1.0')); // first-touch target, %
const STOP = parseFloat(arg('stop', '1.0')); // first-touch stop, %
const MIN_SCORE = parseFloat(arg('minScore', String(ENTRY_MIN_SCORE)));
const COOLDOWN = parseInt(arg('cooldown', '1800'), 10); // анти-overlap на coin+side, сек
const TOL = 90; // допуск на поиск сэмпла по ts, сек
const HORIZONS = [1800, 3600]; // 30м, 60м

// ── load ─────────────────────────────────────────────────────────────────────
console.log(`[load] ${DB_PATH} …`);
const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare('SELECT ts, coin, mark, oi FROM samples ORDER BY ts').all();
db.close();

// per-coin: Map<ts,{mark,oi}> для O(1)-доступа + отсортированный массив ts
const byCoin = new Map();
const tsSet = new Set();
for (const r of rows) {
  if (r.mark == null) continue;
  let c = byCoin.get(r.coin);
  if (!c) byCoin.set(r.coin, (c = { map: new Map(), ts: [] }));
  c.map.set(r.ts, { mark: r.mark, oi: r.oi });
  c.ts.push(r.ts);
  tsSet.add(r.ts);
}
const allTs = [...tsSet].sort((a, b) => a - b);
const tMin = allTs[0];
const tMax = allTs[allTs.length - 1];
console.log(
  `[load] ${rows.length} rows · ${byCoin.size} coins · ` +
    `${new Date(tMin * 1000).toISOString().slice(0, 16)} → ` +
    `${new Date(tMax * 1000).toISOString().slice(0, 16)} (${((tMax - tMin) / 86400).toFixed(1)}d)`,
);

// поиск сэмпла монеты на момент ts (точно, иначе ближайший в пределах TOL)
function sampleAt(coin, ts) {
  const c = byCoin.get(coin);
  if (!c) return null;
  const hit = c.map.get(ts);
  if (hit) return hit;
  for (let d = 60; d <= TOL; d += 60) {
    const a = c.map.get(ts + d);
    if (a) return a;
    const b = c.map.get(ts - d);
    if (b) return b;
  }
  return null;
}
const priceAt = (coin, ts) => sampleAt(coin, ts)?.mark ?? null;
const priceNMinAgo = (coin, mins, now) => priceAt(coin, now - mins * 60);
const oiNMinAgo = (coin, mins, now) => sampleAt(coin, now - mins * 60)?.oi ?? null;
const deps = { priceNMinAgo, oiNMinAgo };

// htfTrend-прокси: знак 60m-окна с deadband (боевой код мьютит fade по 1h-тренду)
function htfFromWindows(windows) {
  const w60 = windows.find((w) => w.mins === 60);
  if (!w60 || w60.spikePct == null) return 'none';
  if (w60.spikePct > 0.3) return 'up';
  if (w60.spikePct < -0.3) return 'down';
  return 'none';
}

// ── replay ───────────────────────────────────────────────────────────────────
const signals = [];
const lastFire = new Map(); // coin|side -> ts (cooldown)
const coins = [...byCoin.keys()];
let evals = 0;

for (let ts = tMin; ts <= tMax; ts += STEP) {
  // фичи для всех монет с сэмплом на этот тик
  const featRows = [];
  for (const coin of coins) {
    const s = byCoin.get(coin).map.get(ts);
    if (!s) continue;
    const item = { coin, price: s.mark, oiUsd: s.oi };
    const feats = buildCoinFeatures(item, ts, deps);
    featRows.push({ coin, mark: s.mark, feats });
  }
  if (!featRows.length) continue;
  evals++;

  const flush = computeBreadthFlush(
    featRows.map((r) => ({
      windows: r.feats.windows,
      oiDelta5m: r.feats.oiDelta5m,
      oiDelta15m: r.feats.oiDelta15m,
    })),
  );

  for (const r of featRows) {
    const w2 = r.feats.windows.find((w) => w.mins === 2);
    const w5 = r.feats.windows.find((w) => w.mins === 5);
    const accelKind = deriveAccelKind(w2, w5);
    const htf = htfFromWindows(r.feats.windows);
    const setup = evaluateSetup(
      r.feats.windows,
      { oiDelta5m: r.feats.oiDelta5m, oiDelta15m: r.feats.oiDelta15m },
      flush,
      accelKind,
      htf,
    );
    if (!setup.mode || setup.score < MIN_SCORE) continue; // только actionable
    const chase = classifyChase(r.feats.windows, setup.side, setup.score);

    const key = `${r.coin}|${setup.side}`;
    const prev = lastFire.get(key);
    if (prev != null && ts - prev < COOLDOWN) continue; // анти-overlap
    lastFire.set(key, ts);

    signals.push({
      ts,
      coin: r.coin,
      side: setup.side,
      mode: setup.mode,
      score: setup.score,
      chase: chase.state,
      entry: r.mark,
    });
  }
}
console.log(`[replay] ${evals} eval-точек · ${signals.length} actionable-сигналов\n`);

// ── outcomes ─────────────────────────────────────────────────────────────────
const signed = (side, entry, fut) =>
  side === 'LONG' ? ((fut - entry) / entry) * 100 : ((entry - fut) / entry) * 100;

for (const sg of signals) {
  // forward-доходность на горизонтах
  sg.ret = {};
  for (const h of HORIZONS) {
    const fut = priceAt(sg.coin, sg.ts + h);
    sg.ret[h] = fut == null ? null : signed(sg.side, sg.entry, fut);
  }
  // first-touch ±TGT/STOP в пределах max-горизонта
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

// ── aggregate ────────────────────────────────────────────────────────────────
function agg(list) {
  const out = {};
  for (const h of HORIZONS) {
    const r = list.map((s) => s.ret[h]).filter((x) => x != null);
    const net = r.map((x) => x - RT);
    out[h] = {
      n: r.length,
      meanNet: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
      win: net.length ? net.filter((x) => x > 0).length / net.length : null,
    };
  }
  const ft = list.filter((s) => s.touch != null);
  const tgt = ft.filter((s) => s.touch === 'tgt').length;
  out.touch = { n: ft.length, tgtRate: ft.length ? tgt / ft.length : null };
  return out;
}

const pct = (x) => (x == null ? '  —  ' : `${(x * 100).toFixed(0)}%`.padStart(5));
const ret = (x) => (x == null ? '   —   ' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}%`.padStart(8));

function printBucket(label, list) {
  if (!list.length) return;
  const a = agg(list);
  const h30 = a[1800];
  const h60 = a[3600];
  console.log(
    `${label.padEnd(22)} n=${String(list.length).padStart(4)}  ` +
      `30m: net ${ret(h30.meanNet)} win ${pct(h30.win)}  │  ` +
      `60m: net ${ret(h60.meanNet)} win ${pct(h60.win)}  │  ` +
      `touch +${TGT}/-${STOP}: ${pct(a.touch.tgtRate)} (n=${a.touch.n})`,
  );
}

const buckets = new Map();
for (const s of signals) {
  const k = `${s.mode} ${s.side}`;
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(s);
}

console.log(
  `═══ Forward-edge · RT=${RT}% · target/stop ±${TGT}/${STOP}% · cooldown ${COOLDOWN / 60}m ═══`,
);
console.log('(net = после round-trip комиссии; win = доля net>0; touch = target раньше стопа)\n');

console.log('── По режиму+стороне (все actionable) ──');
for (const k of [...buckets.keys()].sort()) printBucket(k, buckets.get(k));

console.log('\n── Только chase=zone (как реально алертит карточка) ──');
for (const k of [...buckets.keys()].sort()) {
  printBucket(k + ' [zone]', buckets.get(k).filter((s) => s.chase === 'zone'));
}

console.log('\n── Свод по режиму ──');
for (const mode of ['trend', 'fade']) {
  printBucket(mode.toUpperCase() + ' (all)', signals.filter((s) => s.mode === mode));
}
printBucket('ВСЁ', signals);
