// ─────────────────────────────────────────────────
//  feeAudit — сколько стоит исполнение, и сколько из этого возвращаемо
// ─────────────────────────────────────────────────
// Повод (2026-08-11): adopt за 506 сделок сделал +$21.45 грязными и отдал
// $23.65 комиссии → итог −$2.20. Весь минус — издержки исполнения, а не рынок.
//
// Почему это отдельный класс задачи, а не «поиск эджа»: снижение комиссии
// ДЕТЕРМИНИРОВАНО. Тейкер на HL платит 0.045%, мейкер 0.015% — втрое меньше, и
// это не гипотеза, которая может «оказаться шумом на n=500». Здесь не нужен ни
// бейзлайн, ни FDR: мы не утверждаем, что что-то предсказываем.
//
// Что тут ЧЕСТНО, а что нет:
//   ✅ честно — сколько заплачено, какая доля объёма прошла тейкером, какая
//      ставка получилась по факту (fee / notional, а не по табличке).
//   ⚠️ НЕ честно — говорить «мейкером я бы сэкономил $X». Лимитка на входе
//      исполняется НЕ ВСЕГДА: часть сделок просто не состоялась бы, и среди
//      несостоявшихся систематически больше тех, где цена ушла в твою сторону
//      (adverse selection). Поэтому контрфактика тут — ПОТОЛОК экономии, и
//      подписана как потолок. Настоящий ответ даст только форвардный замер
//      post-only, ради него и копим (см. persist ниже).
//
// Копим: HL отдаёт userFillsByTime максимум ~60 дней. Всё, что старше, исчезает
// навсегда. Инструмент дописывает fills в data/fills/fills.jsonl (дедуп по tid),
// чтобы через месяц окно было шире, чем даёт API.
//
// Запуск:  node tools/feeAudit.mjs [--days 60] [--json]
// В докере: docker exec hl-paper-scanner node /app/tools/feeAudit.mjs

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const DATA_DIR = join("data", "fills");
const FILLS_FILE = join(DATA_DIR, "fills.jsonl");

// Ставки HL perps для обычного тира (VIP-скидок на депо $10 нет и не будет).
// Используются ТОЛЬКО для контрфактического потолка — фактическая ставка
// считается из самих fills, чтобы табличка не врала про реальность.
const TAKER_RATE = 0.00045;
const MAKER_RATE = 0.00015;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const days = Number(args[args.indexOf("--days") + 1]) || 60;

// ── Загрузка ────────────────────────────────────────────────────────────────

async function fetchFills(address, startTime) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFillsByTime", user: address, startTime }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HL ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`неожиданный ответ: ${typeof data}`);
  return data;
}

/** Дописывает новые fills в архив. Дедуп по tid — HL отдаёт окна внахлёст. */
function persist(fills) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const seen = new Set();
  if (existsSync(FILLS_FILE)) {
    for (const line of readFileSync(FILLS_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { seen.add(JSON.parse(line).tid); } catch { /* битая строка — пропускаем */ }
    }
  }
  const fresh = fills.filter((f) => f.tid != null && !seen.has(f.tid));
  if (fresh.length) {
    appendFileSync(FILLS_FILE, fresh.map((f) => JSON.stringify(f)).join("\n") + "\n");
  }
  return { added: fresh.length, total: seen.size + fresh.length };
}

/** Читает архив — он шире, чем 60-дневное окно API. */
function loadArchive() {
  if (!existsSync(FILLS_FILE)) return [];
  const out = [];
  for (const line of readFileSync(FILLS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* битая строка */ }
  }
  return out;
}

// ── Разбор ──────────────────────────────────────────────────────────────────

const notional = (f) => Math.abs(parseFloat(f.px) * parseFloat(f.sz));
const isTaker = (f) => Boolean(f.crossed);
const isOpen = (f) => String(f.dir || "").startsWith("Open");

function summarize(fills) {
  const s = {
    n: fills.length,
    vol: 0, fee: 0,
    taker: { n: 0, vol: 0, fee: 0 },
    maker: { n: 0, vol: 0, fee: 0 },
  };
  for (const f of fills) {
    const v = notional(f);
    const fee = parseFloat(f.fee ?? 0);
    s.vol += v; s.fee += fee;
    const bucket = isTaker(f) ? s.taker : s.maker;
    bucket.n++; bucket.vol += v; bucket.fee += fee;
  }
  s.effRate = s.vol > 0 ? s.fee / s.vol : 0;
  s.takerShare = s.vol > 0 ? s.taker.vol / s.vol : 0;
  return s;
}

function fmt$(x) { return (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2); }
function fmtPct(x) { return (100 * x).toFixed(3) + "%"; }
function fmtBp(x) { return (10_000 * x).toFixed(1) + " бп"; }

// ── Main ────────────────────────────────────────────────────────────────────

const address = process.env.PUBLIC_WALLET_ADDRESS;
if (!address) {
  console.error("PUBLIC_WALLET_ADDRESS не задан — нечего аудировать.");
  process.exit(1);
}

const startTime = Date.now() - days * 86_400_000;
let live = [];
try {
  live = await fetchFills(address, startTime);
} catch (err) {
  // Fail-soft: сеть отвалилась — считаем по архиву, но говорим об этом вслух.
  console.error(`⚠️  HL недоступен (${err.message}) — считаю по архиву.`);
}

const { added, total } = live.length ? persist(live) : { added: 0, total: null };
const archive = loadArchive();
const fills = archive.length ? archive : live;

if (!fills.length) {
  console.log("Ни одного fill — ни в API, ни в архиве. Аудировать нечего.");
  process.exit(0);
}

const all = summarize(fills);
const opens = summarize(fills.filter(isOpen));
const closes = summarize(fills.filter((f) => !isOpen(f)));

// Контрфактический ПОТОЛОК: если бы весь тейкерский объём прошёл мейкером.
// Это верхняя граница, не прогноз — см. шапку про adverse selection.
const ceiling = all.taker.fee - all.taker.vol * MAKER_RATE;
// Реалистичнее — только входы: у выходов трейл/стоп по своей природе тейкер,
// их мейкером не сделать без смены логики выхода.
const ceilingOpensOnly = opens.taker.fee - opens.taker.vol * MAKER_RATE;

const first = Math.min(...fills.map((f) => f.time));
const last = Math.max(...fills.map((f) => f.time));

if (asJson) {
  console.log(JSON.stringify({ all, opens, closes, ceiling, ceilingOpensOnly, first, last, archiveSize: archive.length }, null, 2));
  process.exit(0);
}

const d = (t) => new Date(t).toISOString().slice(0, 10);
console.log(`\n  АУДИТ ИЗДЕРЖЕК ИСПОЛНЕНИЯ — ${d(first)} … ${d(last)}`);
console.log(`  архив: ${archive.length} fills${added ? ` (+${added} новых)` : ""}${live.length ? `, API отдал ${live.length} за ${days}д` : ""}\n`);

console.log(`  Объём:      ${fmt$(all.vol)} за ${all.n} исполнений`);
console.log(`  Комиссия:   ${fmt$(all.fee)}  = ${fmtBp(all.effRate)} по факту`);
console.log(`  Тейкером:   ${fmtPct(all.takerShare)} объёма (${all.taker.n} из ${all.n})\n`);

const row = (label, s) =>
  console.log(
    `  ${label.padEnd(10)} n=${String(s.n).padStart(4)}  объём ${fmt$(s.vol).padStart(10)}` +
    `  комиссия ${fmt$(s.fee).padStart(8)}  ставка ${fmtBp(s.effRate).padStart(9)}` +
    `  тейкер ${fmtPct(s.takerShare).padStart(8)}`,
  );
row("ВСЕГО", all);
row("входы", opens);
row("выходы", closes);

console.log(`\n  ПОТОЛОК ЭКОНОМИИ (не прогноз!):`);
console.log(`    если бы ВСЁ прошло мейкером:      ${fmt$(ceiling)}`);
console.log(`    если бы только ВХОДЫ мейкером:    ${fmt$(ceilingOpensOnly)}`);
console.log(
  `\n  ⚠️  Это верхняя граница. Лимитка исполняется не всегда, и не исполняется\n` +
  `      она чаще там, где цена ушла в твою сторону. Реальная экономия меньше;\n` +
  `      насколько — покажет только форвардный замер post-only.\n`,
);
