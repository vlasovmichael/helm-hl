// ─────────────────────────────────────────────────
//  regimeCut — разрезать накопленное по режиму рынка
// ─────────────────────────────────────────────────
// Пара к regimeIndex.mjs. Тот строит ось, этот по ней режет: adopt, hunter и
// liq-wick, каждый — на quiet / mid / active.
//
// ⚠️ ЧТО ЭТО НЕ ЕСТЬ. Это НЕ проверка гипотезы и не результат. Разрезы придуманы
// ПОСЛЕ того, как данные собраны, и никуда не предзаявлены — то есть здесь три
// сравнения на каждую стратегию, множественность не контролируется, и любой
// «выделившийся» столбец объясняется случайностью в первую очередь. Смотреть
// сюда можно только как на генератор гипотез для харнесса (tools/harness.mjs),
// где порог заявляется ДО замера.
//
// Вторая, более жёсткая оговорка: метки построены на ОДНОМ месяце. quiet/mid/
// active внутри августа 2026 — это оттенки одного макро-режима, а не разные
// режимы. Настоящий разрез станет возможен, когда рынок сменится по-крупному;
// ради этого ось и строится заранее.
//
// Запуск:  node tools/regimeCut.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REGIME_FILE = join("data", "regime", "regime.jsonl");
const HISTORY_FILE = join("data", "history_archive.json");
const LIQWICK_FILE = join("data", "liq-wick", "events.jsonl");

if (!existsSync(REGIME_FILE)) {
  console.error(`Нет ${REGIME_FILE} — сперва прогони tools/regimeIndex.mjs`);
  process.exit(1);
}

const readJsonl = (p) =>
  !existsSync(p) ? []
  : readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });

const byDay = new Map(readJsonl(REGIME_FILE).map((r) => [r.date, r]));
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const LABELS = ["quiet", "mid", "active"];

function stats(x) {
  const n = x.length;
  if (n < 2) return { n, weak: true };
  const m = x.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, m, sd, lo: m - 1.96 * se, hi: m + 1.96 * se, sum: m * n, weak: false };
}

function report(title, unit, groups) {
  console.log(`\n  ${title}`);
  for (const label of LABELS) {
    const s = stats(groups[label] || []);
    if (s.weak) { console.log(`    ${label.padEnd(7)} n=${String(s.n).padStart(3)}  — мало для оценки`); continue; }
    // Ноль внутри CI = отличить от нуля нельзя. Помечаем явно, чтобы глаз не
    // цеплялся за знак среднего — он на таких n почти всегда случаен.
    const zero = s.lo <= 0 && s.hi >= 0 ? "  ← ноль внутри CI" : "  ← ноль ВНЕ CI";
    console.log(
      `    ${label.padEnd(7)} n=${String(s.n).padStart(3)}` +
      `  среднее ${s.m.toFixed(3).padStart(7)}${unit}` +
      `  95% CI [${s.lo.toFixed(3)}, ${s.hi.toFixed(3)}]` +
      `  Σ ${s.sum.toFixed(2)}${zero}`,
    );
  }
}

function group(rows, tsOf, valOf) {
  const g = { quiet: [], mid: [], active: [] };
  for (const r of rows) {
    const reg = byDay.get(day(tsOf(r)));
    const v = valOf(r);
    if (reg && Number.isFinite(v)) g[reg.label].push(v);
  }
  return g;
}

const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, "utf8")) : [];

console.log(`\n  РАЗРЕЗ ПО РЕЖИМУ — ось из ${byDay.size} дней (${[...byDay.keys()][0]} … ${[...byDay.keys()].pop()})`);

report(
  "adopt — нянька ручных входов, $ на сделку",
  "",
  group(history.filter((t) => t.strategy_id === "adopt"), (t) => t.closed_at, (t) => t.realized_pnl),
);
report(
  "hunter PROD — $ на сделку",
  "",
  group(
    history.filter((t) => t.strategy_id === "hunter" && t.mode === "PRODUCTION"),
    (t) => t.closed_at, (t) => t.realized_pnl,
  ),
);
report(
  "liq-wick — фейд фитилей, % нетто на событие",
  "%",
  group(readJsonl(LIQWICK_FILE), (e) => e.exit_ts || e.entry_ts, (e) => e.net_pct),
);

console.log(
  `\n  ⚠️  Разрезы придуманы ПОСЛЕ сбора данных и никуда не предзаявлены. Это\n` +
  `      генератор гипотез, а не вывод: три сравнения на стратегию без поправки\n` +
  `      на множественность. И вся ось пока лежит внутри ОДНОГО макро-режима —\n` +
  `      quiet/active здесь это оттенки августа, а не разные рынки.\n`,
);
