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

initDB();
const rows = getFillCosts(0);
const s = summarizeCosts(rows);

if (!s.n) {
  console.log('строк издержек пока нет — запусти execCostBackfill.mjs');
  process.exit(0);
}

const days = (rows.at(-1).ts - rows[0].ts) / 864e5;
console.log(`\n  ── Издержки исполнения ──────────────────────────────────`);
console.log(`  филлов: ${s.n} за ${days.toFixed(0)} дн | оборот $${s.notional.toFixed(0)} | комиссий $${s.feesPaid.toFixed(2)}`);
console.log(`  доля мейкера: ${s.makerShare.toFixed(1)}%`);
console.log(`  комиссия: всего ${s.feeBpAll.toFixed(2)} бп | мейкер ${s.feeBpMaker?.toFixed(2) ?? '—'} | тейкер ${s.feeBpTaker?.toFixed(2) ?? '—'}`);

console.log(`\n  ── 1. Мейкерская доля (порог: n≥200, доля ≥40%, комиссия ≤3.5 бп) ──`);
if (s.n < 200) {
  console.log(`  ⏳ рано: ${s.n}/200 филлов`);
} else if (s.makerShare >= 40 && s.feeBpAll <= 3.5) {
  console.log(`  ✅ порог взят: ${s.makerShare.toFixed(1)}% мейкера при ${s.feeBpAll.toFixed(2)} бп`);
} else {
  console.log(`  ❌ не взят: ${s.makerShare.toFixed(1)}% мейкера при ${s.feeBpAll.toFixed(2)} бп`);
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
  const cheap = s.hours.cheap.reduce((a, h) => a + h.feeBp, 0) / s.hours.cheap.length;
  const dear = s.hours.dear.reduce((a, h) => a + h.feeBp, 0) / s.hours.dear.length;
  console.log(`  дешёвые часы UTC ${s.hours.cheap.map((h) => h.hour).join(',')} → ${cheap.toFixed(2)} бп`);
  console.log(`  дорогие часы UTC ${s.hours.dear.map((h) => h.hour).join(',')} → ${dear.toFixed(2)} бп`);
  console.log(`  разница ${(dear - cheap).toFixed(2)} бп`);
}

console.log(`\n  ── 4. Задержка «пуш → сделка» (порог: n≥40) ──`);
if (s.alertLag.n < 40) {
  console.log(`  ⏳ рано: ${s.alertLag.n}/40 сделок с пушем по той же монете`);
} else {
  console.log(`  медиана ${(s.alertLag.medianSec / 60).toFixed(1)} мин (n=${s.alertLag.n})`);
}
console.log('');
