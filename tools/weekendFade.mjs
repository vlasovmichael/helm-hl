#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  weekendFade — hip3-weekend-overshoot-2026-09: перелетает ли перп HIP-3 за выходные
//
//  Предзаявка 2026-09-23, до первого взгляда на выходные в venue_snapshots.
//  Правило, вселенная, издержки, стоп-правило и оценка заморожены здесь и в реестре.
//
//  Событие: рынок из UNIVERSE, выходные после PREREG_AT. Ход выходных
//  m = ln(мид перед открытием / мид после закрытия пятницы), бп; событие при |m| ≥ 100.
//  Сделка против хода: вход по миду за час до открытия базового рынка, выход по
//  миду через час после открытия. Издержки: половина impact-спреда на входе и на
//  выходе плюс две тейкерские комиссии площадки.
//
//  Стоп-правило: ≥ 20 выходных с момента предзаявки И ≥ 40 событий; срок 2027-06-30,
//  не набралось — INCONCLUSIVE. До стоп-правила печатается только счётчик.
//
//  Порог (всё сразу):
//    1. среднее нетто на событие ≥ +20 бп;
//    2. CI95 бутстрапа по выходным (10 000, сид 20260923) целиком выше нуля;
//    3. без нефти (CL, BRENTOIL) среднее нетто > 0;
//    4. без трёх выходных с наибольшим вкладом среднее нетто > 0;
//    5. случайная сторона на тех же событиях (10 000 перестановок по выходным,
//       сид 20260923): доля перестановок со средним ≥ факта < 0.05.
//  Отдельно печатается среднее при стандартной комиссии 9 бп на всех рынках.
//
//  Запуск: node tools/weekendFade.mjs          оценка, если стоп-правило выполнено
//          node tools/weekendFade.mjs --count  только счётчик
// ─────────────────────────────────────────────────────────────────────────────
import { rng } from "./baseline.mjs";

export const HYPOTHESIS_ID = "hip3-weekend-overshoot-2026-09";
export const PREREG_AT = Date.parse("2026-09-23T22:00:00Z");
export const DEADLINE = Date.parse("2027-06-30T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RULE = Object.freeze({
  minMoveBp: 100,
  minWeekends: 20,
  minEvents: 40,
  minMeanNetBp: 20,
  iters: 10_000,
  seed: 20260923,
  growthTakerBp: 0.9,
  standardTakerBp: 9,
});

// Когда рынок закрывается в пятницу и открывается после выходных, по местному времени.
const SESSIONS = Object.freeze({
  futures: { tz: "America/New_York", close: [5, 17, 0], open: [0, 18, 0] },
  us: { tz: "America/New_York", close: [5, 16, 0], open: [1, 9, 30] },
  korea: { tz: "Asia/Seoul", close: [5, 15, 30], open: [1, 9, 0] },
});

// Вселенная заморожена по среднему OI ≥ $20M на момент предзаявки; индексы и
// рынки с неясным базовым активом исключены.
export const UNIVERSE = Object.freeze({
  "xyz:GOLD": "futures", "xyz:SILVER": "futures", "xyz:CL": "futures",
  "xyz:BRENTOIL": "futures", "xyz:JPY": "futures", "xyz:EUR": "futures",
  "xyz:MU": "us", "xyz:SNDK": "us", "xyz:NVDA": "us", "xyz:GOOGL": "us",
  "xyz:AAPL": "us", "xyz:CRCL": "us", "xyz:HOOD": "us", "xyz:INTC": "us",
  "xyz:TSLA": "us", "xyz:MSTR": "us", "xyz:META": "us", "xyz:AMZN": "us",
  "xyz:MSFT": "us", "xyz:ORCL": "us", "xyz:NBIS": "us",
  "xyz:SKHX": "korea", "xyz:SMSN": "korea",
});

const OIL = new Set(["xyz:CL", "xyz:BRENTOIL"]);
// Не входят в growth mode по правилам площадки.
const STANDARD_FEE = new Set(["xyz:GOLD", "xyz:MSTR"]);

// Выходные, где пятница или понедельник — праздник базового рынка (суббота, UTC-дата).
const SKIP = Object.freeze({
  futures: ["2026-11-28", "2026-12-26", "2027-01-02", "2027-01-16", "2027-02-13", "2027-03-27", "2027-05-29", "2027-06-19"],
  us: ["2026-11-28", "2026-12-26", "2027-01-02", "2027-01-16", "2027-02-13", "2027-03-27", "2027-05-29", "2027-06-19"],
  korea: ["2026-09-26", "2026-10-10", "2026-12-26", "2027-01-02", "2027-02-06", "2027-02-27"],
});

/** Смещение часового пояса в мс для момента t. */
function tzOffset(t, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(t).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Местное время дня (y, m, d, hh, mm) в поясе tz → UTC мс. */
function localToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
}

/** Закрытие пятницы и открытие для выходных, начинающихся в субботу sat (UTC-полночь). */
export function weekendTimes(sat, session) {
  const s = SESSIONS[session];
  const at = (dayOffset, [, hh, mm]) => {
    const d = new Date(sat + dayOffset * DAY);
    return localToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, s.tz);
  };
  return { close: at(-1, s.close), open: at(s.open[0] === 0 ? 1 : 2, s.open) };
}

const floorHour = (t) => Math.floor(t / HOUR) * HOUR;
const ceilHour = (t) => Math.ceil(t / HOUR) * HOUR;

/**
 * События без результата: только то, что нужно счётчику.
 * snaps — строки venue_snapshots {ts, dex, coin, mid, spread_bp}.
 */
export function buildEvents(snaps, now = Date.now()) {
  const byKey = new Map();
  for (const r of snaps) {
    const coin = r.coin?.includes(":") ? r.coin : `${r.dex}:${r.coin}`;
    if (!UNIVERSE[coin] || !(r.mid > 0)) continue;
    byKey.set(`${coin}|${r.ts}`, r);
  }
  const events = [];
  const firstSat = Math.ceil((PREREG_AT - 2 * DAY) / (7 * DAY)) * 7 * DAY + 2 * DAY;
  for (let sat = firstSat; sat < now; sat += 7 * DAY) {
    const weekend = new Date(sat).toISOString().slice(0, 10);
    for (const [coin, session] of Object.entries(UNIVERSE)) {
      if (SKIP[session].includes(weekend)) continue;
      const { close, open } = weekendTimes(sat, session);
      if (open <= PREREG_AT) continue;
      const exitAt = ceilHour(open) + HOUR;
      if (exitAt + HOUR > now) continue;
      const fri = byKey.get(`${coin}|${ceilHour(close)}`);
      const pre = byKey.get(`${coin}|${floorHour(open) - HOUR}`);
      const exit = byKey.get(`${coin}|${exitAt}`);
      if (!fri || !pre || !exit) continue;
      const moveBp = Math.log(pre.mid / fri.mid) * 1e4;
      if (Math.abs(moveBp) < RULE.minMoveBp) continue;
      events.push({ coin, weekend, t: open, moveBp, pre, exit });
    }
  }
  return events;
}

/** Нетто события в бп. feeBp — тейкерская комиссия на одну сторону. */
export function eventNet(e, feeBp) {
  const side = -Math.sign(e.moveBp);
  const gross = side * Math.log(e.exit.mid / e.pre.mid) * 1e4;
  const spread = ((e.pre.spread_bp ?? 0) + (e.exit.spread_bp ?? 0)) / 2;
  return gross - spread - 2 * feeBp;
}

const feeFor = (coin) => (STANDARD_FEE.has(coin) ? RULE.standardTakerBp : RULE.growthTakerBp);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

export function stopRuleMet(events, now = Date.now()) {
  const eventWeekends = new Set(events.map((e) => e.weekend)).size;
  const elapsed = Math.floor((now - PREREG_AT) / (7 * DAY));
  return { weekends: elapsed, eventWeekends, events: events.length,
    met: elapsed >= RULE.minWeekends && events.length >= RULE.minEvents };
}

export function evaluate(events) {
  const rows = events.map((e) => ({ ...e, net: eventNet(e, feeFor(e.coin)) }));
  const byWeekend = new Map();
  for (const r of rows) {
    if (!byWeekend.has(r.weekend)) byWeekend.set(r.weekend, []);
    byWeekend.get(r.weekend).push(r);
  }
  const groups = [...byWeekend.values()];
  const rand = rng(RULE.seed);

  const boot = [];
  for (let i = 0; i < RULE.iters; i++) {
    const sample = [];
    for (let k = 0; k < groups.length; k++) sample.push(...groups[Math.floor(rand() * groups.length)]);
    boot.push(mean(sample.map((r) => r.net)));
  }
  boot.sort((a, b) => a - b);
  const ci = { lo: boot[Math.floor(RULE.iters * 0.025)], hi: boot[Math.floor(RULE.iters * 0.975)] };

  const netMean = mean(rows.map((r) => r.net));
  const noOil = mean(rows.filter((r) => !OIL.has(r.coin)).map((r) => r.net));
  const top3 = new Set(groups
    .map((g) => ({ w: g[0].weekend, sum: g.reduce((s, r) => s + r.net, 0) }))
    .sort((a, b) => b.sum - a.sum).slice(0, 3).map((x) => x.w));
  const noTop3 = mean(rows.filter((r) => !top3.has(r.weekend)).map((r) => r.net));

  // Случайная сторона: знак сделки переворачивается целым выходным, издержки те же.
  const legs = groups.map((g) => g.map((r) => {
    const cost = ((r.pre.spread_bp ?? 0) + (r.exit.spread_bp ?? 0)) / 2 + 2 * feeFor(r.coin);
    return { gross: r.net + cost, cost };
  }));
  let atLeast = 0;
  for (let i = 0; i < RULE.iters; i++) {
    let s = 0;
    for (const g of legs) {
      const flip = rand() < 0.5 ? -1 : 1;
      for (const x of g) s += flip * x.gross - x.cost;
    }
    if (s / rows.length >= netMean) atLeast++;
  }
  const pSide = atLeast / RULE.iters;

  const checks = [
    { label: `среднее нетто ≥ +${RULE.minMeanNetBp} бп`, pass: netMean >= RULE.minMeanNetBp },
    { label: "CI95 по выходным выше нуля", pass: ci.lo > 0 },
    { label: "без нефти среднее > 0", pass: noOil > 0 },
    { label: "без трёх лучших выходных среднее > 0", pass: noTop3 > 0 },
    { label: "случайная сторона p < 0.05", pass: pSide < 0.05 },
  ];
  return {
    n: rows.length, weekends: groups.length, netMean, ci, noOil, noTop3, pSide,
    netStandardFee: mean(rows.map((r) => eventNet(r, RULE.standardTakerBp))),
    checks, verdict: checks.every((c) => c.pass) ? "PASSED_ECONOMICS" : "REJECTED",
  };
}

const runDirectly = process.argv[1] && process.argv[1].endsWith("weekendFade.mjs");
if (runDirectly) {
  const { initDB, getVenueSnapshots } = await import("../src/core/database.js");
  initDB();
  const events = buildEvents(getVenueSnapshots(PREREG_AT - 7 * DAY));
  const stop = stopRuleMet(events);
  console.log(`выходных с предзаявки ${stop.weekends}/${RULE.minWeekends}, событий ${stop.events}/${RULE.minEvents}`);
  if (process.argv.includes("--count")) process.exit(0);
  if (!stop.met && Date.now() < DEADLINE) {
    console.log("стоп-правило не выполнено: результат не печатается");
    process.exit(0);
  }
  if (!stop.met) {
    console.log("срок вышел, стоп-правило не выполнено → INCONCLUSIVE");
    process.exit(0);
  }
  const r = evaluate(events);
  console.log(`событий ${r.n}, выходных ${r.weekends}`);
  console.log(`среднее нетто ${r.netMean.toFixed(2)} бп, CI95 [${r.ci.lo.toFixed(2)}; ${r.ci.hi.toFixed(2)}]`);
  console.log(`без нефти ${r.noOil.toFixed(2)} бп, без трёх лучших выходных ${r.noTop3.toFixed(2)} бп, случайная сторона p=${r.pSide.toFixed(4)}`);
  console.log(`при комиссии 9 бп на всех рынках: ${r.netStandardFee.toFixed(2)} бп`);
  for (const c of r.checks) console.log(`${c.pass ? "да " : "нет"} ${c.label}`);
  console.log(`вердикт: ${r.verdict}`);
}
