// ─────────────────────────────────────────────────
//  externalCalls — базрейт чужих прогнозов вместо ощущения «он дело говорит»
// ─────────────────────────────────────────────────
// docs/external-calls-log.md держит журнал глазами; здесь он же в машинном
// виде, чтобы исход считался сам, а не «когда вспомню проверить». Забывание
// тут не нейтрально: невспомненные прогнозы — это в основном НЕ СБЫВШИЕСЯ,
// потому что сбывшиеся автор напомнит сам. Ручная сверка систематически
// завышает базрейт источника.
//
// Правило записи (из журнала): прогноз засчитывается, только если у него есть
// число и срок. «Крупный капитал набирает» не идёт — под него подходит любой
// исход, и такой источник нельзя ни подтвердить, ни опровергнуть.
//
// Запуск:
//   node tools/externalCalls.mjs                 # статус + базрейты
//   node tools/externalCalls.mjs --add '<json>'  # добавить прогноз
//
// Формат прогноза:
//   { source, coin, direction: "above"|"below", target, statedAt, deadline, note }

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const DIR = join("data", "external-calls");
const FILE = join(DIR, "calls.json");

// Затравка — то, что уже лежит в docs/external-calls-log.md. Дальше журнал
// пополняется только через --add, чтобы дата записи фиксировалась машиной,
// а не проставлялась задним числом.
const SEED = [
  {
    id: "roma-eth-3000-nov",
    source: "TG-блогер №1 (TG)",
    coin: "ETH",
    direction: "above",
    target: 3000,
    statedAt: "2026-08-07",
    pxAtStatement: 1917,
    deadline: "2026-11-30",
    note: "Нужен ход +56.5% от цены на момент прогноза.",
  },
];

function load() {
  if (!existsSync(FILE)) {
    // Затравку сохраняем СРАЗУ, а не только при --add: иначе витрина дашборда
    // читает несуществующий файл и показывает пустой журнал, хотя запись есть.
    const db = { calls: [...SEED] };
    save(db);
    return db;
  }
  return JSON.parse(readFileSync(FILE, "utf8"));
}
function save(db) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

async function mids() {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HL ${res.status}`);
  return res.json();
}

const db = load();

// ── Добавление ──────────────────────────────────────────────────────────────
const addIdx = process.argv.indexOf("--add");
if (addIdx !== -1) {
  const payload = JSON.parse(process.argv[addIdx + 1]);
  for (const f of ["source", "coin", "direction", "target", "deadline"]) {
    if (payload[f] == null) { console.error(`нет обязательного поля: ${f}`); process.exit(1); }
  }
  const px = await mids().catch(() => ({}));
  db.calls.push({
    id: payload.id || `${payload.source}-${payload.coin}-${payload.deadline}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    ...payload,
    // Цена на момент записи ставится МАШИНОЙ. Иначе её можно проставить задним
    // числом так, чтобы прогноз выглядел скромнее или смелее, чем был.
    pxAtStatement: payload.pxAtStatement ?? (parseFloat(px[payload.coin] ?? 0) || null),
    statedAt: payload.statedAt || new Date().toISOString().slice(0, 10),
    recordedAt: new Date().toISOString(),
  });
  save(db);
  console.log(`записан прогноз: ${db.calls[db.calls.length - 1].id}`);
  process.exit(0);
}

// ── Оценка ──────────────────────────────────────────────────────────────────
let px = {};
try { px = await mids(); } catch (err) { console.error(`⚠️  цены недоступны (${err.message})`); }

const today = new Date().toISOString().slice(0, 10);
const rows = db.calls.map((c) => {
  const now = parseFloat(px[c.coin] ?? 0) || null;
  const expired = c.deadline < today;
  // Прогноз «выше X» считается сбывшимся, если цена достигла X — но по этим
  // данным видно только СЕГОДНЯШНЮЮ цену, а не касание внутри срока. Поэтому
  // до дедлайна статус честно «ждём», и только после — да/нет по факту.
  const hit = now == null ? null : c.direction === "above" ? now >= c.target : now <= c.target;
  return { ...c, now, expired, status: !expired ? "ждём" : hit ? "СБЫЛСЯ" : "не сбылся", hit };
});

console.log(`\n  ЖУРНАЛ ЧУЖИХ ПРОГНОЗОВ — ${rows.length} записей\n`);
for (const r of rows) {
  const need = r.now && r.pxAtStatement
    ? `${((r.target / r.now - 1) * 100).toFixed(1)}% ещё нужно`
    : "—";
  console.log(`  ${r.source} · ${r.coin} ${r.direction === "above" ? "выше" : "ниже"} $${r.target}`);
  console.log(`    заявлено ${r.statedAt} при $${r.pxAtStatement ?? "?"} · дедлайн ${r.deadline} · сейчас $${r.now ?? "?"} (${need})`);
  console.log(`    статус: ${r.status}\n`);
}

const settled = rows.filter((r) => r.expired);
const bySource = new Map();
for (const r of settled) {
  if (!bySource.has(r.source)) bySource.set(r.source, { n: 0, hits: 0 });
  const s = bySource.get(r.source);
  s.n++; if (r.hit) s.hits++;
}
console.log("  БАЗРЕЙТ ПО ИСТОЧНИКАМ (только истёкшие):");
if (!settled.length) {
  console.log("    пока ни одного истёкшего прогноза — базрейта нет.");
  console.log("    Это НЕ значит «источник хорош»: это значит, что судить не на чем.");
} else {
  for (const [src, s] of bySource) {
    console.log(`    ${src}: ${s.hits} из ${s.n} (${(100 * s.hits / s.n).toFixed(0)}%)`);
  }
  console.log(
    `\n    ⚠️  На единицах прогнозов процент попаданий — шум. Базрейт начинает\n` +
    `        что-то значить примерно с 20 записей на источник, и сравнивать его\n` +
    `        надо не с нулём, а с «просто сказать, что рынок вырастет».`,
  );
}
console.log("");
