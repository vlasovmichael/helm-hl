// ─────────────────────────────────────────────────
//  feeReconcile — сверка журнала с биржей по деньгам
// ─────────────────────────────────────────────────
// 02.09.2026 журнал показывал −$69, биржа за тот же период — −$156.66.
// Юзер заметил разрыв раньше прибора, и это худший вид поломки: цифры на
// дашборде выглядели правдоподобно, поэтому им верили. На них были посчитаны
// payoff, средний плюс и средний минус — то есть ВСЕ выводы про торговлю
// стояли на заниженном убытке.
//
// Инструмент ничего не чинит на лету. Он берёт правду с биржи (userFills:
// closedPnl и fee по каждому филлу), сводит её по дням и монетам и показывает,
// где журнал расходится. Единственная правда о деньгах — биржа; журнал в этом
// вопросе вторичен и обязан к ней сходиться, а не наоборот.
//
// ⛔ Не пишет в БД. Правка истории задним числом — отдельное решение с
// отдельной ответственностью: journal-recalc уже показывал, как легко
// «починить» данные до неузнаваемости. Здесь только отчёт.
//
// Запуск:
//   node tools/feeReconcile.mjs                — с начала истории
//   node tools/feeReconcile.mjs 2026-08-01     — с даты

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ADDRESS = process.env.PUBLIC_WALLET_ADDRESS;
const API = "https://api.hyperliquid.xyz/info";
const ARCHIVE = join("data", "history_archive.json");

if (!ADDRESS) {
  console.error("\n  ✗ PUBLIC_WALLET_ADDRESS не задан — сверять не с чем.\n");
  process.exit(1);
}

const usd = (v) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

/** Все филлы адреса постранично: HL отдаёт максимум 2000 за запрос. */
async function fetchFills(sinceMs) {
  const out = [];
  let start = sinceMs;
  for (;;) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "userFillsByTime", user: ADDRESS, startTime: start, aggregateByTime: true }),
    });
    if (!res.ok) throw new Error(`HL ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < 2000) break;
    const last = Math.max(...page.map((f) => f.time));
    if (last <= start) break;
    start = last + 1;
    await new Promise((r) => setTimeout(r, 300)); // общий пул HL не насилуем
  }
  // Пагинация по времени даёт нахлёст на границе — чистим по tid.
  const seen = new Set();
  return out.filter((f) => {
    const k = f.tid ?? `${f.time}|${f.coin}|${f.px}|${f.sz}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function loadJournal(sinceMs) {
  if (!existsSync(ARCHIVE)) return [];
  const rows = JSON.parse(readFileSync(ARCHIVE, "utf8"));
  return rows.filter((t) => t.mode === "PRODUCTION" && t.closed_at >= sinceMs);
}

const since = process.argv[2] ? Date.parse(`${process.argv[2]}T00:00:00Z`) : Date.parse("2026-01-01T00:00:00Z");
if (!Number.isFinite(since)) {
  console.error("\n  ✗ дата в формате YYYY-MM-DD\n");
  process.exit(1);
}

const fills = await fetchFills(since);
if (!fills.length) {
  console.log("\n  филлов за период нет\n");
  process.exit(0);
}

// 🚨 closedPnl биржи — ДО комиссии. Чистый результат = closedPnl − fee.
// Журнал по своему контракту хранит realized_pnl уже NET (см. integrity.js),
// поэтому его колонку вычитать второй раз нельзя — именно на этом я и
// ошибся при первом подсчёте 02.09.
const exPnl = fills.reduce((s, f) => s + Number(f.closedPnl || 0), 0);
const exFee = fills.reduce((s, f) => s + Number(f.fee || 0), 0);
const exVol = fills.reduce((s, f) => s + Number(f.sz) * Number(f.px), 0);
const exNet = exPnl - exFee;

const journal = loadJournal(since);
const jNet = journal.reduce((s, t) => s + Number(t.realized_pnl || 0), 0);
const jFee = journal.reduce((s, t) => s + Number(t.fee_paid || 0), 0);
const zeroFee = journal.filter((t) => !Number(t.fee_paid)).length;

const from = new Date(Math.min(...fills.map((f) => f.time))).toISOString().slice(0, 10);
const to = new Date(Math.max(...fills.map((f) => f.time))).toISOString().slice(0, 10);

console.log(`\n  ── сверка ${from} → ${to} ──\n`);
console.log(`  БИРЖА   ${fills.length} филлов, оборот $${(exVol / 1000).toFixed(0)}k`);
console.log(`          closedPnl ${usd(exPnl)}  −  комиссии $${exFee.toFixed(2)}  =  ${usd(exNet)}`);
console.log(`  ЖУРНАЛ  ${journal.length} сделок`);
console.log(`          realized (уже net) ${usd(jNet)}   fee_paid $${jFee.toFixed(2)} (справочно)`);
console.log(`\n  РАЗРЫВ  ${usd(jNet - exNet)}  — столько журнал НЕ видит\n`);

if (zeroFee)
  console.log(`  ⓘ ${zeroFee} сделок с fee_paid=0: закрыты по equity-diff, где realized уже`);
console.log(`    net и комиссию отдельно взять неоткуда. Это не баг записи, но и не данные.`);

// Где именно расходится: по месяцам видно, разрыв копится ровно или скачком.
const month = (ts) => new Date(ts).toISOString().slice(0, 7);
const byMonth = new Map();
for (const f of fills) {
  const k = month(f.time);
  const m = byMonth.get(k) || { ex: 0, j: 0 };
  m.ex += Number(f.closedPnl || 0) - Number(f.fee || 0);
  byMonth.set(k, m);
}
for (const t of journal) {
  const k = month(t.closed_at);
  const m = byMonth.get(k) || { ex: 0, j: 0 };
  m.j += Number(t.realized_pnl || 0);
  byMonth.set(k, m);
}
console.log("\n  месяц     биржа      журнал     разрыв");
for (const [k, m] of [...byMonth].sort()) {
  console.log(`  ${k}   ${usd(m.ex).padStart(9)}  ${usd(m.j).padStart(9)}  ${usd(m.j - m.ex).padStart(9)}`);
}

// Комиссия как доля результата — та цифра, ради которой всё и затевалось.
console.log(
  `\n  комиссии съели ${((exFee / Math.abs(exNet)) * 100).toFixed(0)}% убытка` +
    `  (${((exFee / exVol) * 10000).toFixed(2)} бп с оборота, ${(exFee / fills.length).toFixed(3)}$ на филл)\n`,
);
