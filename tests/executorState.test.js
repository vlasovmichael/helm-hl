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
