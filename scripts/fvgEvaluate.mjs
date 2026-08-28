// ─────────────────────────────────────────────────────────────────────────────
//  Оценка гипотезы fvg-wide-retest-4h. Запускать РОВНО ОДИН РАЗ при n≥1500.
//  Критерии заявлены до сбора данных (registry.json → evaluation) и здесь
//  только исполняются — менять их постфактум значит выбросить весь форвард.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { loadRegistry } from '../tools/harness.mjs';

const JOURNAL = 'data/fvg-forward/trades.jsonl';
const FORCE = process.argv.includes('--force');
if (!existsSync(JOURNAL)) { console.log('журнала нет — форвард ещё не собирался'); process.exit(0); }
const trades = readFileSync(JOURNAL, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const h = loadRegistry().hypotheses.find((x) => x.id === 'fvg-wide-retest-4h');
const need = h.stopRule.n;
if (trades.length < need && !FORCE) {
  console.log(`n=${trades.length} < ${need}. Оценка ЗАПРЕЩЕНА до порога — это и есть stopRule.`);
  console.log('Если правда нужно (например, гипотеза снимается по другой причине) — --force,');
  console.log('но тогда результат в реестр как подтверждение не идёт.');
  process.exit(0);
}

// издержки пессимистичные: 0.20% RT, а не 0.10% — так заявлено в критериях
const withCost = trades.map((t) => ({ ...t, rNet: t.r - (0.20 / 100) / (t.widthPct / 100) }));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const E = mean(withCost.map((t) => t.rNet));

const byDay = new Map();
for (const t of withCost) { const d = Math.floor(t.entryT / 86400_000);
  if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
const days = [...byDay.keys()], B = 5000, means = [];
for (let b = 0; b < B; b++) { let s = 0, n = 0;
  for (let i = 0; i < days.length; i++) { const d = days[(Math.random() * days.length) | 0];
    for (const t of byDay.get(d)) { s += t.rNet; n++; } }
  means.push(s / n); }
means.sort((a, b) => a - b);
const ciLo = means[Math.floor(B * 0.025)], ciHi = means[Math.floor(B * 0.975)];

const up = withCost.filter((t) => t.btcRegime === 'btc_up'), dn = withCost.filter((t) => t.btcRegime === 'btc_down');
const eUp = up.length ? mean(up.map((t) => t.rNet)) : null;
const eDn = dn.length ? mean(dn.map((t) => t.rNet)) : null;

const c1 = E > 0;
const c2 = ciLo > 0;
const c4 = eUp != null && eDn != null ? Math.sign(eUp) === Math.sign(eDn) && eUp > 0 : null;

console.log(`n=${withCost.length} · дней=${days.length}`);
console.log(`E[R] при издержках 0.20% RT = ${E.toFixed(3)}`);
console.log(`кластерный CI95 по дням = [${ciLo.toFixed(3)}, ${ciHi.toFixed(3)}]`);
console.log(`btc_up: ${eUp?.toFixed(3) ?? '—'} (n=${up.length}) · btc_down: ${eDn?.toFixed(3) ?? '—'} (n=${dn.length})`);
console.log(`\nкритерий 1 (E>0 при 0.20%):        ${c1 ? 'ПРОЙДЕН' : 'ПРОВАЛЕН'}`);
console.log(`критерий 2 (CI не накрывает 0):    ${c2 ? 'ПРОЙДЕН' : 'ПРОВАЛЕН'}`);
console.log(`критерий 3 (лучше случайного):     считается отдельно, см. backtestFvg на форвард-окне`);
console.log(`критерий 4 (знак одинаков в обоих режимах): ${c4 == null ? 'нет данных по режимам' : c4 ? 'ПРОЙДЕН' : 'ПРОВАЛЕН'}`);
console.log(`\n${c1 && c2 && c4 ? '→ кандидат прошёл 3 из 4 автоматических условий; критерий 3 проверить вручную' : '→ ОТВЕРГНУТА. Без переформулировки и без смены порога ширины.'}`);
