// ─────────────────────────────────────────────────
//  postOnlySim — сколько на самом деле даёт вход мейкером
// ─────────────────────────────────────────────────
// Пара к tools/bookCollector.mjs: коллектор копит стакан ради этого замера.
//
// ── Вопрос ─────────────────────────────────────────────────────────────────
// Все наши входы — тейкер. Тейкер на HL платит 4.5 бп, мейкер 1.5 бп, плюс
// post-only входит по пассивной стороне и экономит спред. Арифметический
// выигрыш ≈ спред + 3 бп — при среднем результате сделки в единицы бп это не
// косметика.
//
// Но лимитка исполняется НЕ ВСЕГДА, и не исполняется она системно чаще там,
// где цена сразу ушла в нашу сторону — то есть выпадают лучшие сделки. Это
// неблагоприятный отбор, и он может съесть весь выигрыш. Поэтому считаем ТРИ
// числа, а не одно:
//   1. доля исполнений — какая часть входов вообще состоялась бы;
//   2. улучшение цены — сколько бп выигрываем на исполнившихся;
//   3. отбор — чем отличается форвардная доходность исполнившихся от
//      пропущенных. Если пропущенные системно лучше, выигрыш из (1)+(2) фиктивен.
//
// ── Чего этот замер НЕ делает ──────────────────────────────────────────────
// ⚠️ Очередь в стакане не моделируется. Мы считаем исполнением ситуацию, когда
//    цена ПРОБИЛА наш уровень строго насквозь (low < limit для BUY). Это
//    консервативно относительно «коснулась и отскочила», но всё ещё оптимизм:
//    реально перед нами стоит чужой объём, и на первом же касании нас может не
//    налить. Значит доля исполнений здесь — верхняя граница.
// ⚠️ Стакан пишется раз в 60с и только по 12 монетам (BOOK_COINS). Входы вне
// покрытия считаются отдельной строкой «не покрыто», а не выбрасываются.
// ⚠️ Свечи 1m. Внутри минуты порядок обхода low/high неизвестен, поэтому окно
//    ожидания меньше минуты не измеримо в принципе.
// ⚠️ Это НЕ поиск эджа: мы ничего не предсказываем. Здесь не нужны нулевые
//    модели и FDR — сравниваются два способа исполнить одно и то же решение.
//    Но пункт (3) — уже статистика, и без n и ДИ его читать нельзя.
//
// Запуск:
//   node tools/postOnlySim.mjs                 # окна 1/5/15/60 мин
//   node tools/postOnlySim.mjs --windows 5,30  # свои окна ожидания
//   node tools/postOnlySim.mjs --json

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const BOOK_DIR = join("data", "book");
const FILLS_FILE = join("data", "fills", "fills.jsonl");
const CACHE_DIR = join("data", "postonly");

// Ставки HL для обычного тира — те же, что в feeAudit (единая точка правды тут
// невозможна без общего модуля, но расхождение будет сразу видно в разборе).
const TAKER_RATE_BP = 4.5;
const MAKER_RATE_BP = 1.5;

// Насколько далеко от входа разрешено брать снимок стакана. Коллектор пишет
// раз в 60с, поэтому 90с — это «соседний снимок», а не «час назад».
const BOOK_TOL_MS = 90_000;

// Горизонты для проверки отбора. 30 мин — масштаб наших сделок, 120 мин —
// контроль: если эффект есть только на 30 мин, это микроструктура, а не отбор.
const FWD_HORIZONS_MIN = [30, 120];

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const windowsMin = (() => {
  const i = args.indexOf("--windows");
  if (i === -1) return [1, 5, 15, 60];
  return String(args[i + 1] || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => x > 0);
})();

// ── Загрузка ────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* битая строка — пропускаем */ }
  }
  return out;
}

/** Снимки стакана: coin → массив, отсортированный по времени. */
function loadBook() {
  if (!existsSync(BOOK_DIR)) return new Map();
  const files = readdirSync(BOOK_DIR).filter((f) => f.endsWith(".jsonl"));
  const byCoin = new Map();
  for (const f of files) {
    for (const s of readJsonl(join(BOOK_DIR, f))) {
      if (!s.coin || !(s.bid > 0) || !(s.ask > 0)) continue;
      if (!byCoin.has(s.coin)) byCoin.set(s.coin, []);
      byCoin.get(s.coin).push(s);
    }
  }
  for (const arr of byCoin.values()) arr.sort((a, b) => a.t - b.t);
  return byCoin;
}

/** Бинарный поиск ближайшего по времени снимка. null, если дальше допуска. */
function nearestSnapshot(arr, t) {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const cands = [arr[lo], arr[lo - 1]].filter(Boolean);
  let best = null;
  for (const c of cands) {
    const d = Math.abs(c.t - t);
    if (d <= BOOK_TOL_MS && (!best || d < Math.abs(best.t - t))) best = c;
  }
  return best;
}

// ── Свечи ───────────────────────────────────────────────────────────────────

async function fetchCandleChunk(coin, startTime, endTime) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval: "1m", startTime, endTime },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HL ${res.status} ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 1m-свечи по монете за период, с кэшем на диск. HL отдаёт максимум ~5000
 * свечей за запрос, поэтому period режется на куски по 4000 минут.
 */
async function loadCandles(coin, from, to) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `candles-${coin}.json`);
  if (existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (c.from <= from && c.to >= to && Array.isArray(c.rows)) return c.rows;
    } catch { /* битый кэш — перекачаем */ }
  }
  const CHUNK_MS = 4000 * 60_000;
  const rows = [];
  for (let s = from; s < to; s += CHUNK_MS) {
    const e = Math.min(s + CHUNK_MS, to);
    rows.push(...(await fetchCandleChunk(coin, s, e)));
    await new Promise((r) => setTimeout(r, 250)); // весовой бюджет HL
  }
  // Дедуп по времени открытия — куски идут внахлёст.
  const seen = new Set();
  const uniq = rows
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t)
    .map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }));
  writeFileSync(cacheFile, JSON.stringify({ from, to, rows: uniq }));
  return uniq;
}

// ── Симуляция ───────────────────────────────────────────────────────────────

const isOpen = (f) => String(f.dir || "").startsWith("Open");
const bp = (x) => x * 10_000;

/**
 * Исполнилась бы post-only заявка на уровне limit за окно windowMs?
 * BUY ждёт пробоя вниз (low < limit), SELL — вверх (high > limit).
 * Строгое неравенство: касание уровня не наливает — перед нами очередь.
 * @returns {{filled: boolean, tFill: number|null}}
 */
function simulateFill(candles, t0, windowMs, limit, isBuy) {
  const tEnd = t0 + windowMs;
  for (const c of candles) {
    if (c.t + 60_000 <= t0) continue;  // свеча целиком до входа
    if (c.t > tEnd) break;
    if (isBuy ? c.l < limit : c.h > limit) return { filled: true, tFill: c.t };
  }
  return { filled: false, tFill: null };
}

/** Цена через N минут после t0 (закрытие ближайшей свечи). null — нет данных. */
function priceAfter(candles, t0, minutes) {
  const target = t0 + minutes * 60_000;
  let best = null;
  for (const c of candles) {
    if (c.t > target) break;
    best = c;
  }
  return best && best.t + 60_000 >= target - 60_000 ? best.c : null;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
/** ДИ 95% для среднего (нормальное приближение). n<2 → null. */
function ci95(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  const half = 1.96 * (sd / Math.sqrt(n));
  return [m - half, m + half];
}

// ── Main ────────────────────────────────────────────────────────────────────

const book = loadBook();
if (!book.size) {
  console.error(`Нет снимков стакана в ${BOOK_DIR}. Запусти tools/bookCollector.mjs.`);
  process.exit(1);
}

const allFills = readJsonl(FILLS_FILE);
if (!allFills.length) {
  console.error(`Нет филлов в ${FILLS_FILE}. Запусти tools/feeAudit.mjs.`);
  process.exit(1);
}

const opens = allFills.filter(isOpen).sort((a, b) => a.time - b.time);

// Покрытие: вход считается измеримым, только если рядом есть снимок стакана.
const covered = [];
const uncovered = [];
for (const f of opens) {
  const snap = nearestSnapshot(book.get(f.coin), f.time);
  if (snap) covered.push({ f, snap }); else uncovered.push(f);
}

if (!covered.length) {
  console.error(
    `Ни один вход не покрыт стаканом. Коллектор пишет с 11.08 и только по ` +
    `BOOK_COINS — проверь, что монеты входов совпадают со списком.`,
  );
  process.exit(1);
}

// Свечи качаем по одной монете на весь диапазон её входов — так запросов
// единицы, а не сотни.
const coins = [...new Set(covered.map((c) => c.f.coin))];
const maxWindowMs = Math.max(...windowsMin) * 60_000;
const maxFwdMs = Math.max(...FWD_HORIZONS_MIN) * 60_000;
const candlesByCoin = new Map();
for (const coin of coins) {
  const ts = covered.filter((c) => c.f.coin === coin).map((c) => c.f.time);
  const from = Math.min(...ts) - 60 * 60_000;
  const to = Math.max(...ts) + maxWindowMs + maxFwdMs + 60 * 60_000;
  try {
    candlesByCoin.set(coin, await loadCandles(coin, from, to));
  } catch (err) {
    console.error(`⚠️  свечи ${coin} не скачались (${err.message}) — монета выпадает`);
  }
}

// Основной прогон: для каждого окна ожидания — своя строка результата.
const results = [];
for (const wMin of windowsMin) {
  const windowMs = wMin * 60_000;
  const improveBp = [];              // улучшение цены на исполнившихся
  const fwdFilled = {};              // форвард по горизонтам, исполнившиеся
  const fwdMissed = {};              // …и пропущенные
  for (const h of FWD_HORIZONS_MIN) { fwdFilled[h] = []; fwdMissed[h] = []; }
  let nFilled = 0, nMissed = 0, nNoCandles = 0;

  for (const { f, snap } of covered) {
    const candles = candlesByCoin.get(f.coin);
    if (!candles || !candles.length) { nNoCandles++; continue; }

    const isBuy = f.side === "B";
    const takerPx = parseFloat(f.px);
    // Пассивная сторона: покупаем на биде, продаём на аске. Именно это делает
    // post-only — по своей стороне книги, не пересекая спред.
    const limit = isBuy ? snap.bid : snap.ask;
    if (!(limit > 0) || !(takerPx > 0)) { nNoCandles++; continue; }

    const { filled } = simulateFill(candles, f.time, windowMs, limit, isBuy);

    // Форвард считаем от ЦЕНЫ ТЕЙКЕРСКОГО ВХОДА и в сторону сделки — так обе
    // группы (исполнившиеся/пропущенные) меряются одной линейкой, и разница
    // между ними не заражена разницей цен входа.
    for (const h of FWD_HORIZONS_MIN) {
      const px = priceAfter(candles, f.time, h);
      if (px == null) continue;
      const ret = isBuy ? (px - takerPx) / takerPx : (takerPx - px) / takerPx;
      (filled ? fwdFilled : fwdMissed)[h].push(bp(ret));
    }

    if (filled) {
      nFilled++;
      const imp = isBuy ? (takerPx - limit) / takerPx : (limit - takerPx) / takerPx;
      improveBp.push(bp(imp));
    } else {
      nMissed++;
    }
  }

  const nTried = nFilled + nMissed;
  const fillRate = nTried ? nFilled / nTried : 0;
  const avgImprove = mean(improveBp) ?? 0;
  const feeSaving = TAKER_RATE_BP - MAKER_RATE_BP;

  results.push({
    windowMin: wMin,
    nTried, nFilled, nMissed, nNoCandles,
    fillRate,
    avgImproveBp: avgImprove,
    improveCi: ci95(improveBp),
    feeSavingBp: feeSaving,
    // Выигрыш НА ИСПОЛНИВШЕЙСЯ сделке. Не «на всех»: непроведённая сделка не
    // экономит комиссию, она просто не случается.
    gainPerFilledBp: avgImprove + feeSaving,
    fwd: Object.fromEntries(
      FWD_HORIZONS_MIN.map((h) => [h, {
        filled: { n: fwdFilled[h].length, mean: mean(fwdFilled[h]), ci: ci95(fwdFilled[h]) },
        missed: { n: fwdMissed[h].length, mean: mean(fwdMissed[h]), ci: ci95(fwdMissed[h]) },
      }]),
    ),
  });
}

const spreads = covered.map((c) => c.snap.spreadBp).filter((x) => x > 0).sort((a, b) => a - b);
const medSpread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : null;

if (asJson) {
  console.log(JSON.stringify({
    coveredOpens: covered.length,
    uncoveredOpens: uncovered.length,
    coins,
    medianSpreadBp: medSpread,
    results,
  }, null, 2));
  process.exit(0);
}

// ── Вывод ───────────────────────────────────────────────────────────────────

const n2 = (x) => (x == null ? "—" : x.toFixed(2));
const sgn = (x) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`);
const ciStr = (c) => (c ? `[${sgn(c[0])} … ${sgn(c[1])}]` : "[ДИ нет]");

console.log(`\n  POST-ONLY: ЧТО БЫЛО БЫ, ЕСЛИ ВХОДИТЬ МЕЙКЕРОМ`);
console.log(`  входов всего ${opens.length}, покрыто стаканом ${covered.length}, вне покрытия ${uncovered.length}`);
console.log(`  монеты: ${coins.join(", ")}`);
console.log(`  медианный спред в момент входа: ${n2(medSpread)} бп`);
console.log(`  экономия на комиссии: ${TAKER_RATE_BP} → ${MAKER_RATE_BP} бп = ${TAKER_RATE_BP - MAKER_RATE_BP} бп\n`);

for (const r of results) {
  console.log(`  ── окно ожидания ${r.windowMin} мин ` + "─".repeat(46));
  console.log(
    `     исполнилось ${r.nFilled}/${r.nTried} = ${(100 * r.fillRate).toFixed(1)}%` +
    (r.nNoCandles ? `  (без свечей: ${r.nNoCandles})` : ""),
  );
  console.log(`     улучшение цены: ${sgn(r.avgImproveBp)} бп ${ciStr(r.improveCi)}`);
  console.log(`     + комиссия:     ${sgn(r.feeSavingBp)} бп`);
  console.log(`     ИТОГО на исполнившейся сделке: ${sgn(r.gainPerFilledBp)} бп`);
  for (const h of FWD_HORIZONS_MIN) {
    const g = r.fwd[h];
    console.log(
      `     отбор @${h}м: исполнились ${sgn(g.filled.mean)} бп (n=${g.filled.n}) ${ciStr(g.filled.ci)} | ` +
      `пропущены ${sgn(g.missed.mean)} бп (n=${g.missed.n}) ${ciStr(g.missed.ci)}`,
    );
  }
  console.log("");
}

console.log(
  `  Как читать:\n` +
  `   · «исполнилось» — ВЕРХНЯЯ граница: очередь в стакане не моделируется.\n` +
  `   · «итого» относится только к сделкам, которые состоялись бы.\n` +
  `   · «отбор» — главная строка. Если пропущенные системно ЛУЧШЕ\n` +
  `     исполнившихся (и ДИ не перекрываются), выигрыш в цене фиктивен:\n` +
  `     мейкер отбирает себе худшие сделки. Перекрывающиеся ДИ = данных мало,\n` +
  `     а не «отбора нет».\n`,
);
