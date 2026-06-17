// Тесты Hunter LONG в coordinator (Iter E.1).
// Отдельный файл от coordinator/hunterCoordinator: HUNTER_LONG_ENABLED ставится
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
process.env.HUNTER_ENABLED        = 'false';  // изолируем — только LONG включён
process.env.HUNTER_LONG_ENABLED   = 'true';

const { coordinate } = await import('../src/modules/coordinator.js');
const { push: pushPriceHistory, clearAll } =
  await import('../src/core/priceHistory.js');
const { resetHunterLongCooldowns } =
  await import('../src/modules/strategistHunterLong.js');
const { resetHunterCrossCooldowns } =
  await import('../src/modules/hunterCrossCooldown.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function resetAll() {
  clearAll();
  resetHunterLongCooldowns();
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

test('IDLE + dump ≥ 3% → coordinator выдаёт hunter_long OPEN LONG', async () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const r = await coordinate([scoutItem('MEME', 0.94, 80)], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.strategy_id, 'hunter_long');
    assert.equal(r.direction, 'LONG');
    assert.ok(r.sl < r.price);
    assert.ok(r.tp > r.price);
  } finally {
    restore();
  }
});

test('Активная hunter_long позиция → coordinator делегирует exit-check', async () => {
  resetAll();
  const pos = {
    id: 99,
    coin: 'BTC',
    strategy_id: 'hunter_long',
    side: 'long',
    entry_price: 47000,
    sl_price:    47000 * 0.98,
    tp_price:    47000 * 1.03,
    entry_time:  Date.now(),
    size_usd:    50,
  };
  // Цена выше TP → должен прийти CLOSE hunter_long_tp
  const r = await coordinate([scoutItem('BTC', 49000, 0)], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_tp');
});

test('Slot занят другой позой → hunter_long не пробивает даже при dump', async () => {
  // Single-slot: если позиция уже открыта (любой strategy_id), ветка открытия
  // не запускается — hunter_long не должен влезть.
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const r = await coordinate(
      [scoutItem('MEME', 0.94, 80)],
      { strategy_id: 'legacy', coin: 'ETH', entry_apy: 80 },
    );
    assert.notEqual(r.strategy_id, 'hunter_long');
  } finally {
    restore();
  }
});
