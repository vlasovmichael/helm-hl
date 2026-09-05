// ─────────────────────────────────────────────────────────────────────────────
//  execCostStats — издержки исполнения: мейкер, проскальзывание, стоимость часа
//
//  Пороги заданы ЗДЕСЬ и совпадают с реестром гипотез: иначе через месяц они
//  придумаются заново под то, что получилось.
//
//    exec-maker-share-n200   мейкерских филлов ≥40% И средняя комиссия ≤3.5 бп
//    exec-stop-slippage-n60  медиана проскальзывания триггера; >5 бп = чиним
//    exec-hour-cost-n400     разница дешёвого и дорогого терциля часов
//
//  Запуск: docker exec hl-paper-scanner node tools/execCostStats.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { initDB, getFillCosts } from '../src/core/database.js';
import { summarizeCosts } from '../src/modules/execCosts.js';
import { rng } from './baseline.mjs';

initDB();
const rows = getFillCosts(0);
const s = summarizeCosts(rows);

// 🚨 Момент включения post-only. До него всё, что накоплено, — это БАЗА «до», и
// печатать по ней вердикт нельзя: гипотеза про изменение, которого ещё не было.
const SINCE = Date.parse(process.env.EXEC_POSTONLY_SINCE || '');
const after = Number.isFinite(SINCE) ? rows.filter((r) => r.ts >= SINCE) : [];

/** Кластерный бутстрап по монетам: филлы одной монеты не независимы. */
function clusteredDiffCi(rows_, pick, iters = 5000) {
  const byCoin = new Map();
  for (const r of rows_) {
    if (!byCoin.has(r.coin)) byCoin.set(r.coin, []);
    byCoin.get(r.coin).push(r);
  }
  const coins = [...byCoin.values()];
  if (coins.length < 5) return null;
  const rand = rng(12345);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const sample = [];
    for (let k = 0; k < coins.length; k++) sample.push(...coins[Math.floor(rand() * coins.length)]);
    const d = pick(sample);
    if (Number.isFinite(d)) out.push(d);
  }
  if (out.length < iters / 2) return null;
  out.sort((a, b) => a - b);
  return { lo: out[Math.floor(out.length * 0.025)], hi: out[Math.floor(out.length * 0.975)] };
}

if (!s.n) {
  console.log('строк издержек пока нет — запусти execCostBackfill.mjs');
  process.exit(0);
}

const days = (rows.at(-1).ts - rows[0].ts) / 864e5;
console.log(`\n  ── Издержки исполнения ──────────────────────────────────`);
console.log(`  филлов: ${s.n} за ${days.toFixed(0)} дн | оборот $${s.notional.toFixed(0)} | комиссий $${s.feesPaid.toFixed(2)}`);
console.log(`  доля мейкера: ${s.makerShare.toFixed(1)}%`);
console.log(`  комиссия: всего ${s.feeBpAll.toFixed(2)} бп | мейкер ${s.feeBpMaker?.toFixed(2) ?? '—'} | тейкер ${s.feeBpTaker?.toFixed(2) ?? '—'}`);

console.log(`\n  ── 1. Мейкерская доля (порог: n≥200 ПОСЛЕ включения post-only) ──`);
if (!Number.isFinite(SINCE)) {
  console.log(`  ⏸  база «до» набрана (${s.n} филлов, ${s.makerShare.toFixed(1)}% мейкера, ${s.feeBpAll.toFixed(2)} бп).`);
  console.log(`     Вердикта нет и быть не может: post-only ещё не включён.`);
  console.log(`     Включив, выставь EXEC_POSTONLY_SINCE=<ISO-дата> — счёт пойдёт с неё.`);
} else {
  const a = summarizeCosts(after);
  if (a.n < 200) {
    console.log(`  ⏳ рано: ${a.n}/200 филлов после включения`);
  } else if (a.makerShare >= 40 && a.feeBpAll <= 3.5) {
    console.log(`  ✅ порог взят: ${a.makerShare.toFixed(1)}% мейкера при ${a.feeBpAll.toFixed(2)} бп`);
  } else {
    console.log(`  ❌ не взят: ${a.makerShare.toFixed(1)}% мейкера при ${a.feeBpAll.toFixed(2)} бп`);
  }
}

console.log(`\n  ── 2. Проскальзывание триггера (порог: n≥60 стопов) ──`);
if (s.slip.n < 60) {
  console.log(`  ⏳ рано: ${s.slip.n}/60 закрытий с известным плановым стопом`);
} else {
  const verdict = s.slip.median > 5 ? '🔧 чиним: переходим на stop-limit' : '✅ терпимо';
  console.log(`  медиана ${s.slip.median.toFixed(2)} бп, среднее ${s.slip.mean.toFixed(2)} бп (n=${s.slip.n}) → ${verdict}`);
}

console.log(`\n  ── 3. Стоимость часа (порог: n≥400 филлов, ≥8 часов с данными) ──`);
if (s.n < 400 || s.hours.counted < 8) {
  console.log(`  ⏳ рано: ${s.n}/400 филлов, часов с данными ${s.hours.counted}/8`);
} else {
  const cheapH = new Set(s.hours.cheap.map((h) => h.hour));
  const dearH = new Set(s.hours.dear.map((h) => h.hour));
  const diffOf = (set) => {
    const c = set.filter((r) => cheapH.has(r.hour_utc)).map((r) => r.fee_bp);
    const d = set.filter((r) => dearH.has(r.hour_utc)).map((r) => r.fee_bp);
    if (!c.length || !d.length) return NaN;
    const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return m(d) - m(c);
  };
  const diff = diffOf(rows);
  const ci = clusteredDiffCi(rows, diffOf);
  console.log(`  дешёвые часы UTC ${[...cheapH].join(',')} | дорогие UTC ${[...dearH].join(',')}`);
  // 🚨 Разница без интервала на витрину не идёт: терцили выбраны по этим же
  // данным, и голое число здесь заведомо льстит.
  if (!ci) {
    console.log(`  разница ${diff.toFixed(2)} бп — CI не посчитан (мало монет), вердикта нет`);
  } else {
    const passes = diff >= 1.5 && ci.lo > 0;
    console.log(`  разница ${diff.toFixed(2)} бп, 95% CI по монетам [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`);
    console.log(`  ${passes ? '✅ порог взят (≥1.5 бп и CI выше нуля)' : '❌ не взят: нужно ≥1.5 бп и CI выше нуля'}`);
  }
}

console.log(`\n  ── 4. Задержка «пуш → сделка» (порог: n≥40) ──`);
if (s.alertLag.n < 40) {
  console.log(`  ⏳ рано: ${s.alertLag.n}/40 сделок с пушем по той же монете`);
} else {
  console.log(`  медиана ${(s.alertLag.medianSec / 60).toFixed(1)} мин (n=${s.alertLag.n})`);
}
console.log('');
