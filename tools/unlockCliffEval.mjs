// Оценка unlock-cliff ровно при 60 чистых закрытых событиях. До этого молчит.
import { readJsonl } from './researchStats.mjs';
import { rng } from './baseline.mjs';
import { getVenueSnapshots, initDB } from '../src/core/database.js';
import { MIN_RATIO, collapseEvents } from './unlocksForward.mjs';

const DAY = 86_400_000;
const START = Date.parse('2026-09-09T00:00:00Z');
// Контроль берёт год до старта: окно форварда короче месяца, а месячные транши закрывают его целиком.
// Разлоки до старта в снимках не известны и не вырезаются — это тянет плацебо к эффекту, не от него.
const PLACEBO_FROM = START - 365 * DAY;
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
  for (let d = PLACEBO_FROM; d <= max; d += DAY) {
    if (!blocked.some((u) => d <= u + 14 * DAY && d + 7 * DAY >= u - 14 * DAY)) out.push(d);
  }
  return out;
}

async function dailyCandles(coin, end) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: PLACEBO_FROM - 90 * DAY, endTime: end } }),
  });
  if (!res.ok) throw new Error(`свечи ${coin}: HL ${res.status}`);
  const rows = await res.json();
  const out = new Map();
  for (const b of rows || []) {
    if (Number.isFinite(Number(b.t)) && Number(b.c) > 0) out.set(Math.floor(Number(b.t) / DAY) * DAY, { c: Number(b.c), volUsd: Number(b.v) * Number(b.c) });
  }
  return out;
}

// Плацебо-вход проходит то же правило, что scan: разлок события >= медианного оборота 40 дней
// на день «обнаружения» с тем же упреждением. Без этого контроль меряет обычную неделю.
export function passesSelection(event, d, bars) {
  const lead = Math.max(0, Math.round((event.entryTs - event.discoveredAt) / DAY));
  const disc = d - lead * DAY, price = bars.get(disc - DAY)?.c;
  const vols = [];
  for (let t = disc - 40 * DAY; t < disc; t += DAY) { const v = bars.get(t)?.volUsd; if (v > 0) vols.push(v); }
  if (!(price > 0) || vols.length < 10) return false;
  return (event.tokens * price) / median(vols) >= MIN_RATIO;
}

export async function placeboMedians(events, schedule, now, { sets = 200, seed = 20260909, candles = dailyCandles } = {}) {
  const byCoin = new Map();
  for (const coin of new Set(events.map((r) => r.coin))) byCoin.set(coin, await candles(coin, now));
  const pool = events.map((event) => {
    const bars = byCoin.get(event.coin);
    const days = eligibleDays(event.coin, now, schedule)
      .filter((d) => bars.get(d)?.c > 0 && bars.get(d + 7 * DAY)?.c > 0 && passesSelection(event, d, bars));
    return { event, days, bars };
  });
  // Событие без сопоставимых дней в контроль не идёт: подставить ему обычную неделю значит вернуть дыру.
  const used = pool.filter((p) => p.days.length);
  if (!used.length) throw new Error('ни одного плацебо-дня, прошедшего правило отбора');
  const random = rng(seed), medians = [];
  for (let i = 0; i < sets; i++) {
    medians.push(median(used.map(({ event, days, bars }) => {
      const d = days[Math.floor(random() * days.length)];
      return Math.log(bars.get(d).c / bars.get(d + 7 * DAY).c) * 1e4 - event.cost;
    })));
  }
  return { medians, eventsUsed: used.length, eventsDropped: pool.length - used.length };
}

if (process.argv[1]?.endsWith('unlockCliffEval.mjs')) {
  const rows = collapseEvents(readJsonl(FORWARD).filter((r) => r.status === 'closed' && r.clean));
  if (rows.length < 60) process.exit(0);
  initDB();
  const snapshots = getVenueSnapshots(0), schedule = readJsonl(SCHEDULE), now = Date.now();
  const events = rows.map((r) => {
    const cost = unlockCostBp(r, snapshots); return { ...r, cost, netBp: r.grossBp - cost };
  });
  const actual = median(events.map((r) => r.netBp));
  const ci = bootstrapCoinMedian(events);
  const { medians: placebos, eventsUsed, eventsDropped } = await placeboMedians(events, schedule, now);
  const p = placebos.filter((x) => x >= actual).length / placebos.length;
  console.log(JSON.stringify({ medianNetBp: actual, ci, placebo: { sets: placebos.length, seed: 20260909, p, eventsUsed, eventsDropped },
    verdict: ci.lo > 0 && p < .05 ? 'PASSED_ECONOMICS' : 'REJECTED' }, null, 2));
}
