// ─────────────────────────────────────────────────
//  level-bounce-page — ретро отскока от зоны страницы levels на корпусе Э1
//  Binance UM 15m 2021–2025.
//
//  Предзаявка: data/hypotheses/registry.json, id level-bounce-page, записана
//  до чтения корпуса. Зоны — levelZones() страницы, план — readPrice() и
//  planFromZone(), исход — simulate() живого журнала: ретро и страница не
//  расходятся формулами.
//  Решение: провал любого гейта = REJECTED, без переформулировки.
//  Стоп-правило: один прогон; n<300 или <100 дней = INCONCLUSIVE.
//  --synthetic: случайное блуждание, где у зон нет смысла; разница с плацебо
//  обязана накрывать ноль, иначе контроль кривой.
// ─────────────────────────────────────────────────

import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { clusterBootstrap, dailySeries, segmentBars } from "./fvgE5Audit.mjs";
import { overfittingMeasures } from "./harness.mjs";
import { rng } from "./baseline.mjs";
import { levelZones, thinCorridors } from "../src/modules/dashboard/routes/levelZones.js";
import { readPrice, simulate } from "../src/modules/dashboard/web/src/features/levelMath.js";

const BAR_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const FROM = Date.UTC(2021, 0, 1);
const TO_EXCLUSIVE = Date.UTC(2026, 0, 1);
const HOLDOUT_FROM = Date.UTC(2024, 0, 1);

export const RULE = Object.freeze({
  strideBars: 4,
  horizon15m: 96,
  placeboMin: 0.5,
  placeboMax: 2,
});

export const CONFIG = Object.freeze({
  bootstrapIterations: 2_000,
  bootstrapSeed: 2_026_092_501,
  placeboSeed: 2_026_092_502,
  dsrThreshold: 0.95,
  dsrTrials: 3,
  minTrades: 300,
  minDays: 100,
  target: "1h",
});

// Окна те же, что у страницы на её ТФ.
export const FRAMES = Object.freeze([
  Object.freeze({ id: "15m", per: 1, window: 288 }),
  Object.freeze({ id: "1h", per: 4, window: 480 }),
  Object.freeze({ id: "4h", per: 16, window: 360 }),
]);

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** Полные бары старшего ТФ с объёмом и индекс последнего 15m-бара каждого. */
export function aggregate(bars, per) {
  const span = per * BAR_MS;
  const higher = [];
  const ends = [];
  let index = 0;
  while (index < bars.length) {
    const key = Math.floor(bars[index].t / span);
    let last = index;
    while (last + 1 < bars.length && Math.floor(bars[last + 1].t / span) === key) last++;
    if (last - index + 1 === per) {
      let high = -Infinity;
      let low = Infinity;
      let vol = 0;
      for (let j = index; j <= last; j++) {
        if (bars[j].h > high) high = bars[j].h;
        if (bars[j].l < low) low = bars[j].l;
        vol += bars[j].v;
      }
      higher.push({ time: bars[index].t, open: bars[index].o, high, low, close: bars[last].c, vol });
      ends.push(last);
    }
    index = last + 1;
  }
  return { higher, ends };
}

const scenarioOf = (plan) => ({
  kind: "bounce",
  side: plan.side,
  entry: plan.entry,
  stop: plan.stop,
  target: plan.target,
  atMarket: plan.atMarket,
});

/** Плацебо: та же сторона и те же расстояния до стопа и цели, вход на случайном уровне дальше от цены. */
export function placeboOf(sc, price, random) {
  const dist = Math.abs(price - sc.entry);
  if (sc.atMarket || !(dist > 0)) return null;
  const sign = sc.side === "long" ? -1 : 1;
  const entry = price + sign * dist * (RULE.placeboMin + (RULE.placeboMax - RULE.placeboMin) * random());
  return { ...sc, entry, stop: entry + (sc.stop - sc.entry), target: entry + (sc.target - sc.entry) };
}

function btcRegime(btcCloses, time) {
  const recent = btcCloses?.get(time - BAR_MS);
  const old = btcCloses?.get(time - BAR_MS - 96 * BAR_MS);
  if (recent == null || old == null) return null;
  return recent > old ? "btc_up" : "btc_down";
}

const usable = (plan) => plan && !plan.incomplete && !plan.tooTight;

/** Все разборы одного сегмента: основная когорта и все отскоки с плацебо. */
export function readSegment(symbol, bars, frame, btcCloses, random) {
  const { higher, ends } = aggregate(bars, frame.per);
  const low15 = bars.map((b) => ({ time: b.t, high: b.h, low: b.l, close: b.c }));
  const primary = [];
  const touches = [];
  let busyUntil = -1;
  for (let k = frame.window - 1; k < higher.length; k += RULE.strideBars) {
    const after = ends[k] + 1;
    if (after + RULE.horizon15m > bars.length) break;
    const window = higher.slice(k - frame.window + 1, k + 1);
    const zoned = levelZones(window);
    const data = {
      ...zoned,
      candles: window,
      thin: thinCorridors(zoned.profile.bins, zoned.profile.step),
    };
    const read = readPrice(data);
    if (read.kind === "empty") continue;
    const time = bars[after].t;
    const base = {
      symbol,
      entryTime: time,
      day: Math.floor(time / DAY_MS),
      holdout: time >= HOLDOUT_FROM,
      regime: btcRegime(btcCloses, time),
    };
    const path = low15.slice(after, after + RULE.horizon15m);

    // Вопрос 1: держит ли зона лучше случайного уровня той же геометрии.
    for (const plan of [read.long, read.short]) {
      if (!usable(plan)) continue;
      const sc = scenarioOf(plan);
      const placebo = placeboOf(sc, data.price, random);
      if (!placebo) continue;
      const real = simulate(sc, path, RULE.horizon15m);
      const fake = simulate(placebo, path, RULE.horizon15m);
      touches.push({
        ...base,
        side: sc.side,
        real: real.triggered && Number.isFinite(real.r) ? real.r : null,
        placebo: fake.triggered && Number.isFinite(fake.r) ? fake.r : null,
      });
    }

    // Вопрос 2: план, который страница предлагает у зоны и считает годным.
    const auto = read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null;
    if (!auto || !usable(auto) || !auto.ok || after <= busyUntil) continue;
    const outcome = simulate(scenarioOf(auto), path, RULE.horizon15m);
    if (!outcome.triggered || !Number.isFinite(outcome.r)) continue;
    busyUntil = after + outcome.bar;
    primary.push({
      ...base,
      side: auto.side,
      atMarket: auto.atMarket,
      riskPct: auto.riskPct,
      netRr: auto.netRr,
      rNet: outcome.r,
      why: outcome.how,
    });
  }
  return { primary, touches };
}

/** Суммы касаний по дням: миллионы строк в памяти не держим. */
export function foldTouches(byDay, rows) {
  for (const row of rows) {
    if (!byDay.has(row.day)) byDay.set(row.day, { holdout: row.holdout, rs: 0, rn: 0, ps: 0, pn: 0 });
    const d = byDay.get(row.day);
    if (row.real != null) {
      d.rs += row.real;
      d.rn++;
    }
    if (row.placebo != null) {
      d.ps += row.placebo;
      d.pn++;
    }
  }
  return byDay;
}

/** CI95 разности средних «зона − плацебо» с кластерами-днями. */
export function differenceBootstrap(days, iterations, seed) {
  const random = rng(seed);
  const estimates = [];
  for (let i = 0; i < iterations; i++) {
    let rs = 0, rn = 0, ps = 0, pn = 0;
    for (let j = 0; j < days.length; j++) {
      const d = days[Math.floor(random() * days.length)];
      rs += d.rs;
      rn += d.rn;
      ps += d.ps;
      pn += d.pn;
    }
    estimates.push(rs / rn - ps / pn);
  }
  estimates.sort((a, b) => a - b);
  const total = days.reduce((a, d) => ({ rs: a.rs + d.rs, rn: a.rn + d.rn, ps: a.ps + d.ps, pn: a.pn + d.pn }), { rs: 0, rn: 0, ps: 0, pn: 0 });
  return {
    mean: total.rs / total.rn - total.ps / total.pn,
    lo: estimates[Math.floor(iterations * 0.025)],
    hi: estimates[Math.floor(iterations * 0.975)],
    real: { n: total.rn, mean: total.rs / total.rn },
    placebo: { n: total.pn, mean: total.ps / total.pn },
    clusters: days.length,
  };
}

function summarize(trades) {
  if (!trades.length) return { n: 0, mean: null };
  return {
    n: trades.length,
    mean: mean(trades.map((t) => t.rNet)),
    winRate: trades.filter((t) => t.rNet > 0).length / trades.length,
    targets: trades.filter((t) => t.why === "target").length / trades.length,
    stops: trades.filter((t) => t.why === "stop").length / trades.length,
  };
}

function withCi(trades) {
  if (trades.length < 2) return { ...summarize(trades), ci95: null };
  const ci = clusterBootstrap(trades.map((t) => t.rNet), trades.map((t) => t.day), CONFIG.bootstrapIterations, CONFIG.bootstrapSeed);
  return { ...summarize(trades), ci95: ci };
}

function annualSharpe(series) {
  const average = mean(series);
  const variance = series.reduce((sum, value) => sum + (value - average) ** 2, 0) / series.length;
  return variance > 0 ? (average / Math.sqrt(variance)) * Math.sqrt(365) : 0;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

async function readZip(path) {
  const child = spawn("unzip", ["-p", path], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const rows = [];
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (!/^\d/.test(line)) continue;
    const f = line.split(",");
    const row = { t: Number(f[0]), o: Number(f[1]), h: Number(f[2]), l: Number(f[3]), c: Number(f[4]), v: Number(f[5]) };
    if (!Object.values(row).every(Number.isFinite)) throw new Error(`нечисловое klines в ${path}`);
    if (row.t >= FROM && row.t < TO_EXCLUSIVE) rows.push(row);
  }
  if ((await exit) !== 0) throw new Error(`unzip ${path} завершился с ошибкой`);
  return rows;
}

async function loadSymbol(files, verification) {
  const rows = [];
  for (const file of files) {
    const size = statSync(file.rawPath).size;
    if (size !== file.bytes) throw new Error(`${file.rawPath}: размер ${size}, ожидался ${file.bytes}`);
    if ((await sha256File(file.rawPath)) !== file.sha256) throw new Error(`${file.rawPath}: SHA-256 не совпал`);
    verification.files++;
    rows.push(...await readZip(file.rawPath));
  }
  return segmentBars(rows);
}

/** Случайное блуждание 15m с объёмом: у зон на нём нет смысла, у контроля не должно быть сдвига. */
export function syntheticSymbols(count, days, seed) {
  const random = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random());
  const out = [];
  for (let s = 0; s < count; s++) {
    let price = 100;
    const bars = [];
    for (let i = 0; i < days * 96; i++) {
      const o = price;
      const c = o * Math.exp(0.004 * gauss());
      const h = Math.max(o, c) * (1 + Math.abs(0.002 * gauss()));
      const l = Math.min(o, c) * (1 - Math.abs(0.002 * gauss()));
      bars.push({ t: FROM + i * BAR_MS, o, h, l, c, v: 1000 * (0.5 + random()) });
      price = c;
    }
    out.push({ symbol: `SYN${s}`, segments: [bars] });
  }
  return out;
}

async function* corpus(dataDir, verification) {
  const manifest = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8"));
  const supplement = manifest.supplement ? JSON.parse(readFileSync(manifest.supplement.path, "utf8")) : { files: [] };
  const bySymbol = new Map();
  for (const file of [...manifest.files, ...(supplement.files ?? [])]) {
    if (!bySymbol.has(file.symbol)) bySymbol.set(file.symbol, []);
    bySymbol.get(file.symbol).push(file);
  }
  const btc = await loadSymbol(bySymbol.get("BTCUSDT"), verification);
  yield { btc, count: bySymbol.size, archiveSetSha256: manifest.archiveSetSha256 };
  for (const symbol of [...bySymbol.keys()].sort()) {
    const loaded = symbol === "BTCUSDT" ? btc : await loadSymbol(bySymbol.get(symbol), verification);
    yield { symbol, segments: loaded.segments };
  }
}

async function audit({ dataDir, outputPath, synthetic }) {
  const verification = { files: 0 };
  const random = rng(CONFIG.placeboSeed);
  const primary = Object.fromEntries(FRAMES.map((f) => [f.id, []]));
  const touches = Object.fromEntries(FRAMES.map((f) => [f.id, new Map()]));
  let btcCloses = null;
  let meta = {};
  const source = synthetic
    ? (async function* () {
      yield { count: 40 };
      for (const s of syntheticSymbols(40, 730, 7)) yield s;
    })()
    : corpus(dataDir, verification);

  let done = 0;
  for await (const item of source) {
    if (!item.symbol) {
      meta = { symbols: item.count, archiveSetSha256: item.archiveSetSha256 ?? null };
      if (item.btc) btcCloses = new Map(item.btc.segments.flat().map((bar) => [bar.t, bar.c]));
      continue;
    }
    for (const frame of FRAMES) {
      for (const segment of item.segments) {
        const result = readSegment(item.symbol, segment, frame, btcCloses, random);
        primary[frame.id].push(...result.primary);
        foldTouches(touches[frame.id], result.touches);
      }
    }
    done++;
    if (done % 25 === 1) process.stderr.write(`${done}/${meta.symbols} ${item.symbol} 1h n=${primary["1h"].length}\n`);
  }

  const target = primary[CONFIG.target];
  const full = withCi(target);
  const holdout = withCi(target.filter((t) => t.holdout));
  const development = withCi(target.filter((t) => !t.holdout));
  const regimes = Object.fromEntries(["btc_up", "btc_down"].map((r) => [r, summarize(target.filter((t) => t.regime === r))]));
  const targetDays = [...touches[CONFIG.target].values()];
  const zoneVsPlacebo = differenceBootstrap(targetDays, CONFIG.bootstrapIterations, CONFIG.bootstrapSeed);
  const holdoutDays = targetDays.filter((d) => d.holdout);
  const zoneVsPlaceboHoldout = holdoutDays.length ? differenceBootstrap(holdoutDays, CONFIG.bootstrapIterations, CONFIG.bootstrapSeed) : null;

  const series = FRAMES.map((f) => dailySeries(primary[f.id], FROM, TO_EXCLUSIVE));
  const sharpes = series.map(annualSharpe);
  const sharpeMean = mean(sharpes);
  const sharpeVariance = sharpes.reduce((sum, v) => sum + (v - sharpeMean) ** 2, 0) / (sharpes.length - 1);
  const targetColumn = FRAMES.findIndex((f) => f.id === CONFIG.target);
  const dsr = overfittingMeasures({ dsr: [{
    id: "level-bounce-N3",
    inputs: { sharpeVariance, periodsPerYear: 365, independentTrials: CONFIG.dsrTrials },
    source: { returns: series[targetColumn] },
  }] }).dsr;
  const dsrProbability = dsr.included[0]?.result?.probability ?? null;

  const gates = {
    netClusterCiPositive: full.ci95 != null && full.mean > 0 && full.ci95.lo > 0,
    holdoutCiPositive: holdout.ci95 != null && holdout.mean > 0 && holdout.ci95.lo > 0,
    bothBtcRegimesPositive: regimes.btc_up.mean > 0 && regimes.btc_down.mean > 0,
    zoneBeatsPlacebo: zoneVsPlacebo.lo > 0,
    dsr: dsrProbability != null && dsrProbability >= CONFIG.dsrThreshold,
  };
  const enough = target.length >= CONFIG.minTrades && (full.ci95?.clusters ?? 0) >= CONFIG.minDays;
  const verdict = !enough ? "INCONCLUSIVE" : Object.values(gates).every(Boolean) ? "PASSED_ECONOMICS" : "REJECTED";

  const byYear = Object.fromEntries([2021, 2022, 2023, 2024, 2025].map((y) => [
    y, summarize(target.filter((t) => new Date(t.entryTime).getUTCFullYear() === y)),
  ]));
  const bySide = Object.fromEntries(["long", "short"].map((s) => [s, summarize(target.filter((t) => t.side === s))]));
  const byEntry = {
    atMarket: summarize(target.filter((t) => t.atMarket)),
    limit: summarize(target.filter((t) => !t.atMarket)),
  };
  const report = {
    id: synthetic ? "level-bounce-page:synthetic" : "level-bounce-page",
    ranAt: new Date().toISOString(),
    rule: RULE,
    config: CONFIG,
    corpus: { ...meta, filesVerified: verification.files, synthetic: Boolean(synthetic) },
    target: {
      ...full,
      development,
      holdout,
      regimes,
      bySide,
      byEntry,
      byYear,
      medianRiskPct: [...target.map((t) => t.riskPct)].sort((a, b) => a - b)[Math.floor(target.length / 2)] ?? null,
    },
    zoneVsPlacebo,
    zoneVsPlaceboHoldout,
    frames: Object.fromEntries(FRAMES.map((f, i) => [f.id, {
      ...summarize(primary[f.id]),
      sharpe: sharpes[i],
      zoneVsPlacebo: differenceBootstrap([...touches[f.id].values()], 500, CONFIG.bootstrapSeed),
    }])),
    dsr: { sharpeVariance, independentTrials: CONFIG.dsrTrials, probability: dsrProbability },
    gates,
    verdict,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    verdict,
    gates,
    n: target.length,
    mean: full.mean,
    ci: full.ci95 && [full.ci95.lo, full.ci95.hi],
    holdout: { n: holdout.n, mean: holdout.mean, ci: holdout.ci95 && [holdout.ci95.lo, holdout.ci95.hi] },
    zoneVsPlacebo: { mean: zoneVsPlacebo.mean, ci: [zoneVsPlacebo.lo, zoneVsPlacebo.hi], real: zoneVsPlacebo.real, placebo: zoneVsPlacebo.placebo },
    regimes,
    dsrProbability,
  }, null, 2)}\n`);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const synthetic = process.argv.includes("--synthetic");
  await audit({
    dataDir: arg("data", "data/binance-f2"),
    outputPath: arg("out", synthetic ? "logs/level-bounce-synthetic.json" : "docs/edge-search/level-bounce-audit.json"),
    synthetic,
  });
}
