// ─────────────────────────────────────────────────────────────────────────────
//  MTF-alignment: "входи только когда 15m И 1h согласны с 4h".
//  Правило берётся ровно из боевого chartCoach: EMA fast/slow + положение цены
//  (trendFromEma, sep 0.15%). 15m OHLC из candles.db агрегируются в 1h и 4h.
//
//  Что меряем: даёт ли фильтр преимущество ПРОТИВ БЕЙЗЛАЙНА (те же входы без
//  фильтра), а не "сколько он заработал". Плюс OOS-сплит и разбивка по режиму
//  BTC — урок няньки: трендовый фильтр умеет маскировать бету под эдж.
//
//  Запуск: node scripts/backtestMtfAlign.js [--rt 0.10] [--rr 1.5] [--atr 1.5]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const RT   = parseFloat(arg('rt', '0.10'));   // round-trip издержки, %
const RR   = parseFloat(arg('rr', '1.5'));    // цель = RR × стоп
const ATRK = parseFloat(arg('atr', '1.5'));   // стоп = ATRK × ATR14(15m)
const MAXH = parseInt(arg('maxh', '32'), 10); // таймаут, 15m баров (8ч)

const H1 = 3600_000, H4 = 4 * H1;

// ── индикаторы (копия боевой логики chartCoach) ──
function emaSeries(v, p) {
  if (!v.length) return [];
  const k = 2 / (p + 1); const out = [v[0]];
  for (let i = 1; i < v.length; i++) out.push(v[i] * k + out[i - 1] * (1 - k));
  return out;
}
/** 'up'|'down'|'flat' по EMA fast/slow + положению цены (chartCoach:50). */
function trendAt(fastS, slowS, i, price) {
  const f = fastS[i], s = slowS[i];
  if (f == null || s == null) return 'flat';
  const sep = ((f - s) / s) * 100;
  if (sep > 0.15 && price >= s) return 'up';
  if (sep < -0.15 && price <= s) return 'down';
  return 'flat';
}
function atr14(bars, i) {
  if (i < 14) return null;
  let sum = 0;
  for (let j = i - 13; j <= i; j++) {
    const pc = bars[j - 1]?.c ?? bars[j].o;
    sum += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - pc), Math.abs(bars[j].l - pc));
  }
  return sum / 14;
}
/** 15m → HTF. Возвращает {bars, idxFor} — idxFor[i] = индекс ПОСЛЕДНЕГО ЗАКРЫТОГО HTF-бара. */
function aggregate(bars, span) {
  const htf = []; const idxFor = new Array(bars.length).fill(-1);
  let cur = null, curKey = null;
  for (let i = 0; i < bars.length; i++) {
    const key = Math.floor(bars[i].t / span);
    if (key !== curKey) {
      if (cur) htf.push(cur);
      curKey = key; cur = { t: key * span, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c };
    } else {
      cur.h = Math.max(cur.h, bars[i].h); cur.l = Math.min(cur.l, bars[i].l); cur.c = bars[i].c;
    }
    // на закрытии 15m бара i доступны только HTF-бары, ЗАКРЫВШИЕСЯ строго раньше
    idxFor[i] = htf.length - 1;
  }
  if (cur) htf.push(cur);
  return { bars: htf, idxFor };
}

// ── загрузка ──
const db = new Database('candles.db', { readonly: true });
const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles ORDER BY coin,t').all();
db.close();
const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }

// режим BTC: знак изменения BTC за предыдущие 24ч, на каждый 15m таймстамп
const btc = byCoin.get('BTC') || [];
const btcAt = new Map(btc.map((b) => [b.t, b.c]));
const btcRegime = (t) => {
  const now = btcAt.get(t), then = btcAt.get(t - 24 * H1);
  if (now == null || then == null) return null;
  return now > then ? 'btc_up' : 'btc_down';
};

// ── генерация сделок ──
// mode 'aligned' — правило оператора; 'all' — бейзлайн: те же бары, сторона по 4h,
// но БЕЗ требования согласия 1h/15m (т.е. фильтр выключен).
function run(mode) {
  const trades = [];
  for (const [coin, bars] of byCoin) {
    if (bars.length < 300) continue;
    const c15 = bars.map((b) => b.c);
    const f15 = emaSeries(c15, 20), s15 = emaSeries(c15, 50);
    const a1 = aggregate(bars, H1), a4 = aggregate(bars, H4);
    const c1 = a1.bars.map((b) => b.c), c4 = a4.bars.map((b) => b.c);
    const f1 = emaSeries(c1, 20), s1 = emaSeries(c1, 50);
    const f4 = emaSeries(c4, 20), s4 = emaSeries(c4, 50);

    let cooldownUntil = -1;
    for (let i = 60; i < bars.length - 1; i++) {
      if (i <= cooldownUntil) continue;
      const i1 = a1.idxFor[i], i4 = a4.idxFor[i];
      if (i1 < 50 || i4 < 50) continue;              // хватает баров на EMA50
      const px = bars[i].c;
      const t4 = trendAt(f4, s4, i4, px);
      if (t4 === 'flat') continue;                    // направления нет — 4h правит
      if (mode === 'aligned') {
        const t1 = trendAt(f1, s1, i1, px);
        const t15 = trendAt(f15, s15, i, px);
        if (t1 !== t4 || t15 !== t4) continue;        // ← ФИЛЬТР ЮЗЕРА
      }
      const a = atr14(bars, i);
      if (!(a > 0)) continue;
      const side = t4 === 'up' ? 'LONG' : 'SHORT';
      const stopD = ATRK * a, tgtD = stopD * RR;
      const entry = px;
      const stop = side === 'LONG' ? entry - stopD : entry + stopD;
      const tgt  = side === 'LONG' ? entry + tgtD  : entry - tgtD;

      // first-touch по high/low следующих баров; при неоднозначности бара — стоп
      let r = null;
      for (let j = i + 1; j <= Math.min(i + MAXH, bars.length - 1); j++) {
        const hitStop = side === 'LONG' ? bars[j].l <= stop : bars[j].h >= stop;
        const hitTgt  = side === 'LONG' ? bars[j].h >= tgt  : bars[j].l <= tgt;
        if (hitStop) { r = -1; break; }               // пессимистично: стоп раньше
        if (hitTgt)  { r = RR; break; }
      }
      if (r == null) {                                 // таймаут — по close
        const last = bars[Math.min(i + MAXH, bars.length - 1)].c;
        r = ((side === 'LONG' ? last - entry : entry - last) / stopD);
      }
      const costR = (RT / 100) * entry / stopD;         // издержки в единицах R
      trades.push({ coin, t: bars[i].t, side, r, rNet: r - costR, regime: btcRegime(bars[i].t) });
      cooldownUntil = i + 8;                           // 2ч, чтобы не считать один ход 8 раз
    }
  }
  return trades;
}

// ── статистика с CI ──
function stats(tr, key = 'rNet') {
  const n = tr.length;
  if (!n) return { n: 0 };
  const rs = tr.map((x) => x[key]);
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const wins = rs.filter((x) => x > 0).length;
  const wr = wins / n;
  const wrSe = Math.sqrt(wr * (1 - wr) / n);
  return {
    n, mean, ciLo: mean - 1.96 * se, ciHi: mean + 1.96 * se,
    wr, wrLo: wr - 1.96 * wrSe, wrHi: wr + 1.96 * wrSe, sum: mean * n,
  };
}
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
function line(label, s) {
  if (!s.n) return console.log(`${label.padEnd(26)} n=0`);
  console.log(
    `${label.padEnd(26)} n=${String(s.n).padStart(6)}  ` +
    `E[R]=${f(s.mean).padStart(7)}  CI95[${f(s.ciLo)}, ${f(s.ciHi)}]  ` +
    `WR=${(s.wr * 100).toFixed(1)}%  сумма=${f(s.sum, 1)}R`,
  );
}

const tMin = rows.reduce((m, r) => Math.min(m, r.t), Infinity);
const tMax = rows.reduce((m, r) => Math.max(m, r.t), -Infinity);
console.log(`[данные] ${rows.length} свечей 15m · ${byCoin.size} монет · ` +
  `${new Date(tMin).toISOString().slice(0,10)} → ${new Date(tMax).toISOString().slice(0,10)}`);
console.log(`[параметры] стоп=${ATRK}×ATR14 · цель=${RR}R · таймаут=${MAXH}бар(${MAXH/4}ч) · издержки=${RT}% RT\n`);

const aligned = run('aligned');
const base    = run('all');

console.log('═══ 1. ФИЛЬТР ПРОТИВ БЕЙЗЛАЙНА (после издержек) ═══');
line('правило 15m+1h+4h', stats(aligned));
line('бейзлайн: только 4h', stats(base));
const dm = stats(aligned).mean - stats(base).mean;
console.log(`\nразница E[R]: ${f(dm)} — фильтр ${dm > 0 ? 'лучше' : 'ХУЖЕ'} бейзлайна\n`);

console.log('═══ 2. БЕЗ ИЗДЕРЖЕК (сколько съедает комиссия) ═══');
line('правило, gross', stats(aligned, 'r'));
line('бейзлайн, gross', stats(base, 'r'));

console.log('\n═══ 3. OOS-СПЛИТ (половина / половина) ═══');
const mid = (tMin + tMax) / 2;
line('правило · 1-я половина', stats(aligned.filter((t) => t.t < mid)));
line('правило · 2-я половина', stats(aligned.filter((t) => t.t >= mid)));

console.log('\n═══ 4. РЕЖИМ BTC (эдж или бета?) ═══');
for (const rg of ['btc_up', 'btc_down']) {
  line(`правило · ${rg}`, stats(aligned.filter((t) => t.regime === rg)));
}
for (const rg of ['btc_up', 'btc_down']) {
  line(`  из них LONG · ${rg}`, stats(aligned.filter((t) => t.regime === rg && t.side === 'LONG')));
  line(`  из них SHORT · ${rg}`, stats(aligned.filter((t) => t.regime === rg && t.side === 'SHORT')));
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. ЧЕСТНЫЙ CI: кластерный бутстрап по ДНЯМ.
//  Наивный CI выше считает 29k сделок независимыми. Они не независимы: 178
//  альтов в один день ходят вместе. Ресемплим ДНИ целиком — это даёт CI,
//  отражающий число независимых эпизодов, а не число строк.
// ─────────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--boot')) {
  const dayOf = (t) => Math.floor(t / 86400_000);
  const byDay = new Map();
  for (const t of aligned) { const d = dayOf(t.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
  const days = [...byDay.keys()];
  const B = 2000, means = [];
  for (let b = 0; b < B; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[(Math.random() * days.length) | 0];
      for (const tr of byDay.get(d)) { sum += tr.rNet; n++; }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const pt = stats(aligned).mean;
  console.log(`\n═══ 5. КЛАСТЕРНЫЙ БУТСТРАП ПО ДНЯМ (${days.length} дней, B=${B}) ═══`);
  console.log(`E[R] = ${f(pt)}   CI95 кластерный = [${f(means[Math.floor(B*0.025)])}, ${f(means[Math.floor(B*0.975)])}]`);
  console.log(`доля бутстрап-выборок с E[R] > 0: ${(means.filter(m=>m>0).length/B*100).toFixed(1)}%`);
  const naive = stats(aligned);
  console.log(`(наивный CI был [${f(naive.ciLo)}, ${f(naive.ciHi)}] — шире в ${((means[Math.floor(B*0.975)]-means[Math.floor(B*0.025)])/(naive.ciHi-naive.ciLo)).toFixed(1)}× раз)`);
}
