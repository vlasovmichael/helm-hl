import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
// Дефолты: DAILY_LOSS_LIMIT_ENABLED=true, DAILY_LOSS_LIMIT_USD=5.

const { computeDayStats, localDayKey } = await import('../src/modules/dailyRisk.js');

// Хелпер: fill HL-формы в заданный момент времени.
const fill = (time, closedPnl, fee) => ({ time, closedPnl: String(closedPnl), fee: String(fee) });

test('dailyRisk: net дня = Σ closedPnl − Σ fee, только сегодняшние fills', () => {
  const now = Date.now();
  const today = localDayKey(now);
  const yesterday = now - 24 * 3600_000;
  const fills = [
    fill(now, '2.50', '0.10'),        // сегодня: +2.40 net
    fill(now - 60_000, '-4.00', '0.20'), // сегодня: −4.20 net
    fill(yesterday, '-50', '1'),      // вчера — не считается
  ];
  const s = computeDayStats(fills, today);
  assert.equal(s.count, 2);
  assert.ok(Math.abs(s.net - (-1.8)) < 1e-9, `net=${s.net}`);
  assert.ok(Math.abs(s.fees - 0.3) < 1e-9);
});

test('dailyRisk: пустые/битые fills → нули, не падает', () => {
  const today = localDayKey(Date.now());
  assert.deepEqual(computeDayStats([], today), { net: 0, fees: 0, count: 0 });
  assert.deepEqual(computeDayStats(null, today), { net: 0, fees: 0, count: 0 });
  const s = computeDayStats([{ time: Date.now() }], today); // без closedPnl/fee
  assert.equal(s.count, 1);
  assert.equal(s.net, 0);
});

test('dailyRisk: fee без closedPnl (открытие позы) уменьшает net', () => {
  const now = Date.now();
  const s = computeDayStats([fill(now, '0', '0.15')], localDayKey(now));
  assert.ok(Math.abs(s.net - (-0.15)) < 1e-9);
  assert.ok(Math.abs(s.fees - 0.15) < 1e-9);
});
