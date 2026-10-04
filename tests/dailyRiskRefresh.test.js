import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.DAILY_RISK_FAKE_DEPS === '1';
const maybeTest = enabled ? test : test.skip;
const risk = await import('../src/modules/dailyRisk.js');
const fills = await import('./helpers/daily-risk-fills-fake.js');
const balance = await import('./helpers/daily-risk-balance-fake.js');
const logs = await import('./helpers/daily-risk-logger-fake.js');
const fakeConfig = await import('./helpers/daily-risk-config-fake.js');

function reset() {
  risk._resetDailyRiskState(); fills.resetFills(); balance.setEquity(100); logs.resetLogger(); fakeConfig.resetConfig();
}
const fill = (time, closedPnl, fee) => ({ time, closedPnl: String(closedPnl), fee: String(fee) });

maybeTest('dailyRisk refresh halts exactly at loss limit and alerts once per day', async () => {
  reset();
  const now = new Date(2026, 4, 10, 12).getTime();
  fills.setFills([fill(now, -4.8, 0.2)]);
  const first = await risk.refreshDailyRisk(now);
  assert.deepEqual(first, { halted: true, crossedNow: true, netUsd: -5, feesUsd: 0.2, limitUsd: 5, dayKey: '2026-05-10', feePct: 0.2, feeCrossedNow: false });
  assert.equal(risk.getLastDailyRiskStatus().halted, true);
  const second = await risk.refreshDailyRisk(now + 1);
  assert.equal(second.crossedNow, false);
  assert.equal(logs.calls.filter(([level]) => level === 'warn').length, 1);
  assert.match(logs.calls[0][1], /дневной стоп-лосс.*−\$5.*fills 1/);
});

maybeTest('dailyRisk respects disabled loss rail and alerts fee budget once', async () => {
  reset();
  const now = new Date(2026, 4, 11, 12).getTime();
  fakeConfig.config.trading.dailyLossLimitEnabled = false;
  fills.setFills([fill(now, -10, 2)]);
  const r = await risk.refreshDailyRisk(now);
  assert.equal(r.halted, false);
  assert.equal(r.feePct, 2);
  assert.equal(r.feeCrossedNow, true);
  assert.equal((await risk.refreshDailyRisk(now + 1)).feeCrossedNow, false);
  assert.match(logs.calls[0][1], /бюджет комиссий.*\$2\.00.*2\.0%/);
});

maybeTest('dailyRisk returns same-day stale protection after fill source fails', async () => {
  reset();
  const now = new Date(2026, 4, 12, 12).getTime();
  fills.setFills([fill(now, -5, 0)]);
  await risk.refreshDailyRisk(now);
  fills.setFailure(new Error('indexer unavailable'));
  assert.deepEqual(await risk.refreshDailyRisk(now + 1000), {
    halted: true, crossedNow: false, netUsd: -5, feesUsd: 0, limitUsd: 5,
    dayKey: '2026-05-12', feePct: 0.0, feeCrossedNow: false,
  });
});

maybeTest('dailyRisk does not halt a profitable day and does not reuse stale status tomorrow', async () => {
  reset();
  const jan = new Date(2026, 0, 2, 12).getTime();
  fills.setFills([null, fill(jan, 1, 0)]);
  assert.equal((await risk.refreshDailyRisk(jan)).halted, false);
  fills.setFailure(new Error('offline'));
  assert.deepEqual(await risk.refreshDailyRisk(jan + 24 * 3600_000), {
    halted: false, crossedNow: false, netUsd: 0, feesUsd: 0, limitUsd: 5,
    dayKey: '2026-01-03', feePct: null, feeCrossedNow: false,
  });
});
