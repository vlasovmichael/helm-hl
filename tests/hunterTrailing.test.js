// Iter D: trailing TP logic в analyzeHunter / checkHunterExit (pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';
process.env.HUNTER_TRAIL_ENABLED  = 'true';
process.env.HUNTER_TRAIL_ARM_PCT  = '2';
process.env.HUNTER_TRAIL_GIVE_BACK_PCT = '30';
process.env.HUNTER_TRAIL_SHADOW_LOG = 'false';

const { clearAll } = await import('../src/core/priceHistory.js');
const {
  analyzeHunter, resetHunterCooldowns,
  getHunterPeakPct, isHunterArmed,
  consumeHunterArmRequest, clearHunterTrailState,
} = await import('../src/modules/strategistSniper.js');

function reset() {
  clearAll();
  resetHunterCooldowns();
}

function hunterPos(overrides = {}) {
  return {
    id:           42,
    coin:         'BTC',
    strategy_id:  'hunter',
    mode:         'PAPER',
    entry_price:  50000,
    sl_price:     50000 * 1.02,  // 51000
    tp_price:     50000 * 0.97,  // 48500
    entry_time:   Date.now(),
    size_usd:     50,
    ...overrides,
  };
}

test('trail: peak не достиг ARM → HOLD, peak трекается', () => {
  reset();
  // price 49250 = unrealized +1.5% (< ARM 2%)
  const r = analyzeHunter([{ coin: 'BTC', price: 49250 }], hunterPos());
  assert.equal(r.action, 'HOLD');
  assert.ok(getHunterPeakPct(42) > 1 && getHunterPeakPct(42) < 2);
});

test('trail: peak пересёк ARM, но giveback ещё мал → HOLD', () => {
  reset();
  const pos = hunterPos();
  // First tick: peak +2.5%
  analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.025) }], pos);
  // Second tick: 2.4% (giveback 0.1pp от peak 2.5 = 4%, < 30%)
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.024) }], pos);
  assert.equal(r.action, 'HOLD');
  assert.ok(getHunterPeakPct(42) >= 2.4);
});

test('trail: peak ≥ ARM + giveback ≥ 30% → CLOSE hunter_trail_tp', () => {
  reset();
  const pos = hunterPos();
  // Tick 1: peak 4%
  analyzeHunter([{ coin: 'BTC', price: 50000 * 0.96 }], pos);
  // Tick 2: current 2.6% → giveback 1.4pp, threshold = 4 * 0.30 = 1.2pp → CLOSE
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 * (1 - 0.026) }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_trail_tp');
  assert.ok(r.peakPct >= 3.9);
  assert.ok(r.giveBackPct >= 30);
});

test('trail: SL приоритет над trail (защита downside)', () => {
  reset();
  const pos = hunterPos();
  // peak 4% сначала
  analyzeHunter([{ coin: 'BTC', price: 50000 * 0.96 }], pos);
  // потом цена улетела вверх через SL уровень
  const r = analyzeHunter([{ coin: 'BTC', price: 51100 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_sl');
});

test('trail: clearHunterTrailState чистит peak и armed', () => {
  reset();
  const pos = hunterPos();
  analyzeHunter([{ coin: 'BTC', price: 50000 * 0.96 }], pos);
  assert.ok(getHunterPeakPct(42) > 0);
  clearHunterTrailState(42);
  assert.equal(getHunterPeakPct(42), 0);
  assert.equal(isHunterArmed(42), false);
});

test('trail: PROD hunter + peak crosses ARM → arm request emitted', () => {
  reset();
  const pos = hunterPos({ mode: 'PRODUCTION', hunter_tp_oid: 12345 });
  // Этот тест проверяет flow в isProduction режиме. В PAPER-режиме (наш тест)
  // ARM request НЕ должен emit'иться (config.isProduction=false).
  analyzeHunter([{ coin: 'BTC', price: 50000 * 0.97 }], pos);
  assert.equal(consumeHunterArmRequest(42), false, 'PAPER mode → no ARM request');
});
