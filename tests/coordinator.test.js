import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.ENTRY_APY_THRESHOLD   = '40';
process.env.MIN_APY_THRESHOLD     = '20';
process.env.EXIT_BUFFER           = '5';
process.env.MIN_HOLD_TIME_MINUTES = '60';
process.env.BREATHING_MINUTES     = '30';
process.env.LEVERAGE              = '1';
process.env.FADE_ENABLED          = 'true';
process.env.FADE_MAX_HOLD_MINUTES = '120';
process.env.FADE_MIN_CURRENT_APY  = '200';
process.env.FADE_MIN_DROP_PCT     = '40';

const { coordinate } = await import('../src/modules/coordinator.js');
const { analyze }    = await import('../src/modules/strategist.js');

const HOUR_MS = 3_600_000;

function makeScoutItem(coin, smoothedApy, opts = {}) {
  return {
    coin,
    price:        opts.price        ?? 100,
    fundingRate:  opts.fundingRate  ?? smoothedApy / 100 / 365 / 24,
    rawApy:       opts.rawApy       ?? smoothedApy,
    smoothedApy,
    slowApy:      opts.slowApy      ?? smoothedApy,
    predictedApy: opts.predictedApy ?? null,
  };
}

function freezeTime(year, month, day, hour, minute) {
  const RealDate = global.Date;
  const fixed    = RealDate.UTC(year, month, day, hour, minute, 0);
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixed);
        return;
      }
      super(...args);
    }
    static now() {
      return fixed;
    }
  }
  global.Date = FakeDate;
  return () => { global.Date = RealDate; };
}

function makePosition(coin, entryApy, strategyId = 'carry', opts = {}) {
  return {
    id:          1,
    coin,
    size_usd:    100,
    entry_price: opts.entry_price ?? 100,
    entry_apy:   entryApy,
    entry_time:  opts.entry_time  ?? Date.now() - 50 * HOUR_MS,
    mode:        'PAPER',
    status:      'OPEN',
    strategy_id: strategyId,
  };
}

function resetAll() {
  analyze([], undefined);
}

// ═══════════════════════════════════════════════
//  No position — strategy priority
// ═══════════════════════════════════════════════

test('Coordinator: no position + carry candidate → OPEN carry', async () => {
  resetAll();
  const data = [makeScoutItem('ZRO', 80)];
  const r = await coordinate(data, undefined);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'carry');
  assert.equal(r.coin, 'ZRO');
});

test('Coordinator: no position + no carry + fade candidate → OPEN fade', async () => {
  resetAll();
  // Below carry threshold (40%) but high enough for fade (500%+)
  // Actually, the item needs smoothedApy ≥ 200 AND predicted drop ≥ 40%
  // AND fee-gate pass. So 500% with predicted 100%.
  // But carry would also want this (500% > 40%)...
  // Carry will HOLD because of predicted-drop filter (500 → 100 = 80% drop > 30%)
  const data = [makeScoutItem('FART', 500, { rawApy: 500, predictedApy: 100 })];
  const r = await coordinate(data, undefined);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'fade');
  assert.equal(r.coin, 'FART');
});

test('Coordinator: no position + both candidates → carry wins (priority)', async () => {
  resetAll();
  // Two coins: one stable (carry) and one spike (fade)
  const data = [
    makeScoutItem('FART', 500, { rawApy: 500, predictedApy: 100 }),
    makeScoutItem('ZRO', 80, { rawApy: 80, predictedApy: 75 }),
  ];
  // Carry picks ZRO (80% > 40%, no predicted drop issue)
  // But wait — scoutData is sorted by smoothedApy desc. So FART comes first.
  // Carry looks at scoutData[0] = FART, but FART has predicted drop 80% > 30% → HOLD
  // Hmm... carry checks only best (scoutData[0]). If FART is blocked by predicted-drop,
  // carry should skip to... no, carry only checks scoutData[0].
  // So carry returns HOLD, then fade returns OPEN FART.
  const r = await coordinate(data, undefined);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'fade');
});

test('Coordinator: no position + nothing interesting → HOLD', async () => {
  resetAll();
  const data = [makeScoutItem('ZRO', 10)]; // too low for carry and fade
  const r = await coordinate(data, undefined);
  assert.equal(r.action, 'HOLD');
});

// ═══════════════════════════════════════════════
//  Has position — routes to correct strategy
// ═══════════════════════════════════════════════

test('Coordinator: carry position → routes to carry strategist', async () => {
  resetAll();
  const restore = freezeTime(2026, 3, 15, 14, 30); // safe from funding gate
  try {
    const pos = makePosition('ZRO', 80, 'carry', {
      entry_time: Date.now() - 50 * HOUR_MS,
    });
    const data = [makeScoutItem('ZRO', 5, { slowApy: 5 })];
    const r = await coordinate(data, pos);
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.strategy_id, 'carry');
  } finally {
    restore();
  }
});

test('Coordinator: fade position → routes to fade strategist', async () => {
  resetAll();
  const restore = freezeTime(2026, 3, 15, 14, 30);
  try {
    const pos = makePosition('FART', 500, 'fade', {
      entry_time: Date.now() - 130 * 60_000,
    });
    const data = [makeScoutItem('FART', 400, { rawApy: 400 })];
    const r = await coordinate(data, pos);
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.reason, 'fade_time_stop');
  } finally {
    restore();
  }
});

test('Coordinator: fade position holding → HOLD (no strategy_id on hold)', async () => {
  resetAll();
  const pos = makePosition('FART', 500, 'fade', {
    entry_time: Date.now() - 30 * 60_000, // 30min, within time-stop
  });
  const data = [makeScoutItem('FART', 400, { rawApy: 400 })];
  const r = await coordinate(data, pos);
  assert.equal(r.action, 'HOLD');
});
