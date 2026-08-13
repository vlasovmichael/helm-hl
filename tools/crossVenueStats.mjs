// ─────────────────────────────────────────────────
//  crossVenueStats — что из накопленного было ДОСТИЖИМО
// ─────────────────────────────────────────────────
// Читает data/xvenue/, накопленное crossVenueCollector.mjs, и отвечает на
// единственный вопрос, который имеет значение: сколько денег осталось бы после
// того, как из находок вычесть то, до чего ты физически не дотягиваешься.
//
// ── Почему сырой список окон врёт в твою пользу ────────────────────────────
// Коллектор пишет окно, как только валовое расхождение пробило комиссии. Но
// «окно существовало» и «ты мог в него влезть» — разные утверждения, и разница
// между ними на первом же трёхминутном прогоне (14.08) оказалась решающей:
// два самых денежных окна прожили 1 мс и 0 мс. Их в отчёте быть не должно.
//
// Три фильтра, каждый отрезает свой класс миража:
//
//   1. ЗАДЕРЖКА (--latency, по умолчанию 250 мс). Твой ордер летит до биржи и
//      обратно. Окно короче round-trip недостижимо в принципе — сколько бы
//      бп в нём ни было. 250 мс — оптимистично для домашнего канала из Варшавы
//      до серверов HL и Binance; поставь 400, чтобы увидеть честный низ.
//
//   2. РАЗМЕР (--min-usd, по умолчанию 50). Объём в строке — это то, что стоит
//      на ЛУЧШЕЙ цене. Окно на $5 не окупает даже внимания, а на депозите,
//      который делится между двумя биржами, оно ещё и недоступно.
//
//   3. СКЛЕЙКА (--cluster, по умолчанию 1000 мс). Одно расхождение рвётся на
//      несколько строк, когда net на миг ныряет под порог. Считать их как
//      независимые события — это надувать n и ломать любую статистику.
//      Окна одной монеты и стороны внутри окна склейки = одно событие.
//
// ── Чего этот инструмент НЕ делает ─────────────────────────────────────────
// Не моделирует проскальзывание глубже лучшей цены, отказы, частичные
// исполнения и риск остаться с одной ногой. Все они работают ПРОТИВ тебя,
// поэтому цифра отсюда — потолок, а не ожидание.
//
// Запуск:
//   node tools/crossVenueStats.mjs
//   node tools/crossVenueStats.mjs --latency 400 --min-usd 100

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join("data", "xvenue");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const LATENCY_MS = arg("latency", 250);
const MIN_USD = arg("min-usd", 50);
const CLUSTER_MS = arg("cluster", 1000);

if (!existsSync(DIR)) {
  console.log(`  ${DIR} пуст — сначала покрути crossVenueCollector.mjs\n`);
  process.exit(0);
}

function load(kind) {
  const rows = [];
  for (const f of readdirSync(DIR).filter((f) => f.startsWith(`xvenue-${kind}-`))) {
    for (const line of readFileSync(join(DIR, f), "utf8").split("\n")) {
      if (line.trim()) { try { rows.push(JSON.parse(line)); } catch { /* битая строка */ } }
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

const windows = load("windows");
const statRows = load("stats");

if (!windows.length && !statRows.length) {
  console.log("  Данных нет.\n");
  process.exit(0);
}

// ── Покрытие: сколько времени прибор реально смотрел ───────────────────────
// Без этого «находок ноль» нечитаемо: непонятно, рынок молчал или коллектор.
const span = statRows.length
  ? (statRows[statRows.length - 1].t - statRows[0].t) / 3_600_000
  : 0;
const samples = statRows.reduce((s, r) => s + r.n, 0);

console.log(`\n  Наблюдение: ${span.toFixed(1)} ч, ${samples.toLocaleString("ru")} срезов, ` +
  `${windows.length} сырых окон.`);
console.log(`  Фильтры: жизнь ≥ ${LATENCY_MS} мс, объём ≥ $${MIN_USD}, склейка ${CLUSTER_MS} мс.\n`);

// ── Склейка соседних окон в события ────────────────────────────────────────
const events = [];
for (const w of windows) {
  const last = events[events.length - 1];
  if (last && last.coin === w.coin && last.dir === w.dir && w.t - last.end <= CLUSTER_MS) {
    last.end = w.t + w.holdMs;
    last.holdMs = last.end - last.t;
    last.peakNetBp = Math.max(last.peakNetBp, w.peakNetBp);
    // Объём — МИНИМУМ по кускам, а не максимум. Иначе склейка берёт лучшую
    // длительность от одного момента и лучший стакан от другого: на первом же
    // прогоне (14.08) это превратило три PUMP-окна в «347 мс на $184», хотя
    // $184 стояли 1 мс, а 347 мс жило окно на $5.
    last.usd = Math.min(last.usd, w.usd);
    last.parts++;
  } else {
    events.push({ ...w, end: w.t + w.holdMs, parts: 1 });
  }
}

const reachable = events.filter((e) => e.holdMs >= LATENCY_MS && e.usd >= MIN_USD);

// ── Что отсеялось и почему — это и есть содержательная часть отчёта ────────
const tooFast = events.filter((e) => e.holdMs < LATENCY_MS).length;
const tooSmall = events.filter((e) => e.holdMs >= LATENCY_MS && e.usd < MIN_USD).length;

console.log(`  Событий после склейки: ${events.length}`);
console.log(`    отсеяно как слишком короткие (< ${LATENCY_MS} мс): ${tooFast}`);
console.log(`    отсеяно как слишком мелкие (< $${MIN_USD}):        ${tooSmall}`);
console.log(`    ДОСТИЖИМО:                                      ${reachable.length}\n`);

if (reachable.length) {
  const pnl = reachable.reduce((s, e) => s + e.usd * e.peakNetBp / 10_000, 0);
  // Экстраполяция только когда есть на чём: при одном сбросе статистики span=0,
  // и «$X за 0.0 ч» — не цифра, а деление на ноль в приличном костюме.
  if (span >= 0.5) {
    console.log(`  Потолок дохода: $${pnl.toFixed(2)} за ${span.toFixed(1)} ч ` +
      `(${(reachable.length / span).toFixed(2)} событий/ч)`);
    console.log(`  В пересчёте на сутки — не более $${(pnl / span * 24).toFixed(2)}.`);
  } else {
    console.log(`  Потолок дохода: $${pnl.toFixed(2)} за весь замер.`);
    console.log("  Наблюдение короче 30 мин — в сутки НЕ пересчитываю, это был бы шум.");
  }
  console.log("\n  Это ПОТОЛОК: проскальзывание, отказы и частичные исполнения не учтены.\n");
  console.log("  время               монета  сторона   чистыми   жило    объём");
  for (const e of reachable.slice(-25)) {
    console.log(
      `  ${new Date(e.t).toISOString().slice(5, 19).replace("T", " ")}   ` +
      `${e.coin.padEnd(7)} ${e.dir.padEnd(8)} ` +
      `${(e.peakNetBp.toFixed(1) + " бп").padStart(9)} ` +
      `${(e.holdMs + " мс").padStart(8)} ${("$" + e.usd.toFixed(0)).padStart(8)}`,
    );
  }
} else {
  console.log("  Достижимых окон нет.\n");
  console.log("  Это не «прибор сломался» — ниже видно, насколько близко подходило.\n");
}

// ── Насколько близко было: p99 расхождения против порога ───────────────────
// Отвечает на «а если бы комиссии были ниже» и заодно доказывает, что замер шёл.
const byCoin = new Map();
for (const r of statRows) {
  const a = byCoin.get(r.coin) || { n: 0, best: -1e9, p99: [], cost: r.costBp };
  a.n += r.n;
  a.best = Math.max(a.best, r.max);
  if (r.p99 != null) a.p99.push(r.p99);
  byCoin.set(r.coin, a);
}

if (byCoin.size) {
  console.log("\n  Валовое расхождение против порога издержек:\n");
  console.log("  монета     срезов   типичный p99   максимум   порог");
  const rows = [...byCoin.entries()].sort((a, b) => b[1].best - a[1].best);
  for (const [coin, a] of rows) {
    const p99 = a.p99.length
      ? a.p99.slice().sort((x, y) => x - y)[Math.floor(a.p99.length / 2)]
      : null;
    const mark = a.best > a.cost ? " ←" : "";
    console.log(
      `  ${coin.padEnd(9)} ${String(a.n).padStart(7)}   ` +
      `${String(p99 ?? "—").padStart(9)} бп ${(a.best.toFixed(1) + " бп").padStart(10)}` +
      `${(a.cost + " бп").padStart(8)}${mark}`,
    );
  }
  console.log("\n  ← = максимум пробивал издержки хотя бы раз (достижимость см. выше).\n");
}
