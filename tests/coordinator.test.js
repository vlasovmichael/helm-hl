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
process.env.HUNTER_ENABLED        = 'true';

const { coordinate } = await import('../src/modules/coordinator.js');
const { push: pushPriceHistory, clearAll } =
  await import('../src/core/priceHistory.js');
const { resetHunterCooldowns } =
  await import('../src/modules/strategistSniper.js');
const { resetHunterCrossCooldowns } =
  await import('../src/modules/hunterCrossCooldown.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function resetAll() {
  clearAll();
  resetHunterCooldowns();
  resetHunterCrossCooldowns();
}

function scoutItem(coin, price, smoothedApy = 0) {
  return {
    coin, price,
    fundingRate:  smoothedApy / 100 / 365 / 24,
    rawApy:       smoothedApy,
    smoothedApy,
    slowApy:      smoothedApy,
    predictedApy: null,
  };
}

function seedHistory(coin, basePrice, now) {
  pushPriceHistory(coin, basePrice, now - 3 * MIN);
  pushPriceHistory(coin, basePrice, now - 2 * MIN);
  pushPriceHistory(coin, basePrice, now - 1 * MIN);
}

function freezeDateNow(ts) {
  const RealDate = global.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(ts);
      else super(...args);
    }
    static now() { return ts; }
  }
  global.Date = FakeDate;
  return () => { global.Date = RealDate; };
}

function makePosition(coin, strategyId, opts = {}) {
  return {
    id:          1,
    coin,
    size_usd:    100,
    entry_price: opts.entry_price ?? 100,
    entry_apy:   opts.entry_apy   ?? 0,
    entry_time:  opts.entry_time  ?? Date.now() - 5 * MIN,
    mode:        'PAPER',
    status:      'OPEN',
    strategy_id: strategyId,
  };
}

// ═══════════════════════════════════════════════
//  No position — strategy priority
// ═══════════════════════════════════════════════

test('Coordinator: no position + spike → OPEN hunter', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const r = await coordinate([scoutItem('MEME', 1.06, 80)], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.strategy_id, 'hunter');
    assert.equal(r.coin, 'MEME');
  } finally {
    restore();
  }
});

test('Coordinator: no position + nothing interesting → HOLD', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('ZRO', 100, now);
    const r = await coordinate([scoutItem('ZRO', 100, 10)], undefined);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════
//  excludeCoins — бот не лезет в монету оператора (WLD 2026-06-16)
// ═══════════════════════════════════════════════

test('Coordinator: excludeCoins блокирует открытие на монете оператора → HOLD', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const data = [scoutItem('MEME', 1.06, 80)]; // обычно дал бы OPEN hunter
    const r = await coordinate(data, undefined, data, new Set(['MEME']));
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

test('Coordinator: excludeCoins не трогает прочие монеты → OPEN', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const data = [scoutItem('MEME', 1.06, 80)];
    // Юзер сидит в другой монете — MEME остаётся валидным кандидатом.
    const r = await coordinate(data, undefined, data, new Set(['WLD']));
    assert.equal(r.action, 'OPEN');
    assert.equal(r.coin, 'MEME');
  } finally {
    restore();
  }
});

test('Coordinator: excludeCoins регистронезависимо (lowercase coin)', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('meme', 1.0, now);
    const data = [scoutItem('meme', 1.06, 80)];
    const r = await coordinate(data, undefined, data, new Set(['MEME']));
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════
//  Has position — routes to correct strategy
// ═══════════════════════════════════════════════

// Adopt Mode (SHADOW): подхваченная ручная поза занимает слот, но бот ею НЕ
// управляет — coordinator должен вернуть HOLD и НЕ провалиться в открытие.
test('Coordinator: adopt position → HOLD (keeps strategy_id)', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('NIL', 1.0, now);
    const pos = makePosition('NIL', 'adopt');
    // Жирный спайк на той же монете: adopt-ветка обязана перехватить раньше.
    const r = await coordinate([scoutItem('NIL', 1.10, 80)], pos);
    assert.equal(r.action, 'HOLD');
    assert.equal(r.strategy_id, 'adopt');
  } finally {
    restore();
  }
});

// Легаси-поза без распознанного strategy_id (carry удалён 2026-06-17): coordinator
// больше её не ведёт — возвращает HOLD, не открывая ничего поверх.
test('Coordinator: legacy position → HOLD', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('ZRO', 100, now);
    const pos = makePosition('ZRO', 'legacy');
    const r = await coordinate([scoutItem('ZRO', 100, 80)], pos);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});
