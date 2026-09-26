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

const { agentAddress, agentValidUntil, liveAgentSnapshot } = await import('../src/app/agentExpiryWatch.js');
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

test('адрес агента выводится из ключа, битый ключ — null', () => {
  assert.equal(agentAddress(KEY), '0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  assert.equal(agentAddress('garbage'), null);
  assert.equal(agentAddress(null), null);
});

test('срок берётся из extraAgents по адресу ключа', () => {
  const address = agentAddress(KEY);
  const agents = [
    { name: 'old', address: '0x1111111111111111111111111111111111111111', validUntil: Date.parse('2026-10-09T10:00:00Z') },
    { name: 'helm', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', validUntil: Date.parse('2027-03-25T08:00:00Z') },
  ];
  assert.equal(agentValidUntil(agents, address), '2027-03-25T08:00:00.000Z');
  const snap = liveAgentSnapshot(agents, address, at('2026-09-26'));
  assert.equal(snap.status, 'pass');
  assert.equal(snap.expiryDate, '2027-03-25');
});

test('агента нет на аккаунте — fail и пометка missing', () => {
  const snap = liveAgentSnapshot([], agentAddress(KEY), at('2026-09-26'));
  assert.equal(snap.status, 'fail');
  assert.equal(snap.missing, true);
});
