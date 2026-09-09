// ─────────────────────────────────────────────────
//  unlocksForward — форвард гипотезы `unlock-cliff-front-2026-09`
// ─────────────────────────────────────────────────
// Шорт за 7 дней до крупного cliff-разлока. Смысл форварда — не «ещё один
// бэктест», а защита от единственной дыры ретроспективы: DefiLlama отдаёт
// ТЕКУЩЕЕ расписание, и если проект перенёс дату, история выглядит подчищенной.
//
// 🚨 Поэтому расписание фиксируется снимком в момент обнаружения события и
// больше не пересматривается. Перенос даты после записи попадает в `moved`,
// а сделка форварда остаётся на исходных условиях — иначе форвард унаследует
// тот же look-ahead, ради ухода от которого затеян.
//
// Файлы (append-only, как реестр гипотез):
//   data/unlocks/schedule.jsonl — снимки расписания, по одному на обнаружение
//   data/unlocks/forward.jsonl  — сделки форварда и их исход
//
// Запуск: node tools/unlocksForward.mjs [scan|settle|report]

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join("data", "unlocks");
const SCHEDULE = join(DIR, "schedule.jsonl");
const FORWARD = join(DIR, "forward.jsonl");
const DAY = 864e5;
const HOLD_DAYS = 7;
const MIN_RATIO = 1;          // разлок не меньше одного дневного оборота
const FEE_TAKER_BP = 5.428;   // факт по филлам оператора

const info = (body) =>
  fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function appendJsonl(path, rec) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ── источник расписаний ───────────────────────────
// Список протоколов и их события эмиссии. Бесплатный датасет DefiLlama;
// платный /emissions отдаёт 402, этот — 200.
async function fetchSchedule() {
  const list = await fetch("https://defillama-datasets.llama.fi/emissionsProtocolsList").then((r) => r.json());
  const names = Array.isArray(list) ? list : Object.keys(list);
  const cg = await fetch("https://api.coingecko.com/api/v3/coins/list").then((r) => r.json());
  const symById = new Map(cg.map((c) => [c.id, c.symbol.toUpperCase()]));
  const [meta] = await info({ type: "metaAndAssetCtxs" });
  const perps = new Set(meta.universe.map((u) => u.name.toUpperCase()));

  const out = [];
  for (const proto of names) {
    let d;
    try {
      const r = await fetch(`https://defillama-datasets.llama.fi/emissions/${proto}`);
      if (!r.ok) continue;
      d = await r.json();
    } catch { continue; }
    const sym = d.gecko_id ? symById.get(d.gecko_id) : null;
    if (!sym || !perps.has(sym)) continue;
    for (const e of d.metadata?.events || []) {
      if (e.unlockType !== "cliff") continue;
      const tokens = (e.noOfTokens || []).reduce((s, x) => s + x, 0);
      if (tokens > 0) out.push({ coin: sym, proto, ts: e.timestamp * 1000, tokens, category: e.category });
    }
  }
  return out;
}

// Дневной оборот в долларах — мера, относительно которой разлок «крупный».
async function coinContext(coin) {
  const end = Date.now();
  const bars = await info({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: end - 40 * DAY, endTime: end } });
  if (!Array.isArray(bars) || bars.length < 10) return null;
  const vols = bars.map((b) => +b.v * +b.c).filter((x) => x > 0);
  return { price: +bars.at(-1).c, dayVolUsd: median(vols) };
}

// ── scan: найти новые события и записать снимок ───
export async function scan({ horizonDays = 45, quiet = false } = {}) {
  const now = Date.now();
  const seen = new Set(readJsonl(SCHEDULE).map((r) => r.key));
  const openTrades = readJsonl(FORWARD);
  const events = await fetchSchedule();
  const ctxCache = new Map();
  let added = 0, moved = 0;

  for (const e of events) {
    if (e.ts < now || e.ts > now + horizonDays * DAY) continue;
    const key = `${e.coin}:${e.ts}:${e.category}`;
    if (seen.has(key)) continue;
    if (!ctxCache.has(e.coin)) ctxCache.set(e.coin, await coinContext(e.coin));
    const ctx = ctxCache.get(e.coin);
    if (!ctx) continue;
    const usd = e.tokens * ctx.price;
    const ratio = usd / ctx.dayVolUsd;
    if (ratio < MIN_RATIO) continue;

    // Перенос даты: то же событие той же категории уже висит на другой дате.
    const prior = openTrades.find((t) => t.coin === e.coin && t.category === e.category && t.status === "pending");
    if (prior && Math.abs(prior.unlockTs - e.ts) > DAY) moved++;

    const rec = {
      key, coin: e.coin, proto: e.proto, category: e.category,
      unlockTs: e.ts, entryTs: e.ts - HOLD_DAYS * DAY,
      tokens: e.tokens, usd, ratio,
      priceAtDiscovery: ctx.price, dayVolUsd: ctx.dayVolUsd,
      discoveredAt: now, status: "pending",
      // 🚨 Событие, найденное позже собственной даты входа, в зачёт не идёт:
      // вход по нему пришлось бы ставить задним числом, а это тот самый
      // look-ahead, от которого форвард и защищает.
      clean: now <= e.ts - HOLD_DAYS * DAY,
    };
    appendJsonl(SCHEDULE, rec);
    appendJsonl(FORWARD, rec);
    added++;
  }
  if (!quiet) console.log(`scan: новых событий ${added}, переносов даты замечено ${moved}`);
  return { added, moved };
}

// ── settle: закрыть события, чья дата прошла ──────
// Вход и выход берутся по закрытию дня — те же цены, что в ретроспективе.
export async function settle({ quiet = false } = {}) {
  const rows = readJsonl(FORWARD);
  const done = new Set(rows.filter((r) => r.status === "closed").map((r) => r.key));
  const now = Date.now();
  const pending = rows.filter((r) => r.status === "pending" && !done.has(r.key) && r.unlockTs < now);
  let settled = 0;
  for (const r of pending) {
    const bars = await info({ type: "candleSnapshot", req: { coin: r.coin, interval: "1d", startTime: r.entryTs - 2 * DAY, endTime: r.unlockTs + 2 * DAY } });
    if (!Array.isArray(bars) || bars.length < 3) continue;
    const at = (ts) => { const d = Math.floor(ts / DAY); return bars.find((b) => Math.floor(b.t / DAY) === d); };
    const bIn = at(r.entryTs), bOut = at(r.unlockTs);
    if (!bIn || !bOut) continue;
    const entry = +bIn.c, exit = +bOut.c;
    const grossBp = Math.log(entry / exit) * 1e4;        // SHORT: прибыль при падении
    const costBp = 2 * FEE_TAKER_BP;                      // спред по монете не хранится — считаем по комиссии
    appendJsonl(FORWARD, { ...r, status: "closed", entryPx: entry, exitPx: exit, grossBp, costBp, netBp: grossBp - costBp, settledAt: now });
    settled++;
  }
  if (!quiet) console.log(`settle: закрыто ${settled}`);
  return { settled };
}

// ── report: состояние форварда ────────────────────
export function report() {
  const rows = readJsonl(FORWARD);
  // В зачёт гипотезы идут только чистые события; остальные видны в витрине
  // отдельной строкой, чтобы их не спутать с результатом.
  const closed = rows.filter((r) => r.status === "closed" && r.clean);
  const closedKeys = new Set(closed.map((r) => r.key));
  const pending = rows.filter((r) => r.status === "pending" && !closedKeys.has(r.key) && r.clean);
  const dirty = rows.filter((r) => !r.clean).length;
  const net = closed.map((r) => r.netBp);
  return {
    hypothesis: "unlock-cliff-front-2026-09",
    evaluateAt: 60,
    closed: closed.length,
    pending: pending.length,
    skippedLookahead: dirty,
    medianNetBp: net.length ? median(net) : null,
    meanNetBp: net.length ? net.reduce((s, x) => s + x, 0) / net.length : null,
    winShare: net.length ? (net.filter((x) => x > 0).length / net.length) * 100 : null,
    coins: new Set(closed.map((r) => r.coin)).size,
    // 🚨 Промежуточный итог показывается, но решением не является: стоп-правило
    // гипотезы разрешает оценку ровно один раз, при n=60.
    verdictAllowed: closed.length >= 60,
    trades: closed.slice(-50),
    upcoming: pending.sort((a, b) => a.unlockTs - b.unlockTs).slice(0, 40),
  };
}

const cmd = process.argv[2];
if (cmd === "scan") await scan();
else if (cmd === "settle") await settle();
else if (cmd === "report") console.log(JSON.stringify(report(), null, 2));
else if (cmd) console.error(`неизвестная команда: ${cmd}`);
