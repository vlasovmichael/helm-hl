import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта модуля ─────────────────────
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

const { analyzeFade, resetFadeState } =
  await import('../src/modules/strategistFade.js');

// ── Хелперы ───────────────────────────────────
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

function makePosition(coin, entryApy, opts = {}) {
  return {
    id:          1,
    coin,
    size_usd:    100,
    entry_price: opts.entry_price ?? 100,
    entry_apy:   entryApy,
    entry_time:  opts.entry_time  ?? Date.now() - 50 * HOUR_MS,
    mode:        'PAPER',
    status:      'OPEN',
    strategy_id: 'fade',
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

// ═══════════════════════════════════════════════
//  Entry tests
// ═══════════════════════════════════════════════

test('Fade OPEN: high APY + predicted drop → OPEN', () => {
  resetFadeState();
  // 500% current, predicted 200% → 60% drop > 40% threshold
  const data = [makeScoutItem('FART', 500, { rawApy: 500, predictedApy: 200 })];
  const r = analyzeFade(data, undefined);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin, 'FART');
  assert.equal(r.strategy_id, 'fade');
});

test('Fade HOLD: high APY but no predicted data → skip', () => {
  resetFadeState();
  const data = [makeScoutItem('FART', 500, { rawApy: 500, predictedApy: null })];
  const r = analyzeFade(data, undefined);
  assert.equal(r.action, 'HOLD');
});

test('Fade HOLD: APY below fadeMinCurrentApy → skip', () => {
  resetFadeState();
  const data = [makeScoutItem('FART', 150, { rawApy: 150, predictedApy: 50 })];
  const r = analyzeFade(data, undefined);
  assert.equal(r.action, 'HOLD');
});

test('Fade HOLD: predicted drop < threshold → skip', () => {
  resetFadeState();
  // 300% → 250% = 17% drop < 40% threshold
  const data = [makeScoutItem('FART', 300, { rawApy: 300, predictedApy: 250 })];
  const r = analyzeFade(data, undefined);
  assert.equal(r.action, 'HOLD');
});

test('Fade HOLD: APY too low for fee-gate (breakeven > max hold)', () => {
  resetFadeState();
  // 210% APY with predicted drop — but breakeven is ~4h, > 2h max hold
  // hoursToBreakeven(210) = 0.001 / (210/100/365/24) = 0.001 / 0.00002397 ≈ 41.7h
  // Wait, 210% is not enough for 2h breakeven. Need ~438%+
  // Let me use 250% — breakeven ≈ 0.001 / (250/8760/100) = 35h — still too high
  // Actually: 250/100/365/24 = 0.00002854, breakeven = 0.001/0.00002854 = 35h
  // This should HOLD (fee-gate blocks)
  const data = [makeScoutItem('FART', 250, { rawApy: 250, predictedApy: 100 })];
  const r = analyzeFade(data, undefined);
  assert.equal(r.action, 'HOLD');
});

test('Fade OPEN: extremely high APY passes fee-gate', () => {
  resetFadeState();
  // 1000% APY: hoursToBreakeven = 0.001 / (1000/100/365/24) = 0.001/0.0001141 ≈ 8.76h
  // Still > 2h max hold... Need even higher.
  // For 2h breakeven: need hourlyRate ≥ 0.001/2 = 0.0005
  // APY = 0.0005 * 100 * 365 * 24 = 438%
  // For 500%: breakeven = 0.001 / (500/876000) = 0.001/0.000571 ≈ 1.75h < 2h ✓
  // Hmm wait: 500/100 = 5, /365 = 0.01370, /24 = 0.000571
  // breakeven = 0.001 / 0.000571 = 1.75h < 2h ✓
  const data = [makeScoutItem('FART', 500, { rawApy: 500, predictedApy: 100 })];
  const r = analyzeFade(data, undefined);
  assert.equal(r.action, 'OPEN');
});

// ═══════════════════════════════════════════════
//  Position management: time-stop
// ═══════════════════════════════════════════════

test('Fade time-stop: held < max → HOLD', () => {
  resetFadeState();
  const pos = makePosition('FART', 500, {
    entry_time: Date.now() - 60 * 60_000, // 60min < 120min
  });
  const data = [makeScoutItem('FART', 400, { rawApy: 400 })];
  const r = analyzeFade(data, pos);
  assert.equal(r.action, 'HOLD');
});

test('Fade time-stop: held ≥ max → CLOSE', () => {
  resetFadeState();
  const restore = freezeTime(2026, 3, 15, 14, 30); // safe from funding gate
  try {
    const pos = makePosition('FART', 500, {
      entry_time: Date.now() - 130 * 60_000,
    });
    const data = [makeScoutItem('FART', 400, { rawApy: 400 })];
    const r = analyzeFade(data, pos);
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.reason, 'fade_time_stop');
  } finally {
    restore();
  }
});

test('Fade time-stop: respects funding gate', () => {
  resetFadeState();
  // Freeze time to HH:55 (5min to payout, within 10min gate)
  const restore = freezeTime(2026, 3, 15, 14, 55);
  try {
    const pos = makePosition('FART', 500, {
      entry_time: Date.now() - 130 * 60_000,
    });
    const data = [makeScoutItem('FART', 400, { rawApy: 400 })];
    const r = analyzeFade(data, pos);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════
//  Emergency exits
// ═══════════════════════════════════════════════

test('Fade: price spike → CLOSE', () => {
  resetFadeState();
  const pos = makePosition('FART', 500, { entry_price: 100 });
  const data = [makeScoutItem('FART', 400, { price: 115, rawApy: 400 })];
  const r = analyzeFade(data, pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'price_spike_protection');
});

test('Fade: negative funding 2 ticks → CLOSE', () => {
  resetFadeState();
  const pos = makePosition('FART', 500, {
    entry_time: Date.now() - 30 * 60_000, // 30min — within time-stop window
  });
  const data = [makeScoutItem('FART', -5, { fundingRate: -0.001, rawApy: -5 })];

  const r1 = analyzeFade(data, pos);
  assert.equal(r1.action, 'HOLD');

  const r2 = analyzeFade(data, pos);
  assert.equal(r2.action, 'CLOSE');
  assert.equal(r2.reason, 'negative_funding');
});

test('Fade: delist hysteresis 3 ticks → CLOSE', () => {
  resetFadeState();
  const pos = makePosition('FART', 500);
  const empty = [];

  const r1 = analyzeFade(empty, pos);
  assert.equal(r1.action, 'HOLD');
  const r2 = analyzeFade(empty, pos);
  assert.equal(r2.action, 'HOLD');
  const r3 = analyzeFade(empty, pos);
  assert.equal(r3.action, 'CLOSE');
  assert.equal(r3.reason, 'delisted');
});

test('Fade: delist cooldown blocks re-entry', () => {
  resetFadeState();
  const pos = makePosition('FART', 500);

  // Trigger delist
  analyzeFade([], pos);
  analyzeFade([], pos);
  const r = analyzeFade([], pos);
  assert.equal(r.action, 'CLOSE');

  // Now try to enter FART again — should be blocked by cooldown
  const data = [makeScoutItem('FART', 600, { rawApy: 600, predictedApy: 100 })];
  const r2 = analyzeFade(data, undefined);
  assert.equal(r2.action, 'HOLD');
});
