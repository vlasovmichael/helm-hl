// ─────────────────────────────────────────────────
//  bookCollector — стакан копится только вперёд
// ─────────────────────────────────────────────────
// Зачем (2026-08-11). feeAudit показал: 100% исполнений идут тейкером, издержки
// $37 за два месяца при счёте $10. Напрашивается post-only — но сказать «мейкер
// сэкономил бы $14.87» нельзя: лимитка исполняется НЕ ВСЕГДА, и не исполняется
// систематически чаще там, где цена ушла в твою сторону (adverse selection).
// Пока эта поправка не измерена, переход на мейкера — вера, а не решение.
//
// Измерить её можно только форвардно: HL НЕ отдаёт исторический стакан. Спред,
// который был в момент входа вчера, не восстановить ничем. Поэтому коллектор
// пишет с сегодня, а анализ (tools/postOnlySim.mjs) читает накопленное потом.
//
// ── Весовой бюджет: почему так редко ───────────────────────────────────────
// Этот проект уже горел на весе дважды: 19.07 голодание пула (userFills 500-ил,
// бот ослеп) и 31.07 тик встал на 5 минут, потому что очередь за весом
// раздавалась «кто успел». Общий лимит HL — на IP, а не на процесс, поэтому
// отдельный контейнер НЕ отменяет конкуренцию с торговым путём.
// Считаем честно: 12 монет × 1 запрос/60с = 12 req/мин, вес l2Book = 2
// → ~24 веса/мин при лимите 1200. Это 2% бюджета. Раз в 60с достаточно:
// нам нужен профиль спреда, а не тиковая лента.
//
// Запуск (отдельный процесс, ордеров не ставит):
//   node tools/bookCollector.mjs
//   node tools/bookCollector.mjs --once     # один проход, для проверки

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const OUT_DIR = join("data", "book");
const POLL_MS = Number(process.env.BOOK_POLL_MS || 60_000);
const REQ_GAP_MS = 250;        // разносим запросы внутри прохода, не залпом
const TIMEOUT_MS = 8_000;

// Монеты: те, которыми ты реально торгуешь руками (топ по числу исполнений в
// data/fills/). Список фиксированный, а не «топ по объёму рынка» — мерить надо
// стакан ТВОИХ монет, у CASHCAT и BTC совершенно разная ликвидность.
const COINS = (process.env.BOOK_COINS ||
  "CASHCAT,ACE,HMSTR,HYPE,KAITO,MANTA,PUMP,DYDX,JTO,XPL,AERO,RESOLV"
).split(",").map((c) => c.trim()).filter(Boolean);

const once = process.argv.includes("--once");

async function l2Book(coin) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HL ${res.status}`);
  return res.json();
}

/** Из сырого стакана — только то, что нужно для модели исполнения. */
function digest(book) {
  const [bids, asks] = book.levels || [];
  if (!bids?.length || !asks?.length) return null;
  const bid = parseFloat(bids[0].px), ask = parseFloat(asks[0].px);
  if (!(bid > 0) || !(ask > bid)) return null;
  const mid = (bid + ask) / 2;
  // Глубина на 10 бп в каждую сторону — сколько денег стоит между тобой и
  // проскальзыванием. Без неё спред обманчив: узкий спред на пустом стакане
  // хуже широкого на плотном.
  const depth = (levels, sign) => {
    let usd = 0;
    for (const l of levels) {
      const px = parseFloat(l.px);
      if (sign * (px - mid) / mid > 0.001) break;
      usd += px * parseFloat(l.sz);
    }
    return +usd.toFixed(2);
  };
  return {
    t: book.time,
    coin: book.coin,
    bid, ask,
    mid: +mid.toFixed(8),
    // Спред в базисных пунктах — прямая цена того, что ты берёшь по рынку.
    // Сравнивать надо именно с ним: тейкерская наценка 4.5 бп имеет смысл
    // только рядом с тем, сколько стоит ждать в очереди.
    spreadBp: +((ask - bid) / mid * 10_000).toFixed(2),
    bidSz: +(bid * parseFloat(bids[0].sz)).toFixed(2),
    askSz: +(ask * parseFloat(asks[0].sz)).toFixed(2),
    bidDepth: depth(bids, -1),
    askDepth: depth(asks, 1),
    // Число ордеров на лучшей цене — грубая оценка очереди перед тобой.
    bidN: bids[0].n, askN: asks[0].n,
  };
}

function outFile() {
  const month = new Date().toISOString().slice(0, 7);
  return join(OUT_DIR, `book-${month}.jsonl`);
}

async function pass() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const coin of COINS) {
    try {
      const d = digest(await l2Book(coin));
      if (d) rows.push(d);
    } catch (err) {
      // Fail-soft поштучно: одна монета не должна ронять проход. Молчим в
      // stdout, пишем в stderr — иначе крон завалит лог шумом.
      process.stderr.write(`[book] ${coin}: ${err.message}\n`);
    }
    await new Promise((r) => setTimeout(r, REQ_GAP_MS));
  }
  if (rows.length) appendFileSync(outFile(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
}

if (once) {
  const rows = await pass();
  console.log(`  снято ${rows.length} стаканов из ${COINS.length}\n`);
  console.log("  монета      спред  лучший bid $   глубина ±10бп");
  for (const r of rows.sort((a, b) => b.spreadBp - a.spreadBp)) {
    console.log(
      `  ${r.coin.padEnd(10)} ${(r.spreadBp + " бп").padStart(8)}  ` +
      `${("$" + r.bidSz.toFixed(0)).padStart(10)}   ` +
      `$${r.bidDepth.toFixed(0)} / $${r.askDepth.toFixed(0)}`,
    );
  }
  process.exit(0);
}

process.stderr.write(`[book] старт: ${COINS.length} монет каждые ${POLL_MS / 1000}с → ${OUT_DIR}\n`);
await pass();
setInterval(pass, POLL_MS);
