// ─────────────────────────────────────────────────
//  baselineRun — прогон бейзлайна + самопроверка машины
// ─────────────────────────────────────────────────
// usage: BORROWED_INTERVAL=15m node tools/baselineRun.mjs <trips.json> [k]
//
// Сначала САМОПРОВЕРКА: подаём заведомо мусорные события (случайные монеты в
// случайное время). Машина обязана сказать «не отличается от случайного». Если
// на мусоре она находит эффект — она сломана, и любому её выводу грош цена.
// Без этого шага бейзлайн-машина сама становится источником ложных открытий.

import { readFileSync } from "node:fs";
import { baselineTest, formatResult, holdAndExit, rng } from "./baseline.mjs";
import { INTERVAL } from "./borrowedEntriesCandles.mjs";

const file = process.argv[2] || "data/borrowed/trips_1300a_16d.json";
const K = parseInt(process.argv[3] || "300", 10);

const { trips } = JSON.parse(readFileSync(file));

// Чужие входы как события. holdMin — их собственное время удержания: мы меряем
// ВХОД, поэтому длину сделки суррогату оставляем ту же.
const events = trips
  .map((t) => ({
    coin: t.coin,
    side: t.side,
    entryTime: t.entryTime,
    holdMin: Math.max(1, Math.round((t.exitTime - t.entryTime) / 60_000)),
  }))
  .filter((e) => e.holdMin <= 72 * 60);

console.log(`файл: ${file}`);
console.log(`интервал свечей: ${INTERVAL}, событий: ${events.length}, реплик: ${K}\n`);

// ── 1. Самопроверка на мусоре ──
console.log("═══ САМОПРОВЕРКА: мусорные события (машина обязана не найти эффект) ═══");
const rnd = rng(999);
const coins = [...new Set(events.map((e) => e.coin))];
const times = events.map((e) => e.entryTime);
const junk = events.slice(0, Math.min(3000, events.length)).map(() => ({
  coin: coins[Math.floor(rnd() * coins.length)],
  side: rnd() < 0.5 ? "long" : "short",
  entryTime: times[Math.floor(rnd() * times.length)],
  holdMin: 30 + Math.floor(rnd() * 240),
}));
for (const mode of ["time", "coin", "side"]) {
  try {
    console.log(formatResult(baselineTest(junk, { mode, k: Math.min(K, 150), seed: 4242 })));
  } catch (e) {
    console.log(`  режим «${mode}» — ошибка: ${e.message}`);
  }
}

// ── 2. Реальные чужие входы ──
console.log("\n═══ РЕАЛЬНЫЕ ЧУЖИЕ ВХОДЫ: есть ли эдж в самом входе? ═══");
for (const mode of ["time", "coin", "side"]) {
  try {
    console.log(formatResult(baselineTest(events, { mode, k: K, seed: 7 })));
  } catch (e) {
    console.log(`  режим «${mode}» — ошибка: ${e.message}`);
  }
}

// ── 3. Разрез по стороне: инверсия няньки была именно там ──
console.log("\n═══ ПО СТОРОНАМ (режим time) ═══");
for (const side of ["long", "short"]) {
  const sub = events.filter((e) => e.side === side);
  try {
    const r = baselineTest(sub, { mode: "time", k: K, seed: 7 });
    console.log(`  ${side}:`);
    console.log(formatResult(r));
  } catch (e) {
    console.log(`  ${side} — ошибка: ${e.message}`);
  }
}
