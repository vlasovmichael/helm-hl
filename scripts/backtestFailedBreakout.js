// ─────────────────────────────────────────────────────────────────────────────
//  Failed-breakout (trapped longs) SHORT backtest.
//
//  Тезис: цена пробивает локальный хай N баров, НЕ удерживается (закрывается
//  обратно под уровнем) → пробойные лонги в ловушке, их стопы = топливо вниз.
//  Шорт на закрытии trap-свечи, структурный стоп над её хаем, цель = R·риск.
//
//  Ортогонален Hunter: тот ловит магнитуду (3%/2мин), тут — структуру уровня.
//  Net of fees. First-touch в пределах горизонта; same-bar tie = стоп первым
//  (пессимистично). OOS-сплит по времени (70/30) печатается отдельно.
//
//  Запуск: node scripts/backtestFailedBreakout.js [--db candles.db]
//          [--N 20] [--stopbuf 0.1] [--tgtR 2] [--horizon 16] [--cooldown 8]
//          [--rt 0.10] [--sweep]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const DB_PATH = arg('db', 'candles.db');
const RT = parseFloat(arg('rt', '0.10')); // round-trip комиссия+слиппедж, %

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare('SELECT coin, t, o, h, l, c FROM candles ORDER BY coin, t').all();
db.close();

const byCoin = new Map();
for (const r of rows) {
  if (r.h == null || r.l == null || r.c == null) continue;
  let a = byCoin.get(r.coin);
  if (!a) byCoin.set(r.coin, (a = []));
  a.push(r);
}
let tMin = Infinity;
let tMax = -Infinity;
for (const r of rows) {
  if (r.t < tMin) tMin = r.t;
  if (r.t > tMax) tMax = r.t;
}
const splitT = tMin + (tMax - tMin) * 0.7; // 70% in-sample / 30% OOS по времени
console.error(
  `[load] ${rows.length} candles · ${byCoin.size} coins · ${((tMax - tMin) / 86400000).toFixed(1)}d · split@${new Date(splitT).toISOString().slice(0, 10)}`,
);

// ── одна конфигурация → массив сделок {t, coin, net}. side=SHORT|LONG ──
function run({ N, stopbuf, tgtR, horizon, cooldown, side = 'SHORT' }) {
  const SHORT = side === 'SHORT';
  const trades = [];
  for (const [coin, k] of byCoin) {
    let lastSig = -Infinity;
    for (let i = N; i < k.length - 1; i++) {
      if (i - lastSig < cooldown) continue;
      let priorEx = SHORT ? -Infinity : Infinity;
      for (let j = i - N; j < i; j++) {
        if (SHORT) { if (k[j].h > priorEx) priorEx = k[j].h; }
        else { if (k[j].l < priorEx) priorEx = k[j].l; }
      }
      if (!(priorEx > 0)) continue;

      // SHORT: пробой хвостом вверх + закрытие обратно под уровнем = trapped longs
      // LONG:  пробой хвостом вниз  + закрытие обратно над уровнем = trapped shorts
      if (SHORT) { if (!(k[i].h > priorEx) || !(k[i].c < priorEx)) continue; }
      else { if (!(k[i].l < priorEx) || !(k[i].c > priorEx)) continue; }

      const entry = k[i].c;
      const stopP = SHORT ? k[i].h * (1 + stopbuf / 100) : k[i].l * (1 - stopbuf / 100);
      const risk = (Math.abs(stopP - entry) / entry) * 100;
      if (!(risk > 0)) continue;
      const tgtP = SHORT ? entry - (entry - stopP) * -tgtR : entry + (entry - stopP) * -tgtR;
      // упрощённо: цель = entry ∓ |stop-entry|·tgtR
      const tgt = SHORT ? entry - Math.abs(stopP - entry) * tgtR : entry + Math.abs(stopP - entry) * tgtR;
      if (!(tgt > 0)) continue;

      let gross = null;
      const end = Math.min(i + horizon, k.length - 1);
      for (let j = i + 1; j <= end; j++) {
        const hitStop = SHORT ? k[j].h >= stopP : k[j].l <= stopP;
        const hitTgt = SHORT ? k[j].l <= tgt : k[j].h >= tgt;
        if (hitStop) { gross = -risk; break; } // same-bar tie → стоп первым (пессимизм)
        if (hitTgt) { gross = risk * tgtR; break; }
      }
      if (gross == null) {
        gross = SHORT ? ((entry - k[end].c) / entry) * 100 : ((k[end].c - entry) / entry) * 100;
      }
      lastSig = i;
      trades.push({ t: k[i].t, coin, net: gross - RT });
      void tgtP;
    }
  }
  return trades;
}

// ── Wick-rejection: большой хвост = поглощение. SHORT на верхнем хвосте ──
function runWick({ wickFrac, bodyMax, stopbuf, tgtR, horizon, cooldown, side = 'SHORT' }) {
  const SHORT = side === 'SHORT';
  const trades = [];
  for (const [coin, k] of byCoin) {
    let lastSig = -Infinity;
    for (let i = 1; i < k.length - 1; i++) {
      if (i - lastSig < cooldown) continue;
      const { o, h, l, c } = k[i];
      const range = h - l;
      if (!(range > 0)) continue;
      const body = Math.abs(c - o);
      const upWick = h - Math.max(o, c);
      const dnWick = Math.min(o, c) - l;
      const wick = SHORT ? upWick : dnWick;
      if (!(wick / range >= wickFrac)) continue;       // длинный хвост в нужную сторону
      if (!(body / range <= bodyMax)) continue;        // тело маленькое

      const entry = c;
      const stopP = SHORT ? h * (1 + stopbuf / 100) : l * (1 - stopbuf / 100);
      const risk = (Math.abs(stopP - entry) / entry) * 100;
      if (!(risk > 0)) continue;
      const tgt = SHORT ? entry - Math.abs(stopP - entry) * tgtR : entry + Math.abs(stopP - entry) * tgtR;
      if (!(tgt > 0)) continue;

      let gross = null;
      const end = Math.min(i + horizon, k.length - 1);
      for (let j = i + 1; j <= end; j++) {
        const hitStop = SHORT ? k[j].h >= stopP : k[j].l <= stopP;
        const hitTgt = SHORT ? k[j].l <= tgt : k[j].h >= tgt;
        if (hitStop) { gross = -risk; break; }
        if (hitTgt) { gross = risk * tgtR; break; }
      }
      if (gross == null) gross = SHORT ? ((entry - k[end].c) / entry) * 100 : ((k[end].c - entry) / entry) * 100;
      lastSig = i;
      trades.push({ t: k[i].t, coin, net: gross - RT });
    }
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0 };
  const nets = trades.map((x) => x.net).sort((a, b) => a - b);
  const sum = nets.reduce((s, x) => s + x, 0);
  const wins = nets.filter((x) => x > 0).length;
  return {
    n,
    wr: (wins / n) * 100,
    exp: sum / n, // expectancy на сделку, % net
    total: sum,
    median: nets[Math.floor(n / 2)],
  };
}

function report(label, trades) {
  const all = stats(trades);
  const is = stats(trades.filter((x) => x.t < splitT));
  const oos = stats(trades.filter((x) => x.t >= splitT));
  const fmt = (s) =>
    s.n === 0
      ? '   n=0'
      : `n=${String(s.n).padStart(5)} · WR ${s.wr.toFixed(1).padStart(5)}% · exp ${s.exp >= 0 ? '+' : ''}${s.exp.toFixed(3)}% · total ${s.total >= 0 ? '+' : ''}${s.total.toFixed(1)}%`;
  console.log(`\n${label}`);
  console.log(`  ALL  ${fmt(all)}`);
  console.log(`  IS   ${fmt(is)}`);
  console.log(`  OOS  ${fmt(oos)}  ← переживает вне выборки?`);
}

if (has('wick')) {
  const cfg = { wickFrac: parseFloat(arg('wickFrac', '0.5')), bodyMax: parseFloat(arg('bodyMax', '0.35')), stopbuf: 0.1, tgtR: parseFloat(arg('tgtR', '2')), horizon: parseInt(arg('horizon', '16'), 10), cooldown: 8 };
  console.log(`\nWICK cfg: wickFrac≥${cfg.wickFrac} bodyMax≤${cfg.bodyMax} tgtR=${cfg.tgtR} horizon=${cfg.horizon}bars rt=${RT}%`);
  console.log('\n--- свип wickFrac × tgtR (SHORT, exp %/сделку net) ---');
  console.log('wickFrac tgtR  n      WR%    exp%     OOS-exp%');
  for (const wf of [0.4, 0.5, 0.6]) {
    for (const tr of [1.5, 2, 3]) {
      const t = runWick({ ...cfg, wickFrac: wf, tgtR: tr });
      const a = stats(t); const o = stats(t.filter((x) => x.t >= splitT));
      if (a.n === 0) continue;
      console.log(`${String(wf).padEnd(8)} ${String(tr).padEnd(5)} ${String(a.n).padStart(5)} ${a.wr.toFixed(1).padStart(5)} ${(a.exp >= 0 ? '+' : '') + a.exp.toFixed(3)}  ${(o.exp >= 0 ? '+' : '') + o.exp.toFixed(3)}`);
    }
  }
  report('WICK-REJECTION SHORT (верхний хвост)', runWick({ ...cfg, side: 'SHORT' }));
  report('WICK-REJECTION LONG (нижний хвост) — зеркало режима', runWick({ ...cfg, side: 'LONG' }));
} else if (has('sweep')) {
  console.log('\n=== SWEEP (exp = expectancy %/сделку net, ALL) ===');
  console.log('N   stopbuf tgtR hor   n     WR%    exp%     OOS-exp%');
  for (const N of [12, 20, 40]) {
    for (const tgtR of [1.5, 2, 3]) {
      for (const horizon of [8, 16, 32]) {
        const tr = run({ N, stopbuf: 0.1, tgtR, horizon, cooldown: 8 });
        const a = stats(tr);
        const o = stats(tr.filter((x) => x.t >= splitT));
        if (a.n === 0) continue;
        console.log(
          `${String(N).padEnd(3)} ${'0.1'.padEnd(7)} ${String(tgtR).padEnd(4)} ${String(horizon).padEnd(5)} ${String(a.n).padStart(5)} ${a.wr.toFixed(1).padStart(5)} ${(a.exp >= 0 ? '+' : '') + a.exp.toFixed(3).padStart(6)}  ${(o.exp >= 0 ? '+' : '') + (o.exp ?? 0).toFixed(3)}`,
        );
      }
    }
  }
} else {
  const cfg = {
    N: parseInt(arg('N', '20'), 10),
    stopbuf: parseFloat(arg('stopbuf', '0.1')),
    tgtR: parseFloat(arg('tgtR', '2')),
    horizon: parseInt(arg('horizon', '16'), 10),
    cooldown: parseInt(arg('cooldown', '8'), 10),
  };
  console.log(`\ncfg: N=${cfg.N} stopbuf=${cfg.stopbuf}% tgtR=${cfg.tgtR} horizon=${cfg.horizon}bars cooldown=${cfg.cooldown}bars rt=${RT}%`);
  report('FAILED-BREAKOUT SHORT (trapped longs)', run({ ...cfg, side: 'SHORT' }));
  report('FAILED-BREAKDOWN LONG (trapped shorts) — зеркало для проверки режима', run({ ...cfg, side: 'LONG' }));
}
