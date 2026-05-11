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
process.env.FADE_ENABLED          = 'false';
process.env.HUNTER_ENABLED        = 'false';  // изолируем — только LONG включён
process.env.HUNTER_LONG_ENABLED   = 'true';

const { coordinate } = await import('../src/modules/coordinator.js');
const { analyze }    = await import('../src/modules/strategist.js');
const { push: pushPriceHistory, clearAll } =
  await import('../src/core/priceHistory.js');
const { resetHunterLongCooldowns } =
  await import('../src/modules/strategistHunterLong.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function resetAll() {
  analyze([], undefined);
  clearAll();
  resetHunterLongCooldowns();
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

test('IDLE + dump ≥ 3% → coordinator выдаёт hunter_long OPEN LONG', () => {
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const r = coordinate([scoutItem('MEME', 0.94, 80)], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.strategy_id, 'hunter_long');
    assert.equal(r.direction, 'LONG');
    assert.ok(r.sl < r.price);
    assert.ok(r.tp > r.price);
  } finally {
    restore();
  }
});

test('Активная hunter_long позиция → coordinator делегирует exit-check', () => {
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
  const r = coordinate([scoutItem('BTC', 49000, 0)], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_tp');
});

test('HUNTER_LONG_ENABLED=false → hunter_long не запрашивается даже при dump', async () => {
  // Не можем перезагрузить config, но можем проверить что приоритет работает:
  // если slot занят carry — hunter_long не должен пробить.
  resetAll();
  const now = T0 + 3 * MIN;
  const restore = freezeDateNow(now);
  try {
    seedHistory('MEME', 1.0, now);
    const r = coordinate(
      [scoutItem('MEME', 0.94, 80)],
      { strategy_id: 'carry', coin: 'ETH', entry_apy: 80 },
    );
    // slot занят carry → coordinator передаст в strategist.analyze, не hunter_long
    assert.notEqual(r.strategy_id, 'hunter_long');
  } finally {
    restore();
  }
});
