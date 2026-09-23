// Оценка flow-pressure ровно после стоп-правила. До него CLI намеренно молчит.
import { rng } from './baseline.mjs';
import { pressureRows } from '../src/modules/forwards.js';

const DAY = 86_400_000;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function pressureReady(rows) {
  const exhausted = rows.filter((r) => r.cohort === 'exhausted' && Number.isFinite(r.fadeBp));
  const persistent = rows.filter((r) => r.cohort === 'persistent' && Number.isFinite(r.fadeBp));
  const regimes = rows.filter((r) => r.btcRegime === 'btc_up' || r.btcRegime === 'btc_down');
  const up = regimes.filter((r) => r.btcRegime === 'btc_up').length;
  const down = regimes.length - up;
  const days = new Set(rows.map((r) => r.entryT).filter(Number.isFinite).map(day));
  return rows.length >= 300 && exhausted.length >= 100 && persistent.length >= 100 &&
    days.size >= 60 && regimes.length > 0 && Math.min(up, down) / regimes.length >= 0.2;
}

/** Бутстрап разницы средних целыми UTC-днями. */
export function clusteredDifference(rows, { iterations = 2000, seed = 12345 } = {}) {
  const byDay = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.fadeBp) || !Number.isFinite(r.entryT)) continue;
    if (r.cohort !== 'exhausted' && r.cohort !== 'persistent') continue;
    const k = day(r.entryT);
    if (!byDay.has(k)) byDay.set(k, { exhausted: [], persistent: [] });
    byDay.get(k)[r.cohort].push(r.fadeBp);
  }
  const clusters = [...byDay.values()];
  const exhausted = rows.filter((r) => r.cohort === 'exhausted' && Number.isFinite(r.fadeBp)).map((r) => r.fadeBp);
  const persistent = rows.filter((r) => r.cohort === 'persistent' && Number.isFinite(r.fadeBp)).map((r) => r.fadeBp);
  if (clusters.length < 5 || !exhausted.length || !persistent.length) return null;
  const random = rng(seed);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const a = [], b = [];
    for (let j = 0; j < clusters.length; j++) {
      const c = clusters[Math.floor(random() * clusters.length)];
      a.push(...c.exhausted); b.push(...c.persistent);
    }
    if (a.length && b.length) samples.push(mean(a) - mean(b));
  }
  samples.sort((a, b) => a - b);
  return {
    exhaustedMean: mean(exhausted), persistentMean: mean(persistent),
    difference: mean(exhausted) - mean(persistent), days: clusters.length,
    lo: samples[Math.floor(samples.length * 0.025)], hi: samples[Math.floor(samples.length * 0.975)],
    pOneSided: samples.filter((x) => x <= 0).length / samples.length,
  };
}

export function clusteredMean(rows, { iterations = 2000, seed = 12345 } = {}) {
  const byDay = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.fadeBp) || !Number.isFinite(r.entryT)) continue;
    const k = day(r.entryT); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r.fadeBp);
  }
  const clusters = [...byDay.values()];
  if (clusters.length < 5) return null;
  const random = rng(seed), samples = [];
  for (let i = 0; i < iterations; i++) {
    const sample = [];
    for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(random() * clusters.length)]);
    samples.push(mean(sample));
  }
  samples.sort((a, b) => a - b);
  const values = rows.filter((r) => Number.isFinite(r.fadeBp)).map((r) => r.fadeBp);
  return { mean: mean(values), days: clusters.length, lo: samples[Math.floor(samples.length * .025)], hi: samples[Math.floor(samples.length * .975)] };
}

export function evaluatePressure(rows) {
  if (!pressureReady(rows)) return null;
  const total = clusteredDifference(rows);
  const exhausted = clusteredMean(rows.filter((r) => r.cohort === 'exhausted'));
  const byRegime = Object.fromEntries(['btc_up', 'btc_down'].map((regime) => {
    const r = clusteredDifference(rows.filter((x) => x.btcRegime === regime));
    return [regime, r?.difference ?? null];
  }));
  const contribution = new Map();
  for (const r of rows) contribution.set(r.coin, (contribution.get(r.coin) || 0) + (r.cohort === 'exhausted' ? r.fadeBp : -r.fadeBp));
  const remove = [...contribution.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([coin]) => coin);
  const withoutTop5 = clusteredDifference(rows.filter((r) => !remove.includes(r.coin)));
  return { total, exhausted, byRegime, withoutTop5, removedCoins: remove,
    gates: {
      difference20Bp: total.difference >= 20 && total.lo > 0,
      exhausted20Bp: exhausted.mean >= 20 && exhausted.lo > 0,
      bothRegimesPositive: byRegime.btc_up > 0 && byRegime.btc_down > 0,
      withoutTop5Positive: withoutTop5?.difference > 0,
      fdr: 'ожидает переноса primary p-value в реестр',
    } };
}

if (process.argv[1]?.endsWith('flowPressureEval.mjs')) {
  const rows = pressureRows();
  if (!pressureReady(rows)) process.exit(0);
  // FDR добавляется при переносе единственного primary p-value в приватный реестр.
  console.log(JSON.stringify(evaluatePressure(rows), null, 2));
}
