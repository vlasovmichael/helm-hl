// ─────────────────────────────────────────────────
//  disciplineAudit — сколько минут поза жила без стопа, и чего это стоило
// ─────────────────────────────────────────────────
// Твой леак сформулирован давно и одной фразой: «нет стопа». Но он НИКОГДА НЕ
// БЫЛ ИЗМЕРЕН — это была тренерская формулировка, а не число. Здесь она
// становится числом: по каждому ручному входу считается, сколько времени поза
// прожила без защитного ордера, и как выглядели исходы в разных корзинах.
//
// Защитный ордер опознаётся однозначно: reduceOnly=true И isTrigger=true И
// orderType содержит "Stop". Обычная reduceOnly-лимитка — это тейк, а не стоп,
// и в защиту не засчитывается: она не ограничивает убыток.
//
// ── ГЛАВНАЯ ОГОВОРКА: это НЕ причинность ───────────────────────────────────
// Соблазн прочитать вывод как «стоп приносит деньги» огромен, и он неверен.
// Замер наблюдательный: сделки, где ты ставишь стоп сразу, СИСТЕМАТИЧЕСКИ
// отличаются от тех, где не ставишь — по монете, по уверенности, по времени
// суток, по тому, насколько быстро цена пошла против. Разница между корзинами
// смешивает эффект стопа с эффектом «когда я вообще склонен его ставить».
// Причинный ответ дал бы только рандомизированный эксперимент, которого тут
// нет и не будет. Поэтому вывод честно ограничен ОПИСАНИЕМ: сколько сделок
// прожило без защиты, как долго, и какова их суммарная арифметика.
//
// Запуск:  node tools/disciplineAudit.mjs [--days 60]

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, stats, STOP_BUCKETS } from "./researchStats.mjs";

const API = "https://api.hyperliquid.xyz/info";
const FILLS_FILE = join("data", "fills", "fills.jsonl");
const ORDERS_DIR = join("data", "orders");
const ORDERS_FILE = join(ORDERS_DIR, "orders.jsonl");
const BOT_OIDS_FILE = process.env.BOT_OIDS_FILE || "";

const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1]) || 60;

// ── Загрузка и накопление ордеров ───────────────────────────────────────────
// Как и fills, historicalOrders живёт в API ограниченное время. Копим сами.

async function fetchOrders(address) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "historicalOrders", user: address }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HL ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function persistOrders(raw) {
  mkdirSync(ORDERS_DIR, { recursive: true });
  const seen = new Set(readJsonl(ORDERS_FILE).map((o) => o.oid));
  const flat = raw.map((r) => ({
    oid: r.order.oid,
    coin: r.order.coin,
    side: r.order.side,
    ts: r.order.timestamp,
    isTrigger: Boolean(r.order.isTrigger),
    reduceOnly: Boolean(r.order.reduceOnly),
    orderType: r.order.orderType,
    triggerPx: parseFloat(r.order.triggerPx || 0),
    origSz: parseFloat(r.order.origSz || 0),
    status: r.status,
    statusTs: r.statusTimestamp,
  }));
  const fresh = flat.filter((o) => o.oid != null && !seen.has(o.oid));
  if (fresh.length) appendFileSync(ORDERS_FILE, fresh.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return fresh.length;
}

// ── Реконструкция круговых сделок ───────────────────────────────────────────
// Своя, а не из src/modules/userFills.js: тот модуль тянет config/logger, а
// config падает без полного .env. Инструмент должен запускаться с хоста, где
// бот не развёрнут, поэтому логика тут минимальная и самодостаточная.

function roundTrips(fills) {
  const byCoin = new Map();
  for (const f of fills) {
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin).push(f);
  }
  const trips = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let open = null;
    for (const f of list) {
      const dir = String(f.dir || "");
      const isOpen = dir.startsWith("Open");
      if (isOpen) {
        if (!open) open = { coin, entryTime: f.time, side: dir.includes("Long") ? "long" : "short", pnl: 0, fee: 0, notional: 0 };
        open.notional += Math.abs(f.px * f.sz);
        open.fee += parseFloat(f.fee || 0);
      } else if (dir.startsWith("Close") && open) {
        open.pnl += parseFloat(f.closedPnl || 0);
        open.fee += parseFloat(f.fee || 0);
        open.exitTime = f.time;
        // Позиция закрыта, когда после этого филла размер обнулился.
        if (Math.abs(parseFloat(f.startPosition || 0)) - Math.abs(f.sz) < 1e-9) {
          open.net = open.pnl - open.fee;
          trips.push(open);
          open = null;
        }
      }
    }
  }
  return trips.sort((a, b) => a.entryTime - b.entryTime);
}

// ── Main ────────────────────────────────────────────────────────────────────

const address = process.env.PUBLIC_WALLET_ADDRESS;
if (!address) { console.error("PUBLIC_WALLET_ADDRESS не задан."); process.exit(1); }

let added = 0;
try {
  added = persistOrders(await fetchOrders(address));
} catch (err) {
  console.error(`⚠️  historicalOrders недоступен (${err.message}) — считаю по архиву.`);
}

const orders = readJsonl(ORDERS_FILE);
const allFills = readJsonl(FILLS_FILE);
if (!allFills.length) { console.error(`Нет ${FILLS_FILE} — сперва прогони tools/feeAudit.mjs`); process.exit(1); }

// Только ручные: бот ставит стоп сам и мгновенно, он бы разбавил замер до
// бессмыслицы. Список бот-oid берём из bot_oid_log (передаётся файлом).
const botOids = new Set(
  BOT_OIDS_FILE && existsSync(BOT_OIDS_FILE)
    ? readFileSync(BOT_OIDS_FILE, "utf8").trim().split("\n").map(Number)
    : [],
);
// ⚠️ Окно ОБЯЗАНО быть обрезано по покрытию архива ордеров, иначе замер врёт
// молча и в одну сторону. historicalOrders отдаёт последние ~2000 ордеров, а не
// «всё»: на 11.08.2026 это 06.07…11.08, тогда как филлы есть с 12.06. Без
// обрезки 700 филлов из 1418 оказались старше архива ордеров, их стопы просто
// не с чем было сопоставить — и все они попали в корзину «СТОПА НЕ БЫЛО»,
// раздув её до 54%. Ошибка односторонняя: она НИКОГДА не занижает голые сделки,
// только завышает, то есть подтверждает ожидаемый вывод. Такие и опаснее всего.
const orderCoverageFrom = orders.length ? Math.min(...orders.map((o) => o.ts)) : Infinity;
const requestedSince = Date.now() - days * 86_400_000;
const since = Math.max(requestedSince, orderCoverageFrom);
const clamped = since > requestedSince;

const manualFills = allFills.filter((f) => f.time >= since && !botOids.has(Number(f.oid)));
const trips = roundTrips(manualFills).filter((t) => t.exitTime);

// Защитные ордера: reduceOnly + trigger + Stop.
const stops = orders.filter(
  (o) => o.reduceOnly && o.isTrigger && /stop/i.test(o.orderType || ""),
);
const stopsByCoin = new Map();
for (const s of stops) {
  if (!stopsByCoin.has(s.coin)) stopsByCoin.set(s.coin, []);
  stopsByCoin.get(s.coin).push(s);
}
for (const list of stopsByCoin.values()) list.sort((a, b) => a.ts - b.ts);

// HL иногда зовёт монету иначе в ордерах и филлах (CC против CASHCAT), поэтому
// сначала пробуем точное совпадение, потом префиксное — молча промахнуться тут
// значит записать «стопа не было» там, где он был.
function firstStopFor(trip) {
  const exact = stopsByCoin.get(trip.coin) || [];
  const fuzzy = exact.length ? exact : [...stopsByCoin.entries()]
    .filter(([c]) => trip.coin.startsWith(c) || c.startsWith(trip.coin))
    .flatMap(([, v]) => v);
  return fuzzy.find((s) => s.ts >= trip.entryTime - 5_000 && s.ts <= trip.exitTime);
}

const BUCKETS = STOP_BUCKETS;

const rows = trips.map((t) => {
  const s = firstStopFor(t);
  return { ...t, minsToStop: s ? (s.ts - t.entryTime) / 60_000 : null };
});

// --save кладёт срез для дашборда. Считает ОДИН раз здесь, а не в роуте:
// роут не должен ходить в HL за историей ордеров на каждый запрос страницы.
if (process.argv.includes("--save")) {
  const OUT = join("data", "discipline");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "trips.json"), JSON.stringify({
    windowFrom: since, windowTo: Date.now(), clamped,
    computedAt: new Date().toISOString(),
    trips: rows.map((r) => ({ coin: r.coin, side: r.side, entryTime: r.entryTime, net: r.net, minsToStop: r.minsToStop })),
  }, null, 2));
}

const d = (t) => new Date(t).toISOString().slice(0, 10);
console.log(`\n  ЦЕНА ДИСЦИПЛИНЫ — ${trips.length} ручных круговых сделок, окно ${d(since)} … ${d(Date.now())}`);
console.log(`  ордеров в архиве: ${orders.length}${added ? ` (+${added} новых)` : ""}, из них защитных: ${stops.length}`);
if (clamped) {
  console.log(
    `  ⚠️  окно обрезано с ${d(requestedSince)} до ${d(since)}: архив ордеров начинается там,\n` +
    `      а раньше сопоставлять стопы не с чем. Всё, что до — не «без стопа», а «неизвестно».`,
  );
}
console.log("");
console.log("  корзина           сделок   средний net   95% CI              Σ net");
for (const b of BUCKETS) {
  const group = rows.filter((r) => b.test(r.minsToStop));
  const s = stats(group.map((r) => r.net));
  if (s.weak) { console.log(`  ${b.key.padEnd(17)} ${String(s.n).padStart(6)}   — мало для оценки`); continue; }
  console.log(
    `  ${b.key.padEnd(17)} ${String(s.n).padStart(6)}   ` +
    `${s.mean.toFixed(3).padStart(11)}   ` +
    `[${s.lo.toFixed(3)}, ${s.hi.toFixed(3)}]`.padEnd(20) +
    `${s.sum.toFixed(2).padStart(8)}`,
  );
}

const naked = rows.filter((r) => r.minsToStop == null);
const nakedShare = rows.length ? (100 * naked.length / rows.length).toFixed(0) : 0;
const withStop = rows.filter((r) => r.minsToStop != null);
const medDelay = withStop.length
  ? [...withStop.map((r) => r.minsToStop)].sort((a, b) => a - b)[withStop.length >> 1]
  : null;

console.log(`\n  ОПИСАНИЕ (не причинность):`);
console.log(`    без защитного ордера прожили: ${naked.length} из ${rows.length} сделок (${nakedShare}%)`);
if (medDelay != null) console.log(`    медианная задержка постановки стопа: ${medDelay.toFixed(1)} мин`);
console.log(`    суммарный net по сделкам без стопа: $${stats(naked.map((r) => r.net)).sum?.toFixed(2) ?? "—"}`);
console.log(
  `\n  ⚠️  Корзины НЕ сравнимы как причина и следствие. Сделки, где стоп ставится\n` +
  `      сразу, отличаются от остальных не только стопом: другая монета, другая\n` +
  `      уверенность, другая скорость хода против тебя. Разница между корзинами\n` +
  `      смешивает эффект стопа с эффектом «когда я вообще склонен его ставить».\n` +
  `      Читать можно только как описание: сколько сделок и как долго были голыми.\n`,
);
