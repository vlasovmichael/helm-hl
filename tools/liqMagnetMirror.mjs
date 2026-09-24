// ─────────────────────────────────────────────────
//  liq-cluster-magnet-mirror-2026-09 — магнит ликвидаций, зеркальный контроль.
//
//  Предзаявка в реестре (postHoc: данные 2021–2025 уже смотрели метрикой горба).
//  Метрика цели = касание уровня d минус касание зеркала −d за 4ч. Эффект якоря =
//  метрика карты по OI минус метрика карты со сдвинутым на 12ч по кругу OI: те же бары
//  и гашение снимают возврат к среднему, сдвиг рвёт связь «где рос OI — где уровень».
//  Вердикт по всем часам; открытие NY показывается, но мощности на нём мало.
//  Команда power — мощность на синтетике до данных; audit — единственный прогон.
// ─────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { RULE, dayBootstrap, nyOpenUtc, readOi } from "./liqMagnetAudit.mjs";
import { loadSymbol } from "./srFlipAudit.mjs";

const BAR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const CONFIG = Object.freeze({
  bootstrapIterations: 10_000,
  bootstrapSeed: 2_026_092_403,
  minNyAnchors: 300,
});

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** Корзины карты на t0: weight(k) — вес бара k окна, null — бар без уровней. */
function mapBins(bars, i0, weight) {
  const start = i0 - RULE.mapBars;
  const p0 = bars[i0].o;
  const bin = RULE.binPct / 100;
  const lowAfter = new Array(RULE.mapBars).fill(Infinity);
  const highAfter = new Array(RULE.mapBars).fill(-Infinity);
  for (let k = RULE.mapBars - 2; k >= 0; k--) {
    const next = bars[start + k + 1];
    lowAfter[k] = Math.min(lowAfter[k + 1], next.l);
    highAfter[k] = Math.max(highAfter[k + 1], next.h);
  }
  const bins = new Map();
  for (let k = 0; k < RULE.mapBars; k++) {
    const w = weight(start + k);
    if (!(w > 0)) continue;
    const share = w / (RULE.levs.length * 2);
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
  return [...bins.entries()]
    .filter(([idx]) => Math.abs(idx * bin) >= RULE.minPct / 100 - 1e-12 && Math.abs(idx * bin) <= RULE.maxPct / 100 + 1e-12)
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))
    .slice(0, RULE.targets)
    .map(([idx]) => idx * bin);
}

/** Расстояние до самой жирной корзины карты по OI — для встроенного магнита в синтетике. */
export function topDistance(bars, i0, deltaOi) {
  return mapBins(bars, i0, (k) => deltaOi.get(bars[k].t))[0] ?? null;
}

/** Метрика якоря для карты по OI и для пустой карты; null, если окна не хватает. */
export function mirrorAnchor(bars, i0, deltaOi, horizon = RULE.horizonBars) {
  const start = i0 - RULE.mapBars;
  if (start < 0 || i0 + horizon - 1 >= bars.length) return null;
  for (let j = start + 1; j < i0 + horizon; j++) {
    if (bars[j].t !== bars[j - 1].t + BAR_MS) return null;
  }
  const oiTargets = mapBins(bars, i0, (k) => deltaOi.get(bars[k].t));
  const half = RULE.mapBars / 2;
  const flatTargets = mapBins(bars, i0, (k) => {
    const shifted = start + ((k - start + half) % RULE.mapBars);
    return deltaOi.get(bars[shifted].t);
  });
  if (oiTargets.length < RULE.targets || flatTargets.length < RULE.targets) return null;

  const p0 = bars[i0].o;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i0; j < i0 + horizon; j++) {
    hi = Math.max(hi, bars[j].h);
    lo = Math.min(lo, bars[j].l);
  }
  const hit = (d) => ((d > 0 ? hi >= p0 * (1 + d) : lo <= p0 * (1 + d)) ? 1 : 0);
  const score = (targets) => mean(targets.map((d) => hit(d) - hit(-d)));
  const oi = score(oiTargets);
  const flat = score(flatTargets);
  return { effect: oi - flat, oi, flat, own: mean(oiTargets.map(hit)) };
}

/**
 * Синтетический рынок. q — доля окон, где цена 4ч идёт к самой жирной корзине;
 * stop — дойдя, дрейф выключается; revert — сила возврата к 24ч-среднему.
 * OI растёт всплесками, как на бирже: иначе карта по OI совпадает с пустой.
 */
export function syntheticWorld({ q = 0, stop = false, revert = 0, seed = 11, length = 30_000 } = {}) {
  let s = seed;
  const rnd = () => {
    s = (s * 16_807) % 2_147_483_647;
    return s / 2_147_483_647;
  };
  const t0 = Date.UTC(2024, 0, 1);
  const bars = [];
  const deltaOi = new Map();
  let p = 100;
  const step = (drift) => {
    const o = p;
    const tail = bars.slice(-96);
    const avg = tail.length ? tail.reduce((a, b) => a + b.c, 0) / tail.length : p;
    p *= Math.exp((rnd() - 0.5) * 0.008 + drift - revert * Math.log(p / avg));
    const t = t0 + bars.length * BAR_MS;
    bars.push({ t, o, h: Math.max(o, p) * (1 + rnd() * 0.001), l: Math.min(o, p) * (1 - rnd() * 0.001), c: p });
    deltaOi.set(t, rnd() < 0.05 ? rnd() * 2e7 : (rnd() - 0.5) * 1e6);
  };
  for (let i = 0; i < 120; i++) step(0);
  const rows = [];
  while (bars.length < length) {
    const i0 = bars.length;
    let drift = 0;
    if (rnd() < q) {
      bars.push({ t: t0 + i0 * BAR_MS, o: p, h: p, l: p, c: p });
      const d = topDistance(bars, i0, deltaOi);
      bars.pop();
      if (d != null) drift = Math.log(1 + d) / 12;
    }
    for (let k = 0; k < 16; k++) step(stop && k >= 12 ? 0 : drift);
    const r = mirrorAnchor(bars, i0, deltaOi);
    if (r) rows.push({ hump: r.effect, day: Math.floor(bars[i0].t / DAY_MS) });
  }
  return rows;
}

function power() {
  const worlds = [
    { name: "блуждание, магнита нет", q: 0 },
    { name: "возврат к среднему, магнита нет", q: 0, revert: 0.02 },
    { name: "магнит 5%, проскакивает", q: 0.05 },
    { name: "магнит 10%, проскакивает", q: 0.10 },
    { name: "магнит 5%, останавливается", q: 0.05, stop: true },
    { name: "магнит 10%, останавливается", q: 0.10, stop: true },
    { name: "магнит 10% + возврат к среднему", q: 0.10, revert: 0.02 },
  ];
  for (const w of worlds) {
    const rows = syntheticWorld(w);
    const ci = dayBootstrap([rows], 2_000, 3).groups[0];
    const m = mean(rows.map((r) => r.hump));
    process.stdout.write(`${w.name}: n=${rows.length} эффект ${m.toFixed(4)} CI [${ci.lo.toFixed(4)}; ${ci.hi.toFixed(4)}] → ${ci.lo > 0 ? "ловит" : "не ловит"}\n`);
  }
}

async function audit({ dataDir, oiDir, outputPath }) {
  const manifest = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8"));
  const supplement = manifest.supplement ? JSON.parse(readFileSync(manifest.supplement.path, "utf8")) : { files: [] };
  const verification = { files: 0 };
  const rows = [];
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
    const index = new Map(bars.map((b, i) => [b.t, i]));

    for (let day = RULE.devFrom; day < RULE.toExclusive; day += DAY_MS) {
      const ny = nyOpenUtc(day);
      for (let h = 0; h < 24; h++) {
        const anchors = [{ cell: "ALL", at: day + h * HOUR_MS }];
        if (ny != null && h === Math.floor((ny - day) / HOUR_MS)) anchors.push({ cell: "NY", at: ny });
        for (const { cell, at } of anchors) {
          const i0 = index.get(at);
          if (i0 == null) continue;
          const r = mirrorAnchor(bars, i0, deltaOi);
          if (!r) continue;
          const recent = btcCloses.get(at - BAR_MS);
          const old = btcCloses.get(at - BAR_MS - 96 * BAR_MS);
          rows.push({
            symbol, cell, day: Math.floor(at / DAY_MS),
            window: at >= RULE.holdoutFrom ? "holdout" : "dev",
            regime: recent != null && old != null ? (recent > old ? "btc_up" : "btc_down") : null,
            hump: r.effect, oi: r.oi, flat: r.flat, own: r.own,
          });
        }
      }
    }
    process.stderr.write(`${symbol}: якорей ${rows.filter((r) => r.symbol === symbol).length}\n`);
  }

  const pick = (cell, window) => rows.filter((r) => r.cell === cell && r.window === window);
  const summary = (list) => ({
    n: list.length,
    effect: mean(list.map((r) => r.hump)),
    oi: mean(list.map((r) => r.oi)),
    flat: mean(list.map((r) => r.flat)),
    own: mean(list.map((r) => r.own)),
  });
  const nyHold = pick("NY", "holdout");
  const allHold = pick("ALL", "holdout");
  const boot = dayBootstrap([nyHold, allHold], CONFIG.bootstrapIterations, CONFIG.bootstrapSeed);
  const ny = summary(nyHold);
  const all = summary(allHold);
  const regimes = Object.fromEntries(["btc_up", "btc_down"].map((g) => [g, summary(allHold.filter((r) => r.regime === g))]));
  const dev = { NY: summary(pick("NY", "dev")), ALL: summary(pick("ALL", "dev")) };
  // Вердикт по всем часам: у NY 2091 якорь, мощности хватает только на магнит от 20% окон.
  const gates = {
    allEffectCiPositive: all.effect > 0 && boot.groups[1].lo > 0,
    allBothRegimesPositive: regimes.btc_up.effect > 0 && regimes.btc_down.effect > 0,
    allDevPositive: dev.ALL.effect > 0,
  };
  const verdict = allHold.length < CONFIG.minNyAnchors ? "INCONCLUSIVE"
    : Object.values(gates).every(Boolean) ? "PASSED_STAT" : "REJECTED";
  const nyShown = { ...ny, ci95: boot.groups[0], minusAll: { mean: ny.effect - all.effect, ci95: boot.diff } };
  const report = {
    id: "liq-cluster-magnet-mirror-2026-09",
    ranAt: new Date().toISOString(),
    rule: RULE,
    config: CONFIG,
    filesVerified: verification.files,
    holdout: {
      ALL: { ...all, ci95: boot.groups[1] },
      NY: nyShown,
      days: boot.days,
      regimes,
      bySymbol: Object.fromEntries(RULE.symbols.map((s) => [s, summary(allHold.filter((r) => r.symbol === s))])),
    },
    dev,
    gates,
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
  if (process.argv[2] === "power") power();
  else if (process.argv[2] === "audit") {
    await audit({
      dataDir: arg("data", "data/binance-f2"),
      oiDir: arg("oi", "data/binance-oi"),
      outputPath: arg("out", "docs/edge-search/liq-magnet-mirror-audit.json"),
    });
  } else throw new Error("команды: power | audit");
}
