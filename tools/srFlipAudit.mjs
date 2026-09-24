// ─────────────────────────────────────────────────
//  sr-flip-retest-1h — ретро на корпусе Э1 Binance UM 15m 2021–2025.
//
//  Предзаявка: data/hypotheses/registry.json, id sr-flip-retest-1h,
//  зафиксирована 2026-09-24T11:10:15Z до чтения корпуса. Правило уровня —
//  фрактал страницы levels (крыло 5 баров), зона ±0.175·ATR, буфер 0.25·ATR.
//  Решение: провал любого из пяти гейтов = REJECTED, без переформулировки.
//  Стоп-правило: один прогон; n<300 или <100 дней = INCONCLUSIVE.
// ─────────────────────────────────────────────────

import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { clusterBootstrap, dailySeries, firstStrictCross, segmentBars } from "./fvgE5Audit.mjs";
import { overfittingMeasures } from "./harness.mjs";

const BAR_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const FROM = Date.UTC(2021, 0, 1);
const TO_EXCLUSIVE = Date.UTC(2026, 0, 1);

export const RULE = Object.freeze({
  wing: 5,
  atrPeriod: 14,
  breakAtr: 0.25,
  halfZoneAtr: 0.175,
  bufferAtr: 0.25,
  breakWithin: 480,
  retestBars: 48,
  timeoutBars: 24,
  rr: 2,
  minRiskFraction: 0.0015,
  costPct: 0.0864,
  costPctShown: 0.20,
});

export const CONFIG = Object.freeze({
  bootstrapIterations: 10_000,
  bootstrapSeed: 2_026_092_401,
  dsrThreshold: 0.95,
  dsrTrials: 3,
  minTrades: 300,
  minDays: 100,
  target: "1h",
});

export const FRAMES = Object.freeze([
  Object.freeze({ id: "15m", per: 1 }),
  Object.freeze({ id: "1h", per: 4 }),
  Object.freeze({ id: "4h", per: 16 }),
]);

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Полные бары старшего ТФ внутри непрерывного сегмента и индекс последнего 15m-бара каждого. */
export function aggregate(bars, per) {
  if (per === 1) return { higher: bars, ends: bars.map((_, index) => index) };
  const span = per * BAR_MS;
  const higher = [];
  const ends = [];
  let index = 0;
  while (index < bars.length) {
    const key = Math.floor(bars[index].t / span);
    let last = index;
    while (last + 1 < bars.length && Math.floor(bars[last + 1].t / span) === key) last++;
    if (last - index + 1 === per) {
      let h = -Infinity;
      let l = Infinity;
      for (let j = index; j <= last; j++) {
        if (bars[j].h > h) h = bars[j].h;
        if (bars[j].l < l) l = bars[j].l;
      }
      higher.push({ t: bars[index].t, o: bars[index].o, h, l, c: bars[last].c });
      ends.push(last);
    }
    index = last + 1;
  }
  return { higher, ends };
}

function isFractal(higher, i, wing, side) {
  for (let j = i - wing; j <= i + wing; j++) {
    if (j === i) continue;
    if (side === "LONG" ? higher[j].h >= higher[i].h : higher[j].l <= higher[i].l) return false;
  }
  return true;
}

function atrAt(higher, k, period) {
  let sum = 0;
  for (let j = k - period + 1; j <= k; j++) sum += higher[j].h - higher[j].l;
  return sum / period;
}

/** Исход сделки в R; null, если до таймаута не хватило баров. */
export function simulate(bars, from, side, entry, riskFraction, rr, maxh) {
  const stop = side === "LONG" ? entry * (1 - riskFraction) : entry * (1 + riskFraction);
  const target = side === "LONG" ? entry * (1 + rr * riskFraction) : entry * (1 - rr * riskFraction);
  const last = from + maxh;
  if (last > bars.length - 1) return null;
  for (let index = from; index <= last; index++) {
    const hitStop = side === "LONG" ? bars[index].l <= stop : bars[index].h >= stop;
    const hitTarget = side === "LONG" ? bars[index].h >= target : bars[index].l <= target;
    if (hitStop) return { r: -1, why: "stop", exit: index };
    if (hitTarget) return { r: rr, why: "target", exit: index };
  }
  const move = side === "LONG" ? bars[last].c - entry : entry - bars[last].c;
  return { r: move / (entry * riskFraction), why: "timeout", exit: last };
}

function costR(riskFraction, pct) {
  return (pct / 100) / riskFraction;
}

function baselineExpectation(bars, start, until, side, riskFraction, maxh) {
  let sum = 0;
  let count = 0;
  for (let index = start; index <= until; index++) {
    const outcome = simulate(bars, index + 1, side, bars[index].c, riskFraction, RULE.rr, maxh);
    if (!outcome) continue;
    sum += outcome.r - costR(riskFraction, RULE.costPct);
    count++;
  }
  return count ? sum / count : null;
}

function btcRegime(btcCloses, entryTime) {
  const recent = btcCloses?.get(entryTime - BAR_MS);
  const old = btcCloses?.get(entryTime - BAR_MS - 96 * BAR_MS);
  if (recent == null || old == null) return null;
  return recent > old ? "btc_up" : "btc_down";
}

/** Все сделки правила на одном непрерывном сегменте 15m. */
export function findTrades(symbol, bars, frame, btcCloses, { baseline = false } = {}) {
  const diagnostics = { levels: 0, breakouts: 0, tooTight: 0, fills: 0, incomplete: 0, overlap: 0 };
  const { higher, ends } = aggregate(bars, frame.per);
  const retest = RULE.retestBars * frame.per;
  const maxh = RULE.timeoutBars * frame.per;
  const candidates = [];
  if (higher.length < RULE.atrPeriod + 2 * RULE.wing + 2) return { trades: [], diagnostics };

  for (let i = RULE.wing; i < higher.length - RULE.wing; i++) {
    for (const side of ["LONG", "SHORT"]) {
      if (!isFractal(higher, i, RULE.wing, side)) continue;
      diagnostics.levels++;
      const level = side === "LONG" ? higher[i].h : higher[i].l;
      const lastK = Math.min(i + RULE.breakWithin, higher.length - 1);
      let k = -1;
      let atr = 0;
      for (let j = Math.max(i + RULE.wing + 1, RULE.atrPeriod - 1); j <= lastK; j++) {
        const a = atrAt(higher, j, RULE.atrPeriod);
        if (side === "LONG" ? higher[j].c > level + RULE.breakAtr * a : higher[j].c < level - RULE.breakAtr * a) {
          k = j;
          atr = a;
          break;
        }
      }
      if (k < 0 || !(atr > 0)) continue;
      diagnostics.breakouts++;
      const entry = side === "LONG" ? level + RULE.halfZoneAtr * atr : level - RULE.halfZoneAtr * atr;
      const stop = side === "LONG"
        ? level - (RULE.halfZoneAtr + RULE.bufferAtr) * atr
        : level + (RULE.halfZoneAtr + RULE.bufferAtr) * atr;
      const riskFraction = Math.abs(entry - stop) / entry;
      if (riskFraction < RULE.minRiskFraction) {
        diagnostics.tooTight++;
        continue;
      }
      const start = ends[k] + 1;
      const until = Math.min(start + retest - 1, bars.length - 1);
      if (start > until) continue;
      const crossing = firstStrictCross(bars, start, until, side, entry);
      if (crossing.index < 0) continue;
      diagnostics.fills++;
      candidates.push({ side, entry, riskFraction, fill: crossing.index, start, until });
    }
  }

  candidates.sort((left, right) => left.fill - right.fill);
  const busyUntil = { LONG: -1, SHORT: -1 };
  const trades = [];
  for (const c of candidates) {
    if (c.fill <= busyUntil[c.side]) {
      diagnostics.overlap++;
      continue;
    }
    const outcome = simulate(bars, c.fill, c.side, c.entry, c.riskFraction, RULE.rr, maxh);
    if (!outcome) {
      diagnostics.incomplete++;
      continue;
    }
    busyUntil[c.side] = outcome.exit;
    const entryTime = bars[c.fill].t;
    trades.push({
      symbol,
      entryTime,
      day: Math.floor(entryTime / DAY_MS),
      year: new Date(entryTime).getUTCFullYear(),
      side: c.side,
      riskFraction: c.riskFraction,
      r: outcome.r,
      rNet: outcome.r - costR(c.riskFraction, RULE.costPct),
      rNet20: outcome.r - costR(c.riskFraction, RULE.costPctShown),
      why: outcome.why,
      regime: btcRegime(btcCloses, entryTime),
      baselineNet: baseline
        ? baselineExpectation(bars, c.start, c.until, c.side, c.riskFraction, maxh)
        : null,
    });
  }
  return { trades, diagnostics };
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
    const row = { t: Number(f[0]), o: Number(f[1]), h: Number(f[2]), l: Number(f[3]), c: Number(f[4]) };
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

function summarize(trades, key = "rNet") {
  if (!trades.length) return { n: 0, mean: null };
  return {
    n: trades.length,
    mean: mean(trades.map((trade) => trade[key])),
    grossMean: mean(trades.map((trade) => trade.r)),
    winRate: trades.filter((trade) => trade[key] > 0).length / trades.length,
    targets: trades.filter((trade) => trade.why === "target").length / trades.length,
  };
}

function annualSharpe(series) {
  const average = mean(series);
  const variance = series.reduce((sum, value) => sum + (value - average) ** 2, 0) / series.length;
  return variance > 0 ? (average / Math.sqrt(variance)) * Math.sqrt(365) : 0;
}

async function audit({ dataDir, outputPath }) {
  const manifest = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8"));
  const supplement = manifest.supplement ? JSON.parse(readFileSync(manifest.supplement.path, "utf8")) : { files: [] };
  const bySymbol = new Map();
  for (const file of [...manifest.files, ...(supplement.files ?? [])]) {
    if (!bySymbol.has(file.symbol)) bySymbol.set(file.symbol, []);
    bySymbol.get(file.symbol).push(file);
  }
  const verification = { files: 0 };
  const btc = await loadSymbol(bySymbol.get("BTCUSDT"), verification);
  const btcCloses = new Map(btc.segments.flat().map((bar) => [bar.t, bar.c]));

  const trades = Object.fromEntries(FRAMES.map((frame) => [frame.id, []]));
  const diagnostics = Object.fromEntries(FRAMES.map((frame) => [frame.id, {}]));
  const symbols = [...bySymbol.keys()].sort();
  for (let s = 0; s < symbols.length; s++) {
    const symbol = symbols[s];
    const loaded = symbol === "BTCUSDT" ? btc : await loadSymbol(bySymbol.get(symbol), verification);
    for (const frame of FRAMES) {
      for (const segment of loaded.segments) {
        const result = findTrades(symbol, segment, frame, btcCloses, { baseline: frame.id === CONFIG.target });
        trades[frame.id].push(...result.trades);
        for (const [name, value] of Object.entries(result.diagnostics)) {
          diagnostics[frame.id][name] = (diagnostics[frame.id][name] ?? 0) + value;
        }
      }
    }
    if (s % 25 === 0) process.stderr.write(`${s + 1}/${symbols.length} ${symbol} 1h n=${trades["1h"].length}\n`);
  }

  const target = trades[CONFIG.target];
  const days = target.map((trade) => trade.day);
  const netCi = clusterBootstrap(target.map((t) => t.rNet), days, CONFIG.bootstrapIterations, CONFIG.bootstrapSeed);
  const paired = target.filter((trade) => Number.isFinite(trade.baselineNet));
  const differenceCi = clusterBootstrap(
    paired.map((trade) => trade.rNet - trade.baselineNet),
    paired.map((trade) => trade.day),
    CONFIG.bootstrapIterations,
    CONFIG.bootstrapSeed,
  );
  const differenceMean = mean(paired.map((trade) => trade.rNet - trade.baselineNet));
  const regimes = Object.fromEntries(["btc_up", "btc_down"].map((regime) => [
    regime, summarize(target.filter((trade) => trade.regime === regime)),
  ]));
  const series = FRAMES.map((frame) => dailySeries(trades[frame.id], FROM, TO_EXCLUSIVE));
  const sharpes = series.map(annualSharpe);
  const sharpeMean = mean(sharpes);
  const sharpeVariance = sharpes.reduce((sum, v) => sum + (v - sharpeMean) ** 2, 0) / (sharpes.length - 1);
  const targetColumn = FRAMES.findIndex((frame) => frame.id === CONFIG.target);
  const dsr = overfittingMeasures({ dsr: [{
    id: "sr-flip-N3",
    inputs: { sharpeVariance, periodsPerYear: 365, independentTrials: CONFIG.dsrTrials },
    source: { returns: series[targetColumn] },
  }] }).dsr;
  const dsrProbability = dsr.included[0]?.result?.probability ?? null;

  const targetSummary = summarize(target);
  const gates = {
    netPositive: targetSummary.mean > 0,
    netClusterCiPositive: netCi.lo > 0,
    baselineDifferencePositive: differenceMean > 0 && differenceCi.lo > 0,
    bothBtcRegimesPositive: regimes.btc_up.mean > 0 && regimes.btc_down.mean > 0,
    dsr: dsrProbability != null && dsrProbability >= CONFIG.dsrThreshold,
  };
  const enough = target.length >= CONFIG.minTrades && netCi.clusters >= CONFIG.minDays;
  const verdict = !enough ? "INCONCLUSIVE" : Object.values(gates).every(Boolean) ? "PASSED_ECONOMICS" : "REJECTED";

  const byYear = Object.fromEntries([2021, 2022, 2023, 2024, 2025].map((year) => [
    year, summarize(target.filter((trade) => trade.year === year)),
  ]));
  const bySide = Object.fromEntries(["LONG", "SHORT"].map((side) => [
    side, summarize(target.filter((trade) => trade.side === side)),
  ]));
  const report = {
    id: "sr-flip-retest-1h",
    ranAt: new Date().toISOString(),
    rule: RULE,
    config: CONFIG,
    corpus: { symbols: symbols.length, filesVerified: verification.files, archiveSetSha256: manifest.archiveSetSha256 },
    diagnostics,
    target: {
      ...targetSummary,
      ci95: netCi,
      at20bp: summarize(target, "rNet20"),
      baseline: { n: paired.length, mean: mean(paired.map((trade) => trade.baselineNet)) },
      difference: { mean: differenceMean, ci95: differenceCi },
      regimes,
      bySide,
      byYear,
      medianRiskPct: [...target.map((t) => t.riskFraction * 100)].sort((a, b) => a - b)[Math.floor(target.length / 2)],
    },
    frames: Object.fromEntries(FRAMES.map((frame, index) => [frame.id, { ...summarize(trades[frame.id]), sharpe: sharpes[index] }])),
    dsr: { sharpeVariance, independentTrials: CONFIG.dsrTrials, probability: dsrProbability },
    gates,
    verdict,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ verdict, gates, n: target.length, mean: targetSummary.mean, ci: [netCi.lo, netCi.hi], diff: differenceMean, diffCi: [differenceCi.lo, differenceCi.hi], regimes, dsrProbability }, null, 2)}\n`);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await audit({
    dataDir: arg("data", "data/binance-f2"),
    outputPath: arg("out", "docs/edge-search/sr-flip-audit.json"),
  });
}
