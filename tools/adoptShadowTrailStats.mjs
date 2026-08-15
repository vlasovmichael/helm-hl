// ─────────────────────────────────────────────────
//  adoptShadowTrailStats — чтение теневого трейла (гипотеза adopt-trail-025r)
// ─────────────────────────────────────────────────
// Порог решения задан ЗДЕСЬ и совпадает с реестром гипотез, потому что иначе
// через полтора месяца порог придумается заново — под то, что получилось.
//
//   n ≥ 60 пар, парная разница (0.25R − текущий трейл) > 0,
//   95% ДИ парного бутстрапа не накрывает ноль.
//
// Не выполнено — гипотеза снята, конфиг остаётся как есть. Подглядывать до
// n=60 реестром запрещено: скрипт до этого печатает только счётчик, без разницы
// средних и без ДИ. Это не формальность — увидев «пока +0.3пп», потом уже нельзя
// честно сказать, что решение принято по правилу.
//
// Запуск:
//   ssh oracle "docker exec hl-paper-scanner node tools/adoptShadowTrailStats.mjs"
//   node tools/adoptShadowTrailStats.mjs --peek   # осознанно нарушить, для отладки

import Database from "better-sqlite3";
import { rng } from "./baseline.mjs";

const N_REQUIRED = 60;
const PEEK = process.argv.includes("--peek");
const DB_PATH = process.env.DB_PATH || "data/trades.db";
const BOOTSTRAP = 10_000;

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT coin, side, closed_at, notional_usd, actual_pct, td_pct, td_fired, td_min,
            ch_pct, ch_fired, ch_min
       FROM shadow_exits
      WHERE strategy_id = 'adopt_trail'
      ORDER BY closed_at`,
  )
  .all();

console.log("\n  ── Теневой трейл adopt: 0.25R против текущего ────────────");
console.log(`  Пар накоплено: ${rows.length} / ${N_REQUIRED}`);

if (!rows.length) {
  console.log("\n  Замер поднят, но ни одна adopt-позиция ещё не закрылась.");
  console.log("  Позиции без resting-SL в замер не попадают (без R модель не определена).\n");
  process.exit(0);
}

// Самопроверка модели: симуляция текущего трейла должна совпадать с фактом на
// сделках, где реальный выход тоже был по трейлу. Расходится систематически —
// значит модель врёт, и разницу td−ch читать нельзя ни при каком n.
const bothFired = rows.filter((r) => r.ch_fired === 1);
if (bothFired.length >= 5) {
  const gap = bothFired.map((r) => r.ch_pct - r.actual_pct);
  const med = [...gap].sort((a, b) => a - b)[Math.floor(gap.length / 2)];
  console.log(
    `  Самопроверка: симуляция текущего трейла vs факт — медиана расхождения ` +
      `${med >= 0 ? "+" : ""}${med.toFixed(3)}пп (n=${bothFired.length})`,
  );
  if (Math.abs(med) > 0.2) {
    console.log("  ⚠️ Расхождение крупное: модель не воспроизводит реальный выход.");
    console.log("     Сравнение 0.25R с ней читать нельзя, пока это не объяснено.");
  }
}

const fired = rows.filter((r) => r.td_fired === 1).length;
console.log(`  0.25R срабатывал: ${fired} раз, текущий: ${rows.filter((r) => r.ch_fired === 1).length}`);

if (rows.length < N_REQUIRED && !PEEK) {
  console.log(
    `\n  Порог не набран. Разница средних и ДИ НЕ печатаются: подглядывание\n` +
      `  до n=${N_REQUIRED} запрещено реестром гипотез. Осталось ${N_REQUIRED - rows.length} пар.\n`,
  );
  process.exit(0);
}
if (rows.length < N_REQUIRED) console.log("\n  ⚠️ --peek: n ниже порога, решение по этим числам принимать НЕЛЬЗЯ.");

// ── Парный бутстрап ───────────────────────────────────────────────────────
const diffs = rows.map((r) => r.td_pct - r.ch_pct);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const obs = mean(diffs);
const rand = rng(20260815);
const boot = new Array(BOOTSTRAP);
for (let b = 0; b < BOOTSTRAP; b++) {
  let s = 0;
  for (let i = 0; i < diffs.length; i++) s += diffs[(rand() * diffs.length) | 0];
  boot[b] = s / diffs.length;
}
boot.sort((a, b) => a - b);
const lo = boot[Math.floor(BOOTSTRAP * 0.025)];
const hi = boot[Math.floor(BOOTSTRAP * 0.975)];

const usd = (key) => rows.reduce((s, r) => s + (r[key] / 100) * (r.notional_usd || 0), 0);
console.log(`\n  Средний % на сделку:`);
console.log(`    0.25R          ${mean(rows.map((r) => r.td_pct)).toFixed(3)}%   (в деньгах $${usd("td_pct").toFixed(2)})`);
console.log(`    текущий трейл  ${mean(rows.map((r) => r.ch_pct)).toFixed(3)}%   (в деньгах $${usd("ch_pct").toFixed(2)})`);
console.log(`    факт           ${mean(rows.map((r) => r.actual_pct)).toFixed(3)}%   (в деньгах $${usd("actual_pct").toFixed(2)})`);
console.log(
  `\n  Парная разница (0.25R − текущий): ${obs >= 0 ? "+" : ""}${obs.toFixed(3)}пп ` +
    `[${lo >= 0 ? "+" : ""}${lo.toFixed(3)} … ${hi >= 0 ? "+" : ""}${hi.toFixed(3)}]`,
);

console.log("\n  ── Решение по объявленному правилу ──────────────────────");
if (rows.length < N_REQUIRED) {
  console.log("  n ниже порога — решение НЕ принимается.");
} else if (obs > 0 && lo > 0) {
  console.log("  ✅ Гипотеза подтверждена на форварде: 0.25R бьёт текущий трейл.");
  console.log("     Следующий шаг — не включать сразу, а прогнать вторую половину");
  console.log("     на новом режиме рынка (запрет «подтверждено» на одном режиме).");
} else {
  console.log("  ❌ Не подтверждено: ДИ накрывает ноль либо разница отрицательна.");
  console.log("     Гипотеза снята, конфиг трейла остаётся как есть.");
}
console.log("");
