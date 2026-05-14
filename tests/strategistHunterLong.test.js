// Тесты Strategy #3 Hunter LONG (Iter E.1): analyzeHunterLong pure logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';
// Тестируем дефолты из config (dump 3%, SL 2%, TP 3%).

const { push, clearAll } =
  await import('../src/core/priceHistory.js');
const {
  analyzeHunterLong, resetHunterLongCooldowns, consumeHunterLongMfeMae,
} = await import('../src/modules/strategistHunterLong.js');
const { resetHunterCrossCooldowns } = await import('../src/modules/hunterCrossCooldown.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function reset() {
  clearAll();
  resetHunterLongCooldowns();
  resetHunterCrossCooldowns();
}

function seedHistory(coin, basePrice, now) {
  push(coin, basePrice, now - 3 * MIN);
  push(coin, basePrice, now - 2 * MIN);
  push(coin, basePrice, now - 1 * MIN);
}

// ── Entry detection ─────────────────────────────────

test('IDLE + нет истории → HOLD', () => {
  reset();
  const r = analyzeHunterLong([{ coin: 'BTC', price: 50000 }], null, T0);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + ровный прайс → HOLD', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  const r = analyzeHunterLong([{ coin: 'BTC', price: 50000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + dump < threshold → HOLD', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // -2% за 2мин — не дотягивает до 3% дефолтного порога
  const r = analyzeHunterLong([{ coin: 'BTC', price: 49000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + pump (rise) → HOLD (long-after-dump игнорирует пампы)', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // +5% — это для Hunter SHORT, не для нас
  const r = analyzeHunterLong([{ coin: 'BTC', price: 52500 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + dump ≥ threshold → OPEN LONG с корректным SL/TP', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // -6% за 2мин
  const r = analyzeHunterLong([{ coin: 'BTC', price: 47000 }], null, now);

  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'hunter_long');
  assert.equal(r.coin, 'BTC');
  assert.equal(r.price, 47000);
  assert.equal(r.direction, 'LONG');
  // dumpPct отрицательный — это feature, не bug
  assert.ok(r.dumpPct <= -3, `dumpPct should be ≤ -3, got ${r.dumpPct}`);
  // SL = -2% от entry (47000 * 0.98)
  assert.equal(r.sl.toFixed(4), (47000 * 0.98).toFixed(4));
  // TP = +3% (47000 * 1.03)
  assert.equal(r.tp.toFixed(4), (47000 * 1.03).toFixed(4));
  assert.ok(r.entryFeatures);
  assert.equal(typeof r.entryFeatures.entry_hour_utc, 'number');
});

test('IDLE + cooldown после OPEN → следующий тик HOLD', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  const r1 = analyzeHunterLong([{ coin: 'BTC', price: 47000 }], null, now);
  assert.equal(r1.action, 'OPEN');
  // Сразу второй тик — cooldown активен
  const r2 = analyzeHunterLong([{ coin: 'BTC', price: 47000 }], null, now + 30_000);
  assert.equal(r2.action, 'HOLD');
});

test('Anti-trend filter: устойчивый downtrend ≥ 6% за 15мин → пропускаем dump', () => {
  reset();
  // Цена линейно падает: T-15min=53000, T-3min..-1min=50000 (≈-5.6% за 15мин),
  // сейчас 47000 — итого -11.3% за 15мин ⇒ trend < -6% ⇒ skip.
  const now = T0 + 20 * MIN;
  push('BTC', 53000, now - 15 * MIN);
  push('BTC', 50000, now - 3 * MIN);
  push('BTC', 50000, now - 2 * MIN);
  push('BTC', 50000, now - 1 * MIN);
  const r = analyzeHunterLong([{ coin: 'BTC', price: 47000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

// ── Exit logic ──────────────────────────────────────

test('CLOSE: цена ≤ sl_price → hunter_long_sl', () => {
  reset();
  const pos = {
    id: 1,
    coin: 'BTC',
    strategy_id: 'hunter_long',
    side: 'long',
    entry_price: 47000,
    sl_price:    47000 * 0.98,
    tp_price:    47000 * 1.03,
    entry_time:  Date.now(),
    size_usd:    50,
  };
  const r = analyzeHunterLong([{ coin: 'BTC', price: 46000 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_sl');
  assert.equal(r.price, pos.sl_price);
});

test('CLOSE: цена ≥ tp_price → hunter_long_tp', () => {
  reset();
  const pos = {
    id: 2,
    coin: 'BTC',
    strategy_id: 'hunter_long',
    side: 'long',
    entry_price: 47000,
    sl_price:    47000 * 0.98,
    tp_price:    47000 * 1.03,
    entry_time:  Date.now(),
    size_usd:    50,
  };
  const r = analyzeHunterLong([{ coin: 'BTC', price: 49000 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_tp');
  assert.equal(r.price, pos.tp_price);
});

test('CLOSE: time-stop срабатывает после HUNTER_LONG_TIME_STOP_MIN', () => {
  reset();
  const now = Date.now();
  const pos = {
    id: 3,
    coin: 'BTC',
    strategy_id: 'hunter_long',
    side: 'long',
    entry_price: 47000,
    sl_price:    47000 * 0.98,
    tp_price:    47000 * 1.03,
    entry_time:  now - 61 * MIN, // прошло >60 мин
    size_usd:    50,
  };
  const r = analyzeHunterLong([{ coin: 'BTC', price: 47100 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_long_time_stop');
});

test('Цена между SL и TP → HOLD + MFE/MAE накапливаются', () => {
  reset();
  const pos = {
    id: 4,
    coin: 'BTC',
    strategy_id: 'hunter_long',
    side: 'long',
    entry_price: 47000,
    sl_price:    47000 * 0.98,
    tp_price:    47000 * 1.03,
    entry_time:  Date.now(),
    size_usd:    50,
  };
  // Цена сначала отскочила — peak MFE
  let r = analyzeHunterLong([{ coin: 'BTC', price: 48000 }], pos);
  assert.equal(r.action, 'HOLD');
  // Потом просела — peak MAE
  r = analyzeHunterLong([{ coin: 'BTC', price: 46500 }], pos);
  assert.equal(r.action, 'HOLD');

  const mm = consumeHunterLongMfeMae(pos.id);
  assert.ok(mm, 'MFE/MAE должен быть записан');
  assert.ok(mm.mfeUsd > 0, `MFE>0 при +отскоке, got ${mm.mfeUsd}`);
  assert.ok(mm.maeUsd < 0, `MAE<0 при просадке, got ${mm.maeUsd}`);
});

// ── Coordinator routing intent (smoke test) ─────────

test('Slot занят другой стратегией → HOLD, hunter_long не вмешивается', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // dump ≥ 3%, но активна carry-позиция (не hunter_long) → ждём
  const r = analyzeHunterLong(
    [{ coin: 'BTC', price: 47000 }],
    { strategy_id: 'carry', coin: 'ETH' },
    now,
  );
  assert.equal(r.action, 'HOLD');
});
