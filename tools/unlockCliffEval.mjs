// Оценка unlock-cliff ровно при 60 чистых закрытых событиях. До этого молчит.
import { readJsonl } from './researchStats.mjs';
import { rng } from './baseline.mjs';
import { getVenueSnapshots } from '../src/core/database.js';

const DAY = 86_400_000;
const START = Date.parse('2026-09-09T00:00:00Z');
const FORWARD = 'data/unlocks/forward.jsonl';
const SCHEDULE = 'data/unlocks/schedule.jsonl';
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null;
  const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function unlockCostBp(row, snapshots) {
  const own = snapshots.filter((s) => s.dex === 'main' && s.coin === row.coin && Number.isFinite(s.spread_bp));
  const inWindow = own.filter((s) => s.ts >= row.entryTs && s.ts <= row.unlockTs);
  return (Number(row.costBp) || 0) + (median(inWindow.map((s) => s.spread_bp)) ?? median(own.map((s) => s.spread_bp)) ?? 20);
}

export function bootstrapCoinMedian(rows, { iterations = 10000, seed = 20260909 } = {}) {
  const byCoin = new Map();
  for (const r of rows) { if (!byCoin.has(r.coin)) byCoin.set(r.coin, []); byCoin.get(r.coin).push(r.netBp); }
  const clusters = [...byCoin.values()]; if (clusters.length < 2) return null;
  const random = rng(seed), samples = [];
  for (let i = 0; i < iterations; i++) {
    const sample = [];
    for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(random() * clusters.length)]);
    samples.push(median(sample));
  }
  samples.sort((a, b) => a - b);
  return { lo: samples[Math.floor(iterations * .025)], hi: samples[Math.floor(iterations * .975)], coins: clusters.length };
}

export function eligibleDays(coin, now, schedule) {
  const max = Math.floor((now - 14 * DAY) / DAY) * DAY;
  const blocked = schedule.filter((r) => r.coin === coin && Number.isFinite(r.unlockTs)).map((r) => r.unlockTs);
  const out = [];
  for (let d = START; d <= max; d += DAY) {
    if (!blocked.some((u) => d <= u + 14 * DAY && d + 7 * DAY >= u - 14 * DAY)) out.push(d);
  }
  return out;
}

async function dailyCandles(coin, end) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: START, endTime: end } }),
  });
  if (!res.ok) throw new Error(`свечи ${coin}: HL ${res.status}`);
  const rows = await res.json();
  const out = new Map();
  for (const b of rows || []) if (Number.isFinite(Number(b.t)) && Number(b.c) > 0) out.set(Math.floor(Number(b.t) / DAY) * DAY, Number(b.c));
  return out;
}

export async function placeboMedians(events, schedule, now, { sets = 200, seed = 20260909, candles = dailyCandles } = {}) {
  const byCoin = new Map();
  for (const coin of new Set(events.map((r) => r.coin))) byCoin.set(coin, await candles(coin, now));
  const eligible = new Map(events.map((r) => [r.coin, eligibleDays(r.coin, now, schedule)]));
  const random = rng(seed), medians = [];
  for (let i = 0; i < sets; i++) {
    const values = [];
    for (const event of events) {
      const days = eligible.get(event.coin), prices = byCoin.get(event.coin);
      if (!days?.length) throw new Error(`нет допустимых плацебо-дней для ${event.coin}`);
      let value = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        const d = days[Math.floor(random() * days.length)], entry = prices.get(d), exit = prices.get(d + 7 * DAY);
        if (entry > 0 && exit > 0) { value = Math.log(entry / exit) * 1e4 - event.cost; break; }
      }
      if (value == null) throw new Error(`нет свечей для плацебо ${event.coin}`);
      values.push(value);
    }
    medians.push(median(values));
  }
  return medians;
}

if (process.argv[1]?.endsWith('unlockCliffEval.mjs')) {
  const rows = readJsonl(FORWARD).filter((r) => r.status === 'closed' && r.clean);
  if (rows.length < 60) process.exit(0);
  const snapshots = getVenueSnapshots(0), schedule = readJsonl(SCHEDULE), now = Date.now();
  const events = rows.map((r) => {
    const cost = unlockCostBp(r, snapshots); return { ...r, cost, netBp: r.grossBp - cost };
  });
  const actual = median(events.map((r) => r.netBp));
  const ci = bootstrapCoinMedian(events);
  const placebos = await placeboMedians(events, schedule, now);
  const p = placebos.filter((x) => x >= actual).length / placebos.length;
  console.log(JSON.stringify({ medianNetBp: actual, ci, placebo: { sets: placebos.length, seed: 20260909, p },
    verdict: ci.lo > 0 && p < .05 ? 'PASSED_ECONOMICS' : 'REJECTED' }, null, 2));
}
