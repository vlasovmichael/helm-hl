// Срок API-агента: границы календарных дат не должны сдвигаться из-за времени запуска.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { agentExpirySnapshot, agentExpiryAlert, parseAgentExpiry } =
  await import('../src/app/agentExpiryWatch.js');

const EXPIRES = '2026-10-09';
const at = (date) => Date.parse(`${date}T12:00:00.000Z`);

test('дата без времени действует до конца указанного UTC-дня', () => {
  const expiry = parseAgentExpiry(EXPIRES);
  assert.equal(expiry.date, EXPIRES);
  assert.equal(expiry.at, Date.parse('2026-10-10T00:00:00.000Z'));
});

test('urgent-границы срабатывают ровно за 14, 7 и 2 календарных дня', () => {
  for (const [date, expected] of [
    ['2026-09-24', null],
    ['2026-09-25', 14],
    ['2026-10-01', null],
    ['2026-10-02', 7],
    ['2026-10-06', null],
    ['2026-10-07', 2],
  ]) {
    assert.equal(agentExpiryAlert(agentExpirySnapshot(EXPIRES, at(date))), expected, date);
  }
});

test('health-плашка желтеет за 14 дней, краснеет за два и после истечения', () => {
  assert.equal(agentExpirySnapshot(EXPIRES, at('2026-09-24')).status, 'pass');
  assert.equal(agentExpirySnapshot(EXPIRES, at('2026-09-25')).status, 'warn');
  assert.equal(agentExpirySnapshot(EXPIRES, at('2026-10-07')).status, 'fail');
  assert.equal(agentExpirySnapshot(EXPIRES, at('2026-10-10')).status, 'fail');
});
