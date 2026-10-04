// Поведенческий контракт runtime-банов и предохранителей executor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const state = await import('../src/modules/executor/state.js');

function withClock(start, run) {
  const saved = Date.now;
  let now = start;
  Date.now = () => now;
  try { return run((next) => { now = next; }); } finally { Date.now = saved; }
}

test('OI-cap ban наращивает TTL, ограничивает его потолком и истекает', () => withClock(1_000_000, (setNow) => {
  const coin = 'STATE-OI-A';
  assert.deepEqual(state.banOiCap(coin), { count: 1, ttlMs: state.OI_CAP_BAN_BASE_MS });
  assert.equal(state.isOiCapBanned(coin), true);
  assert.equal(state.getOiCapBanRemainMs(coin), state.OI_CAP_BAN_BASE_MS);
  setNow(1_000_001);
  assert.deepEqual(state.banOiCap(coin), { count: 2, ttlMs: state.OI_CAP_BAN_BASE_MS * 2 });
  state.banOiCap(coin);
  assert.equal(state.banOiCap(coin).ttlMs, state.OI_CAP_BAN_MAX_MS);
  setNow(1_000_001 + state.OI_CAP_BAN_MAX_MS + 1);
  assert.equal(state.isOiCapBanned(coin), false);
  assert.equal(state.getOiCapBanRemainMs(coin), 0);
}));

test('OI-cap state сохраняет только актуальное и восстанавливает новый и старый форматы', () => withClock(2_000_000, (setNow) => {
  const fresh = 'STATE-OI-SERIAL';
  state.banOiCap(fresh);
  const saved = state.serializeOiCapBans();
  assert.equal(saved.bans[fresh], 2_000_000 + state.OI_CAP_BAN_BASE_MS);
  assert.deepEqual(saved.repeat[fresh], { count: 1, lastBannedAt: 2_000_000 });
  state.restoreOiCapBans({ bans: { 'STATE-OI-NEW': 2_000_100 }, repeat: { 'STATE-OI-NEW': { count: 2, lastBannedAt: 2_000_000 } } });
  state.restoreOiCapBans({ 'STATE-OI-OLD': 2_000_100 });
  assert.deepEqual([...state.getOiCapBans()].sort(), ['STATE-OI-NEW', 'STATE-OI-OLD', fresh].sort());
  setNow(2_000_101);
  assert.equal(state.getOiCapBans().has('STATE-OI-NEW'), false);
  state.restoreOiCapBans(null);
  state.restoreOiCapBans({ bans: { bad: 'tomorrow' }, repeat: { bad: { count: '2', lastBannedAt: 0 } } });
}));

test('повтор OI-cap после суток тишины начинает первый tier заново', () => withClock(3_000_000, (setNow) => {
  const coin = 'STATE-OI-RESET';
  state.banOiCap(coin);
  setNow(3_000_000 + state.OI_CAP_REPEAT_RESET_MS + 1);
  assert.deepEqual(state.banOiCap(coin), { count: 1, ttlMs: state.OI_CAP_BAN_BASE_MS });
}));

test('runtime, slippage и cooldown блокируют монету до своих TTL', () => withClock(4_000_000, (setNow) => {
  state.banRuntime('STATE-RUNTIME');
  state.banSlippage('STATE-SLIP');
  state.setCooldown('STATE-COOL');
  assert.deepEqual([...state.getRuntimeBlacklist()].sort(), ['STATE-COOL', 'STATE-RUNTIME', 'STATE-SLIP']);
  const snapshot = state.getStateSnapshot();
  assert.equal(snapshot.runtimeBans[0].remainMs, state.RUNTIME_BAN_TTL_MS);
  assert.equal(snapshot.slippageBans[0].remainMs, state.SLIPPAGE_BAN_TTL_MS);
  assert.equal(snapshot.cooldowns[0].remainMs, state.REENTRY_COOLDOWN_MS);
  setNow(4_000_000 + state.RUNTIME_BAN_TTL_MS + 1);
  assert.deepEqual([...state.getRuntimeBlacklist()], []);
}));

test('отметка rejected alert читается по монете, а границы TTL ещё активны', () => withClock(4_500_000, (setNow) => {
  state.setRejectedAlert('STATE-ALERT');
  assert.equal(state.getLastRejectedAlert('STATE-ALERT'), 4_500_000);
  state.banRuntime('STATE-RUNTIME-EDGE');
  state.banSlippage('STATE-SLIP-EDGE');
  state.setCooldown('STATE-COOL-EDGE');
  setNow(4_500_000 + state.REENTRY_COOLDOWN_MS);
  assert.deepEqual([...state.getRuntimeBlacklist()].sort(), ['STATE-RUNTIME-EDGE']);
  setNow(4_500_000 + state.SLIPPAGE_BAN_TTL_MS);
  assert.deepEqual([...state.getRuntimeBlacklist()], ['STATE-RUNTIME-EDGE']);
  setNow(4_500_000 + state.RUNTIME_BAN_TTL_MS);
  assert.deepEqual([...state.getRuntimeBlacklist()], []);
}));

test('circuit breaker хранит только убытки окна, сериализуется и возвращает остаток паузы', () => withClock(5_000_000, (setNow) => {
  for (let i = 1; i <= state.CB_MAX_LOSSES; i++) {
    assert.equal(state.recordLoss(`STATE-LOSS-${i}`, -i), i === state.CB_MAX_LOSSES);
  }
  assert.deepEqual(state.getCircuitBreakerStatus(), { broken: true, remainMs: state.CB_PAUSE_MS, losses: state.CB_MAX_LOSSES });
  const saved = state.serializeCircuitBreaker();
  assert.equal(saved.recent_losses.length, state.CB_MAX_LOSSES);
  assert.equal(saved.broken_until, 5_000_000 + state.CB_PAUSE_MS);
  setNow(saved.broken_until + 1);
  assert.equal(state.getCircuitBreakerStatus().broken, false);
  state.restoreCircuitBreaker({ recent_losses: [{ ts: saved.broken_until + 1, pnl: -1, coin: 'STATE-RESTORE' }], broken_until: 5_000_100 });
  assert.equal(state.getCircuitBreakerStatus().losses, 1);
}));

test('restore circuit breaker игнорирует мусор, очищает старые убытки и восстанавливает живую паузу', () => withClock(20_000_000, (setNow) => {
  state.restoreCircuitBreaker({
    recent_losses: [null, { ts: 20_000_000 - state.CB_WINDOW_MS, pnl: -2, coin: 'EDGE' }, { ts: 20_000_000 - state.CB_WINDOW_MS - 1, pnl: -3, coin: 'OLD' }],
    broken_until: 20_000_500,
  });
  assert.deepEqual(state.getCircuitBreakerStatus(), { broken: true, remainMs: 500, losses: 1 });
  assert.deepEqual(state.serializeCircuitBreaker().recent_losses, [{ ts: 20_000_000 - state.CB_WINDOW_MS, pnl: -2, coin: 'EDGE' }]);
  setNow(20_000_501);
  assert.deepEqual(state.getCircuitBreakerStatus(), { broken: false, remainMs: 0, losses: 0 });
  state.restoreCircuitBreaker('bad');
}));

test('drawdown отмечает порог включительно и не делит на нулевой стартовый equity', () => {
  assert.deepEqual(state.checkDrawdown(90, 100), { breached: true, drawdownPct: 10 });
  assert.deepEqual(state.checkDrawdown(91, 100), { breached: false, drawdownPct: 9 });
  assert.deepEqual(state.checkDrawdown(0, 0), { breached: false, drawdownPct: 0 });
});

test('OI-cap различает точную границу TTL и не сериализует истёкшие ban/repeat', () => withClock(30_000_000, (setNow) => {
  const boundary = 'STATE-OI-EXACT-BOUNDARY';
  const active = 'STATE-OI-EXACT-ACTIVE';
  const expired = 'STATE-OI-EXACT-EXPIRED';
  state.banOiCap(boundary);
  setNow(30_000_000 + state.OI_CAP_BAN_BASE_MS);
  assert.equal(state.isOiCapBanned(boundary), true);
  assert.equal(state.getOiCapBanRemainMs(boundary), 0);
  setNow(30_000_000);
  state.restoreOiCapBans({
    bans: {
      [active]: 30_000_000,
      [expired]: 29_999_999,
    },
    repeat: {
      [active]: { count: 2, lastBannedAt: 30_000_000 - state.OI_CAP_REPEAT_RESET_MS },
      [expired]: { count: 3, lastBannedAt: 30_000_000 - state.OI_CAP_REPEAT_RESET_MS - 1 },
    },
  });
  assert.equal(state.isOiCapBanned(active), false);
  assert.equal(state.isOiCapBanned(expired), false);
  assert.deepEqual(state.serializeOiCapBans().bans[active], undefined);
  assert.equal(state.serializeOiCapBans().repeat[active].count, 2);
  assert.equal(state.serializeOiCapBans().repeat[expired], undefined);
  setNow(30_000_001);
  assert.equal(state.getOiCapBans().has(active), false);
}));

test('restore OI-cap принимает только живые числовые записи и валидный repeat', () => withClock(40_000_000, () => {
  state.restoreOiCapBans({
    bans: {
      'STATE-OI-VALID': 40_000_100,
      'STATE-OI-STRING': '40000100',
      'STATE-OI-PAST': 39_999_999,
    },
    repeat: {
      'STATE-OI-VALID': { count: 2, lastBannedAt: 40_000_000 },
      'STATE-OI-BAD-COUNT': { count: '2', lastBannedAt: 40_000_000 },
      'STATE-OI-BAD-TIME': { count: 2, lastBannedAt: 'now' },
      'STATE-OI-NULL': null,
    },
  });
  assert.equal(state.getOiCapBans().has('STATE-OI-VALID'), true);
  assert.equal(state.getOiCapBans().has('STATE-OI-STRING'), false);
  assert.equal(state.getOiCapBans().has('STATE-OI-PAST'), false);
  assert.deepEqual(state.banOiCap('STATE-OI-VALID'), { count: 3, ttlMs: state.OI_CAP_BAN_MAX_MS });
  assert.deepEqual(state.banOiCap('STATE-OI-BAD-COUNT'), { count: 1, ttlMs: state.OI_CAP_BAN_BASE_MS });
  assert.deepEqual(state.banOiCap('STATE-OI-BAD-TIME'), { count: 1, ttlMs: state.OI_CAP_BAN_BASE_MS });
}));

test('circuit breaker удаляет старые убытки при записи и сохраняет нормализованный restore', () => withClock(50_000_000, (setNow) => {
  state.restoreCircuitBreaker({
    recent_losses: [
      { ts: 50_000_000 - state.CB_WINDOW_MS - 1, pnl: -9, coin: 'STATE-OLD' },
      { ts: 50_000_000 - state.CB_WINDOW_MS, pnl: -2, coin: 'STATE-EDGE' },
      { ts: 50_000_000, pnl: undefined, coin: undefined },
      { ts: 'bad', pnl: -3, coin: 'STATE-BAD' },
    ],
    broken_until: 50_000_000,
  });
  assert.deepEqual(state.serializeCircuitBreaker().recent_losses.slice(-2), [
    { ts: 50_000_000 - state.CB_WINDOW_MS, pnl: -2, coin: 'STATE-EDGE' },
    { ts: 50_000_000, pnl: 0, coin: '?' },
  ]);
  assert.equal(state.getCircuitBreakerStatus().broken, false);
  setNow(50_000_000 + state.CB_WINDOW_MS + 1);
  state.recordLoss('STATE-NEW', -1);
  assert.deepEqual(state.serializeCircuitBreaker().recent_losses, [{ ts: 50_000_000 + state.CB_WINDOW_MS + 1, pnl: -1, coin: 'STATE-NEW' }]);
}));

test('snapshot показывает только активные записи и остаток убывает со временем', () => withClock(60_000_000, (setNow) => {
  state.banRuntime('STATE-SNAPSHOT-RUNTIME');
  state.banSlippage('STATE-SNAPSHOT-SLIP');
  state.setCooldown('STATE-SNAPSHOT-COOL');
  setNow(60_000_001);
  const snapshot = state.getStateSnapshot();
  assert.deepEqual(snapshot.runtimeBans.find((entry) => entry.coin === 'STATE-SNAPSHOT-RUNTIME'), {
    coin: 'STATE-SNAPSHOT-RUNTIME', bannedAt: 60_000_000, remainMs: state.RUNTIME_BAN_TTL_MS - 1,
  });
  assert.equal(snapshot.slippageBans.find((entry) => entry.coin === 'STATE-SNAPSHOT-SLIP').remainMs, state.SLIPPAGE_BAN_TTL_MS - 1);
  assert.equal(snapshot.cooldowns.find((entry) => entry.coin === 'STATE-SNAPSHOT-COOL').remainMs, state.REENTRY_COOLDOWN_MS - 1);
}));

test('runtime-ban TTL истекают ровно на границе и исчезают из snapshot', () => withClock(70_000_000, (setNow) => {
  state.banRuntime('STATE-TTL-RUNTIME');
  state.banSlippage('STATE-TTL-SLIP');
  state.setCooldown('STATE-TTL-COOL');
  setNow(70_000_000 + state.REENTRY_COOLDOWN_MS);
  const snapshot = state.getStateSnapshot();
  assert.equal(snapshot.blockedCoins.includes('STATE-TTL-COOL'), false);
  assert.equal(snapshot.blockedCoins.includes('STATE-TTL-SLIP'), false);
  assert.equal(snapshot.blockedCoins.includes('STATE-TTL-RUNTIME'), true);
  assert.equal(snapshot.cooldowns.some((entry) => entry.coin === 'STATE-TTL-COOL'), false);
  setNow(70_000_000 + state.RUNTIME_BAN_TTL_MS);
  assert.equal(state.getStateSnapshot().blockedCoins.includes('STATE-TTL-RUNTIME'), false);
}));

test('circuit breaker снимается ровно на границе паузы', () => withClock(80_000_000, (setNow) => {
  for (let i = 0; i < state.CB_MAX_LOSSES; i++) state.recordLoss(`STATE-PAUSE-${i}`, -1);
  setNow(80_000_000 + state.CB_PAUSE_MS);
  assert.deepEqual(state.getCircuitBreakerStatus(), { broken: false, remainMs: 0, losses: 0 });
  assert.equal(state.serializeCircuitBreaker().broken_until, 0);
}));

test('OI-cap repeat сохраняется на точной границе окна, а Set исключает срок ровно сейчас', () => withClock(90_000_000, (setNow) => {
  const repeated = 'STATE-OI-REPEAT-EDGE';
  const expiring = 'STATE-OI-SET-EDGE';
  state.restoreOiCapBans({
    bans: { [expiring]: 90_000_000 + state.OI_CAP_BAN_BASE_MS },
    repeat: { [repeated]: { count: 2, lastBannedAt: 90_000_000 - state.OI_CAP_REPEAT_RESET_MS } },
  });
  assert.deepEqual(state.banOiCap(repeated), { count: 3, ttlMs: state.OI_CAP_BAN_MAX_MS });
  setNow(90_000_000 + state.OI_CAP_BAN_BASE_MS);
  assert.equal(state.getOiCapBans().has(expiring), false);
  assert.equal(state.getOiCapBanRemainMs(expiring), 0);
}));

test('повреждённый circuit-breaker state не превращается в активную паузу', () => withClock(100_000_000, () => {
  state.restoreCircuitBreaker({ recent_losses: [], broken_until: 'tomorrow' });
  assert.equal(state.serializeCircuitBreaker().broken_until, 0);
  state.restoreCircuitBreaker({ recent_losses: [], broken_until: 100_000_001 });
  assert.deepEqual(state.getCircuitBreakerStatus(), { broken: true, remainMs: 1, losses: 0 });
}));
