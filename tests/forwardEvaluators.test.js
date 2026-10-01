// Оценщики форвардов: до стоп-правила метрики не считаются, после — сид стабилен.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { clusteredDifference, clusteredMean, pressureReady } = await import('../tools/flowPressureEval.mjs');
const { collapseEvents } = await import('../tools/unlocksForward.mjs');
const { bootstrapCoinMedian, eligibleDays, passesSelection, placeboMedians, unlockCostBp } = await import('../tools/unlockCliffEval.mjs');

const DAY = 86_400_000;

test('flow не готов, пока не выполнены все стоп-гейты', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    coin: `C${i % 10}`, cohort: i < 150 ? 'exhausted' : 'persistent', fadeBp: i < 150 ? 30 : 0,
    entryT: Date.parse('2026-09-14T00:00:00Z') + (i % 60) * DAY,
    btcRegime: i % 10 < 2 ? 'btc_down' : 'btc_up',
  }));
  assert.equal(pressureReady(rows), true);
  assert.equal(pressureReady(rows.slice(0, 299)), false);
  assert.equal(pressureReady(rows.map((r) => ({ ...r, btcRegime: 'btc_up' }))), false);
});

test('flow-кластеризация даёт воспроизводимые разницу и CI', () => {
  const rows = Array.from({ length: 10 }, (_, i) => [
    { coin: 'A', cohort: 'exhausted', fadeBp: 20, entryT: i * DAY },
    { coin: 'B', cohort: 'persistent', fadeBp: 0, entryT: i * DAY },
  ]).flat();
  const a = clusteredDifference(rows, { iterations: 300, seed: 7 });
  assert.equal(a.difference, 20);
  assert.deepEqual(a, clusteredDifference(rows, { iterations: 300, seed: 7 }));
  assert.equal(clusteredMean(rows.filter((r) => r.cohort === 'exhausted'), { iterations: 300, seed: 7 }).mean, 20);
});

test('unlock: спред окна, затем весь архив, затем 20 бп', () => {
  const row = { coin: 'A', entryTs: 100, unlockTs: 200, costBp: 10 };
  assert.equal(unlockCostBp(row, [{ dex: 'main', coin: 'A', ts: 150, spread_bp: 4 }, { dex: 'main', coin: 'A', ts: 300, spread_bp: 8 }]), 14);
  assert.equal(unlockCostBp(row, [{ dex: 'main', coin: 'A', ts: 300, spread_bp: 8 }]), 18);
  assert.equal(unlockCostBp(row, []), 30);
});

test('unlock: плацебо не пересекает разлок ±14 дней и CI по монетам стабилен', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const days = eligibleDays('A', now, [{ coin: 'A', unlockTs: Date.parse('2026-09-30T00:00:00Z') }]);
  assert.ok(days.every((d) => !(d <= Date.parse('2026-10-14T00:00:00Z') && d + 7 * DAY >= Date.parse('2026-09-16T00:00:00Z'))));
  const rows = [{ coin: 'A', netBp: 5 }, { coin: 'B', netBp: 15 }];
  assert.deepEqual(bootstrapCoinMedian(rows, { iterations: 300, seed: 9 }), bootstrapCoinMedian(rows, { iterations: 300, seed: 9 }));
});

test('unlock: плацебо берёт только дни, где разлок события >= оборота', async () => {
  const start = Date.parse('2026-09-09T00:00:00Z'), now = Date.parse('2026-11-01T00:00:00Z');
  const bars = new Map();
  for (let t = start - 90 * DAY; t <= now; t += DAY) bars.set(t, { c: 1, volUsd: t < Date.parse('2026-09-01T00:00:00Z') ? 1000 : 10 });
  const event = { coin: 'A', tokens: 100, entryTs: start + 20 * DAY, discoveredAt: start + 10 * DAY, cost: 0 };
  assert.equal(passesSelection(event, Date.parse('2026-09-15T00:00:00Z'), bars), false);
  assert.equal(passesSelection(event, Date.parse('2026-10-25T00:00:00Z'), bars), true);
  const res = await placeboMedians([event, { ...event, coin: 'B', tokens: 1 }], [], now, { sets: 5, candles: async () => bars });
  assert.deepEqual([res.eventsUsed, res.eventsDropped, res.medians.length], [1, 1, 5]);
});

test('unlock: категории одного разлока и перекрытия за 7 дней — одно событие', () => {
  const t = Date.parse('2026-09-25T00:00:00Z');
  const rows = [
    { key: 'A:1:insiders', coin: 'A', unlockTs: t, usd: 1 },
    { key: 'A:1:privateSale', coin: 'A', unlockTs: t, usd: 5 },
    { key: 'A:2:team', coin: 'A', unlockTs: t + 3 * DAY, usd: 9 },
    { key: 'A:3:team', coin: 'A', unlockTs: t + 8 * DAY, usd: 1 },
    { key: 'B:1:team', coin: 'B', unlockTs: t, usd: 1 },
  ];
  assert.deepEqual(collapseEvents(rows).map((r) => r.key), ['A:1:privateSale', 'B:1:team', 'A:3:team']);
});
