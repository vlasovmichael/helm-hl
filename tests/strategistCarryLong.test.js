// Iter 1.2: тесты симметричной long-стороны strategist.
//
// Запуск: npm test
//
// Конвенция scout-данных под CARRY_LONG_ENABLED:
//   - smoothedApy/slowApy несут знак: положительный для short-кандидата
//     (положительный funding), отрицательный для long-кандидата
//     (отрицательный funding — шорты платят лонгам)
//   - sортировка по abs(apy)
//
// Конвенция position:
//   - position.side ∈ {'short', 'long'}; default 'short' (миграция Iter 1.0)

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
process.env.CARRY_LONG_ENABLED    = 'true';

const { analyze } = await import('../src/modules/strategist.js');

const HOUR_MS = 3_600_000;

function makeScoutItem(coin, smoothedApy, opts = {}) {
  const sign = smoothedApy >= 0 ? 'short' : 'long';
  return {
    coin,
    price:        opts.price        ?? 100,
    fundingRate:  opts.fundingRate  ?? smoothedApy / 100 / 365 / 24,
    rawApy:       opts.rawApy       ?? smoothedApy,
    smoothedApy,
    slowApy:      opts.slowApy      ?? smoothedApy,
    predictedApy: opts.predictedApy ?? smoothedApy,
    side:         opts.side         ?? sign,
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
    side:        opts.side ?? 'long',
  };
}

function resetState() { analyze([], undefined); }

// ═══════════════════════════════════════════════
// OPEN long
// ═══════════════════════════════════════════════

test('OPEN long: top-by-abs(apy) выбирает long-кандидата под флагом', () => {
  resetState();
  const r = analyze(
    [
      // scout уже отсортировал по abs: -80% (long) идёт первым
      makeScoutItem('LDO',  -80),
      makeScoutItem('BTC',   50),
    ],
    undefined,
  );
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin,   'LDO');
  assert.equal(r.side,   'long');
});

test('OPEN long: HOLD если abs(apy) < entryApy', () => {
  resetState();
  const r = analyze([makeScoutItem('LDO', -30)], undefined);
  assert.equal(r.action, 'HOLD');
});

test('OPEN short при флаге ON: top — short, открывает short', () => {
  resetState();
  const r = analyze(
    [
      makeScoutItem('BTC',   60),
      makeScoutItem('LDO',  -45),
    ],
    undefined,
  );
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin,   'BTC');
  assert.equal(r.side,   'short');
});

// ═══════════════════════════════════════════════
// Spike protection — long ловит DUMP
// ═══════════════════════════════════════════════

test('long spike protection: цена упала > 6% → CLOSE', () => {
  resetState();
  const pos = makePosition('LDO', 80, { entry_price: 100, side: 'long' });
  // entry_time 50h назад — за minHold; но spike — emergency, всё равно сработает
  const r = analyze(
    [makeScoutItem('LDO', -80, { price: 93.5 })], // -6.5% adverse
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'price_spike_protection');
});

test('long spike protection: цена выросла → НЕ закрываем (это в нашу пользу)', () => {
  resetState();
  const pos = makePosition('LDO', 80, { entry_price: 100, side: 'long', entry_time: Date.now() - 60_000 });
  const r = analyze(
    [makeScoutItem('LDO', -80, { price: 110 })], // +10% — long в плюсе
    pos,
  );
  assert.notEqual(r.action, 'CLOSE');
});

test('short spike protection всё ещё ловит PUMP (регрессия)', () => {
  resetState();
  const pos = makePosition('BTC', 50, { entry_price: 100, side: 'short' });
  const r = analyze(
    [makeScoutItem('BTC', 50, { price: 107 })], // +7% pump против short
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'price_spike_protection');
});

// ═══════════════════════════════════════════════
// Funding adverse — long страдает на положительном funding
// ═══════════════════════════════════════════════

test('long funding adverse: положительный funding 2 тика → CLOSE', () => {
  resetState();
  const pos = makePosition('LDO', 80, { entry_price: 100, side: 'long' });
  // funding = +0.0001 (положительный) — для long это adverse
  const item = makeScoutItem('LDO', -80, { price: 100, fundingRate: 0.0001 });
  analyze([item], pos); // streak=1
  const r = analyze([item], pos); // streak=2 (NEGATIVE_FUNDING_TICKS default 2)
  assert.equal(r.action, 'CLOSE');
  assert.ok(r.reason === 'negative_funding' || r.reason === 'negative_funding_softexit');
});

test('long: отрицательный funding (наша сторона) → НЕ закрываем', () => {
  resetState();
  const pos = makePosition('LDO', 80, { entry_price: 100, side: 'long' });
  const item = makeScoutItem('LDO', -80, { price: 100, fundingRate: -0.0001 });
  analyze([item], pos);
  const r = analyze([item], pos);
  assert.notEqual(r.action, 'CLOSE');
});

// ═══════════════════════════════════════════════
// APY-below-threshold через abs
// ═══════════════════════════════════════════════

test('long apy_below_threshold: abs(slowApy) < effectiveExit → CLOSE', () => {
  resetState();
  // entry_apy=20, slowApy=-14: ratio 14/20=0.7 ≥ 0.5 (apy_decay не фолсит),
  // |slowApy|=14 < effectiveExit=15 → soft-exit отрабатывает чисто.
  const pos = makePosition('LDO', 20, { entry_price: 100, side: 'long' });
  const r = analyze(
    [makeScoutItem('LDO', -14, { price: 100, slowApy: -14 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'apy_below_threshold');
});

test('long apy hold: abs(slowApy) ≥ effectiveExit → HOLD', () => {
  resetState();
  const pos = makePosition('LDO', 80, { entry_price: 100, side: 'long' });
  // slowApy = -50 → abs = 50 ≫ 15
  const r = analyze(
    [makeScoutItem('LDO', -50, { price: 100, slowApy: -50 })],
    pos,
  );
  assert.equal(r.action, 'HOLD');
});

// ═══════════════════════════════════════════════
// Ротация long-сторона
// ═══════════════════════════════════════════════

test('long rotation: same-side cross-coin с лучшим abs(apy) → ROTATE', () => {
  resetState();
  const pos = makePosition('LDO', 60, { entry_price: 100, side: 'long' });
  const r = analyze(
    [
      makeScoutItem('LDO',  -60, { slowApy: -60 }),
      makeScoutItem('AAVE', -200), // намного «глубже» в минусе → лучшая carry для long
    ],
    pos,
  );
  assert.equal(r.action, 'ROTATE');
  assert.equal(r.openCoin, 'AAVE');
});

test('long rotation: short-кандидат игнорируется (same-side filter)', () => {
  resetState();
  const pos = makePosition('LDO', 60, { entry_price: 100, side: 'long' });
  const r = analyze(
    [
      makeScoutItem('LDO', -60, { slowApy: -60 }),
      makeScoutItem('BTC', 200), // short-кандидат, не подходит
    ],
    pos,
  );
  assert.notEqual(r.action, 'ROTATE');
});
