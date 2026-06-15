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
// Carry default-off с 2026-06-15 (стратегия снята). Ветка кода ещё есть —
// эти тесты её механику и проверяют, поэтому включаем флаг явно.
process.env.CARRY_ENABLED         = 'true';

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

// Fade-стратегия удалена 2026-06-15 — тесты «OPEN fade» / «fade priority» сняты.

test('Coordinator: no position + nothing interesting → HOLD', async () => {
  resetAll();
  const data = [makeScoutItem('ZRO', 10)]; // too low for carry
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

// Adopt Mode Iter 1 (SHADOW): подхваченная ручная поза занимает слот, но бот ею
// НЕ управляет — coordinator должен вернуть HOLD и НЕ провалиться в carry-fallback.
test('Coordinator: adopt position → HOLD (no carry fallback, keeps strategy_id)', async () => {
  resetAll();
  const pos = makePosition('NIL', 0, 'adopt', {
    entry_time: Date.now() - 5 * 60_000,
  });
  // Дать carry-кандидата на ту же монету: если бы coordinator провалился в carry,
  // он бы попытался ею управлять. Adopt-ветка обязана перехватить раньше.
  const data = [makeScoutItem('NIL', 80, { slowApy: 5 })];
  const r = await coordinate(data, pos);
  assert.equal(r.action, 'HOLD');
  assert.equal(r.strategy_id, 'adopt');
});
