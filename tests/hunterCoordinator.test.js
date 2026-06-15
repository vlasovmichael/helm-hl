// Тесты Hunter-интеграции в coordinator (Iter A.3).
//
// Отдельный файл от coordinator.test.js, потому что HUNTER_ENABLED ставится
// через ENV до импорта config.

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
process.env.FADE_ENABLED          = 'true';
process.env.FADE_MAX_HOLD_MINUTES = '120';
process.env.FADE_MIN_CURRENT_APY  = '200';
process.env.FADE_MIN_DROP_PCT     = '40';
process.env.HUNTER_ENABLED        = 'true';

const { coordinate } = await import('../src/modules/coordinator.js');
const { analyze }    = await import('../src/modules/strategist.js');
const { push: pushPriceHistory, clearAll } =
  await import('../src/core/priceHistory.js');
const { resetHunterCooldowns } =
  await import('../src/modules/strategistSniper.js');
const { resetHunterCrossCooldowns } =
  await import('../src/modules/hunterCrossCooldown.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function resetAll() {
  analyze([], undefined);
  clearAll();
  resetHunterCooldowns();
  resetHunterCrossCooldowns();
}

function scoutItem(coin, price, smoothedApy = 0) {
  return {
    coin, price,
    fundingRate: smoothedApy / 100 / 365 / 24,
    rawApy: smoothedApy, smoothedApy, slowApy: smoothedApy, predictedApy: null,
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

// ── IDLE + spike → Hunter приоритет ─────────────

test('IDLE + spike → Hunter OPEN (перебивает carry даже если тот бы взял)', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    // MEME с +6% спайком и APY 80% (carry тоже хочет)
    const r = await coordinate(
      [scoutItem('MEME', 1.06, 80)],
      undefined,
    );
    assert.equal(r.action, 'OPEN');
    assert.equal(r.strategy_id, 'hunter');
    assert.equal(r.coin, 'MEME');
    assert.equal(r.direction, 'SHORT');
    assert.ok(r.sl > r.price, 'SL должен быть выше entry для short');
    assert.ok(r.tp < r.price, 'TP должен быть ниже entry для short');
  } finally {
    restore();
  }
});

test('IDLE + no spike + carry кандидат → carry работает (hunter не мешает)', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('ZRO', 100, now);  // ровный прайс, без спайка
    const r = await coordinate([scoutItem('ZRO', 100, 80)], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.strategy_id, 'carry');
  } finally {
    restore();
  }
});

test('IDLE + spike на одной, carry-кандидат на другой → Hunter приоритет', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    seedHistory('ZRO', 100, now);
    const r = await coordinate(
      [
        scoutItem('MEME', 1.06, 5),   // spike но низкий APY
        scoutItem('ZRO', 100, 80),     // нет spike, но APY годный
      ],
      undefined,
    );
    assert.equal(r.action, 'OPEN');
    assert.equal(r.strategy_id, 'hunter');
    assert.equal(r.coin, 'MEME');
  } finally {
    restore();
  }
});

test('IDLE + dump → Hunter HOLD (short-only), carry подбирает если подходит', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    // -6% dump → Hunter HOLD, но APY=0 → carry тоже HOLD
    const r = await coordinate([scoutItem('MEME', 0.94, 0)], undefined);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

// ── Hunter position → маршрутизация в analyzeHunter ──

function hunterPos(coin = 'MEME', entry = 1.0) {
  return {
    id: 99, coin,
    size_usd:    25,
    entry_price: entry,
    entry_apy:   0,
    entry_time:  Date.now() - 10 * MIN,
    mode:        'PAPER',
    status:      'OPEN',
    strategy_id: 'hunter',
    sl_price:    entry * 1.02,
    tp_price:    entry * 0.97,
  };
}

test('Hunter position + price ≥ SL → CLOSE hunter_sl', async () => {
  resetAll();
  const pos = hunterPos('MEME', 1.0);
  const r = await coordinate([scoutItem('MEME', 1.025, 0)], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_sl');
});

test('Hunter position + price ≤ TP → CLOSE hunter_tp', async () => {
  resetAll();
  const pos = hunterPos('MEME', 1.0);
  const r = await coordinate([scoutItem('MEME', 0.96, 0)], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_tp');
});

test('Hunter position + price между уровнями → HOLD', async () => {
  resetAll();
  const pos = hunterPos('MEME', 1.0);
  const r = await coordinate([scoutItem('MEME', 1.0, 0)], pos);
  assert.equal(r.action, 'HOLD');
});

test('Carry position остаётся → Hunter не эвиктит (Iter A)', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const carryPos = {
      id: 1, coin: 'ZRO', size_usd: 100, entry_price: 100, entry_apy: 80,
      entry_time: Date.now() - 5 * MIN, mode: 'PAPER', status: 'OPEN', strategy_id: 'carry',
    };
    // Жирный спайк по MEME, но carry-позиция активна
    const r = await coordinate([scoutItem('MEME', 1.10, 5), scoutItem('ZRO', 100, 80)], carryPos);
    // coordinator направил в carry-стратегию → её решение (HOLD или CLOSE по слабому APY)
    assert.notEqual(r.action, 'OPEN');
    assert.notEqual(r.strategy_id, 'hunter');
  } finally {
    restore();
  }
});
