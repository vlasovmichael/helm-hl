// ─────────────────────────────────────────────────
//  liq-cluster-magnet-ny-2026-09 — магнит оценённых ликвидаций на открытии NY.
//
//  Предзаявка: data/hypotheses/registry.json, зафиксирована 2026-09-24T14:59:59Z,
//  коммит hl-lab 1a07e39 до скачивания OI. Карта ликвидаций строится по росту OI
//  Binance за 24ч; горб = касание уровня минус среднее касаний соседей 0.8d и 1.2d.
//  Касание выпукло по расстоянию, поэтому без магнита горб не больше нуля.
//  Решение: провал гейта 1–3 = REJECTED; гейт 4 решает только «именно NY».
// ─────────────────────────────────────────────────

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { rng } from "./baseline.mjs";
import { loadSymbol } from "./srFlipAudit.mjs";

const BAR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const RULE = Object.freeze({
  symbols: Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]),
  levs: Object.freeze([10, 25, 50, 100]),
  mapBars: 96,
  binPct: 0.2,
  minPct: 0.5,
  maxPct: 5,
  targets: 3,
  horizonBars: 16,
  shownHorizons: Object.freeze([4, 96]),
  placebo: Object.freeze([0.8, 1.2]),
  devFrom: Date.UTC(2021, 11, 1),
  holdoutFrom: Date.UTC(2024, 0, 1),
  toExclusive: Date.UTC(2026, 0, 1),
});

export const CONFIG = Object.freeze({
  bootstrapIterations: 10_000,
  bootstrapSeed: 2_026_092_402,
  minNyAnchors: 300,
});

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** 09:30 America/New_York этого UTC-дня в миллисекундах UTC; null в выходные. */
export function nyOpenUtc(dayStart) {
  const weekday = new Date(dayStart).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  for (const hourUtc of [13, 14]) {
    const t = dayStart + hourUtc * HOUR_MS + 30 * 60_000;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23",
    }).formatToParts(new Date(t));
    const hour = Number(parts.find((p) => p.type === "hour").value);
    if (hour === 9) return t;
  }
  return null;
}

export function readOi(dir) {
  const oi = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".zip")).sort()) {
    const text = spawnSync("unzip", ["-p", `${dir}/${file}`], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
    for (const line of text.split("\n")) {
      if (!/^\d{4}-/.test(line)) continue;
      const fields = line.split(",");
      const t = Date.parse(`${fields[0].replace(" ", "T")}Z`);
      const value = Number(fields[3]);
      if (Number.isFinite(t) && Number.isFinite(value) && value > 0) oi.set(t, value);
    }
  }
  return oi;
}

/**
 * Горб одного якоря. bars — сплошной массив 15m, i0 — индекс бара t0.
 * Возвращает null, если карты или будущего не хватает.
 */
export function anchorHump(bars, i0, deltaOi, { horizon = RULE.horizonBars, rankFrom = 0, rankTo = RULE.targets } = {}) {
  const start = i0 - RULE.mapBars;
  if (start < 0 || i0 + horizon - 1 >= bars.length) return null;
  for (let j = start; j < i0 + horizon; j++) {
    if (j > start && bars[j].t !== bars[j - 1].t + BAR_MS) return null;
  }
  const p0 = bars[i0].o;
  const bin = RULE.binPct / 100;

  // Экстремумы от бара после создания уровня до t0 — для гашения уровня.
  const lowAfter = new Array(RULE.mapBars).fill(Infinity);
  const highAfter = new Array(RULE.mapBars).fill(-Infinity);
  for (let k = RULE.mapBars - 2; k >= 0; k--) {
    const next = bars[start + k + 1];
    lowAfter[k] = Math.min(lowAfter[k + 1], next.l);
    highAfter[k] = Math.max(highAfter[k + 1], next.h);
  }

  const bins = new Map();
  for (let k = 0; k < RULE.mapBars; k++) {
    const d = deltaOi.get(bars[start + k].t);
    if (!(d > 0)) continue;
    const share = d / (RULE.levs.length * 2);
    const close = bars[start + k].c;
    for (const lev of RULE.levs) {
      const longLiq = close * (1 - 1 / lev);
      const shortLiq = close * (1 + 1 / lev);
      if (!(lowAfter[k] <= longLiq)) {
        const idx = Math.round((longLiq / p0 - 1) / bin);
        bins.set(idx, (bins.get(idx) ?? 0) + share);
      }
      if (!(highAfter[k] >= shortLiq)) {
        const idx = Math.round((shortLiq / p0 - 1) / bin);
        bins.set(idx, (bins.get(idx) ?? 0) + share);
      }
    }
  }
  const ranked = [...bins.entries()]
    .filter(([idx]) => Math.abs(idx * bin) >= RULE.minPct / 100 - 1e-12 && Math.abs(idx * bin) <= RULE.maxPct / 100 + 1e-12)
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))
    .slice(rankFrom, rankTo);
  if (ranked.length < rankTo - rankFrom) return null;

  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i0; j < i0 + horizon; j++) {
    hi = Math.max(hi, bars[j].h);
    lo = Math.min(lo, bars[j].l);
  }
  const touched = (d) => (d > 0 ? hi >= p0 * (1 + d) : lo <= p0 * (1 + d));
  const humps = ranked.map(([idx]) => {
    const d = idx * bin;
    const own = touched(d) ? 1 : 0;
    const around = mean(RULE.placebo.map((m) => (touched(d * m) ? 1 : 0)));
    return { hump: own - around, own, around };
  });
  return {
    hump: mean(humps.map((h) => h.hump)),
    own: mean(humps.map((h) => h.own)),
    around: mean(humps.map((h) => h.around)),
  };
}

/** Кластерный бутстрап по дням для одной или двух групп якорей с общим ресэмплом дней. */
export function dayBootstrap(groups, iterations, seed) {
  const days = [...new Set(groups.flatMap((g) => g.map((row) => row.day)))].sort((a, b) => a - b);
  const byDay = groups.map((g) => {
    const map = new Map();
    for (const row of g) {
      if (!map.has(row.day)) map.set(row.day, [0, 0]);
      const cell = map.get(row.day);
      cell[0] += row.hump;
      cell[1] += 1;
    }
    return map;
  });
  const random = rng(seed);
  const stats = groups.map(() => []);
  const diffs = [];
  for (let it = 0; it < iterations; it++) {
    const sums = groups.map(() => [0, 0]);
    for (let n = 0; n < days.length; n++) {
      const day = days[Math.floor(random() * days.length)];
      byDay.forEach((map, g) => {
        const cell = map.get(day);
        if (cell) {
          sums[g][0] += cell[0];
          sums[g][1] += cell[1];
        }
      });
    }
    const means = sums.map(([s, c]) => (c ? s / c : NaN));
    means.forEach((m, g) => stats[g].push(m));
    if (groups.length === 2) diffs.push(means[0] - means[1]);
  }
  const ci = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return { lo: sorted[Math.floor(sorted.length * 0.025)], hi: sorted[Math.floor(sorted.length * 0.975)] };
  };
  return { days: days.length, groups: stats.map(ci), diff: groups.length === 2 ? ci(diffs) : null };
}

async function audit({ dataDir, oiDir, outputPath }) {
  const manifest = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8"));
  const supplement = manifest.supplement ? JSON.parse(readFileSync(manifest.supplement.path, "utf8")) : { files: [] };
  const verification = { files: 0 };
  const rows = [];
  const coverage = {};
  let btcCloses = null;

  for (const symbol of RULE.symbols) {
    const files = [...manifest.files, ...(supplement.files ?? [])].filter((f) => f.symbol === symbol);
    const loaded = await loadSymbol(files, verification);
    const bars = loaded.segments.flat().filter((b) => b.t >= RULE.devFrom - 2 * DAY_MS);
    if (symbol === "BTCUSDT") btcCloses = new Map(bars.map((b) => [b.t, b.c]));
    const oi = readOi(`${oiDir}/${symbol}`);
    const deltaOi = new Map();
    for (const b of bars) {
      const a = oi.get(b.t);
      const z = oi.get(b.t + BAR_MS);
      if (a != null && z != null) deltaOi.set(b.t, z - a);
    }
    coverage[symbol] = { bars: bars.length, oiSnapshots: oi.size, deltaBars: deltaOi.size };
    const index = new Map(bars.map((b, i) => [b.t, i]));

    for (let day = RULE.devFrom; day < RULE.toExclusive; day += DAY_MS) {
      const ny = nyOpenUtc(day);
      for (let h = 0; h < 24; h++) {
        const t0 = day + h * HOUR_MS;
        const anchors = [{ cell: "ALL", t0 }];
        if (ny != null && h === Math.floor((ny - day) / HOUR_MS)) anchors.push({ cell: "NY", t0: ny });
        for (const { cell, t0: at } of anchors) {
          const i0 = index.get(at);
          if (i0 == null) continue;
          const main = anchorHump(bars, i0, deltaOi);
          if (!main) continue;
          const row = {
            symbol, cell, t0: at, day: Math.floor(at / DAY_MS),
            window: at >= RULE.holdoutFrom ? "holdout" : "dev",
            regime: null, ...main,
          };
          const recent = btcCloses.get(at - BAR_MS);
          const old = btcCloses.get(at - BAR_MS - 96 * BAR_MS);
          if (recent != null && old != null) row.regime = recent > old ? "btc_up" : "btc_down";
          if (cell === "NY") {
            row.h1 = anchorHump(bars, i0, deltaOi, { horizon: RULE.shownHorizons[0] })?.hump ?? null;
            row.h24 = anchorHump(bars, i0, deltaOi, { horizon: RULE.shownHorizons[1] })?.hump ?? null;
            row.rank4to10 = anchorHump(bars, i0, deltaOi, { rankFrom: 3, rankTo: 10 })?.hump ?? null;
          }
          rows.push(row);
        }
      }
    }
    process.stderr.write(`${symbol}: якорей ${rows.filter((r) => r.symbol === symbol).length}\n`);
  }

  const pick = (cell, window, extra = () => true) => rows.filter((r) => r.cell === cell && r.window === window && extra(r));
  const summary = (list, key = "hump") => {
    const values = list.map((r) => r[key]).filter((v) => v != null);
    return { n: values.length, mean: mean(values), own: mean(list.map((r) => r.own)), around: mean(list.map((r) => r.around)) };
  };
  const nyHold = pick("NY", "holdout");
  const allHold = pick("ALL", "holdout");
  const boot = dayBootstrap([nyHold, allHold], CONFIG.bootstrapIterations, CONFIG.bootstrapSeed);
  const nyMean = summary(nyHold).mean;
  const allMean = summary(allHold).mean;
  const regimes = Object.fromEntries(["btc_up", "btc_down"].map((g) => [g, summary(nyHold.filter((r) => r.regime === g))]));
  const dev = { NY: summary(pick("NY", "dev")), ALL: summary(pick("ALL", "dev")) };

  const gates = {
    nyHumpCiPositive: nyMean > 0 && boot.groups[0].lo > 0,
    nyBothRegimesPositive: regimes.btc_up.mean > 0 && regimes.btc_down.mean > 0,
    nyDevPositive: dev.NY.mean > 0,
    nyBeatsAllHours: nyMean - allMean > 0 && boot.diff.lo > 0,
  };
  const magnet = gates.nyHumpCiPositive && gates.nyBothRegimesPositive && gates.nyDevPositive;
  const verdict = nyHold.length < CONFIG.minNyAnchors ? "INCONCLUSIVE" : magnet ? "PASSED_STAT" : "REJECTED";

  const report = {
    id: "liq-cluster-magnet-ny-2026-09",
    ranAt: new Date().toISOString(),
    rule: RULE,
    config: CONFIG,
    coverage,
    filesVerified: verification.files,
    holdout: {
      NY: { ...summary(nyHold), ci95: boot.groups[0] },
      ALL: { ...summary(allHold), ci95: boot.groups[1] },
      nyMinusAll: { mean: nyMean - allMean, ci95: boot.diff },
      days: boot.days,
      regimes,
      bySymbol: Object.fromEntries(RULE.symbols.map((s) => [s, summary(nyHold.filter((r) => r.symbol === s))])),
      shown: {
        horizon1h: summary(nyHold, "h1"),
        horizon24h: summary(nyHold, "h24"),
        rank4to10: summary(nyHold, "rank4to10"),
      },
    },
    dev,
    gates,
    timingConfirmed: magnet && gates.nyBeatsAllHours,
    verdict,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ verdict, gates, holdout: report.holdout, dev }, null, 2)}\n`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await audit({
    dataDir: arg("data", "data/binance-f2"),
    oiDir: arg("oi", "data/binance-oi"),
    outputPath: arg("out", "docs/edge-search/liq-magnet-audit.json"),
  });
}
