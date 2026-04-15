// Тесты strategist.analyze() — pure-функция без I/O.
//
// Запуск: npm test
//
// Стек: node:test + node:assert/strict (нулевые зависимости).
//
// Важные нюансы:
//  - strategist читает config.trading при импорте, поэтому ENV ставим
//    ДО динамического импорта модуля.
//  - У модуля есть internal state (negativeFundingStreak), сбрасываем
//    его вызовом analyze([], undefined) в начале каждого теста.
//  - Для проверки funding-gate подменяем глобальный Date на фикстуру.

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

const { analyze, hoursToBreakeven, calculatePaybackHours } =
  await import('../src/modules/strategist.js');

// ── Хелперы ───────────────────────────────────
const HOUR_MS = 3_600_000;

function makeScoutItem(coin, smoothedApy, opts = {}) {
  return {
    coin,
    price:       opts.price       ?? 100,
    fundingRate: opts.fundingRate ?? smoothedApy / 100 / 365 / 24,
    rawApy:      opts.rawApy      ?? smoothedApy,
    smoothedApy,
    slowApy:     opts.slowApy     ?? smoothedApy,
  };
}

function makePosition(coin, entryApy, opts = {}) {
  return {
    id:          1,
    coin,
    size_usd:    100,
    entry_price: opts.entry_price ?? 100,
    entry_apy:   entryApy,
    entry_time:  opts.entry_time  ?? Date.now() - 50 * HOUR_MS, // 50ч назад — сильно за minHold
    mode:        'PAPER',
    status:      'OPEN',
  };
}

// Сброс модульного negativeFundingStreak: вход без позиции его обнуляет.
function resetState() {
  analyze([], undefined);
}

// Подмена глобального Date на фикс времени UTC.
// Возвращает функцию-restore.
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
//  hoursToBreakeven / calculatePaybackHours
// ═══════════════════════════════════════════════

test('hoursToBreakeven: 40% APY ≈ 21.9h', () => {
  const h = hoursToBreakeven(40);
  assert.ok(h > 21 && h < 23, `expected ~21.9, got ${h}`);
});

test('hoursToBreakeven: 36.5% APY на границе ≈ 24h', () => {
  const h = hoursToBreakeven(36.5);
  assert.ok(h > 23.5 && h < 24.5, `expected ~24, got ${h}`);
});

test('hoursToBreakeven: 0% → Infinity (никогда)', () => {
  assert.equal(hoursToBreakeven(0), Infinity);
  assert.equal(hoursToBreakeven(-5), Infinity);
});

test('calculatePaybackHours: target ≤ current → Infinity', () => {
  assert.equal(calculatePaybackHours(50, 50), Infinity);
  assert.equal(calculatePaybackHours(60, 40), Infinity);
});

test('calculatePaybackHours: дельта 80% даёт ≤ 24h (ротация пройдёт)', () => {
  const h = calculatePaybackHours(40, 120);
  assert.ok(h < 24, `expected <24, got ${h}`);
});

test('calculatePaybackHours: дельта 20% даёт >> 24h (ротация не пройдёт)', () => {
  const h = calculatePaybackHours(40, 60);
  assert.ok(h > 80, `expected ~88h, got ${h}`);
});

// ═══════════════════════════════════════════════
//  Сценарий A: OPEN
// ═══════════════════════════════════════════════

test('OPEN: HOLD когда нет монет выше entryApy=40%', () => {
  resetState();
  const r = analyze([makeScoutItem('BTC', 30)], undefined);
  assert.equal(r.action, 'HOLD');
});

test('OPEN: HOLD когда scoutData пуст', () => {
  resetState();
  const r = analyze([], undefined);
  assert.equal(r.action, 'HOLD');
});

test('OPEN: открывает лучшую монету ≥ entryApy', () => {
  resetState();
  const r = analyze(
    [
      makeScoutItem('BTC', 50),
      makeScoutItem('ETH', 45),
    ],
    undefined,
  );
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin,   'BTC');
  assert.equal(r.apy,    50);
});

// ═══════════════════════════════════════════════
//  Сценарий Б: экстренные выходы
// ═══════════════════════════════════════════════

test('Emergency: монета пропала из scoutData → CLOSE delisted (даже сразу после входа)', () => {
  resetState();
  const pos = makePosition('OLDCOIN', 50, { entry_time: Date.now() - 60_000 }); // 1 мин назад
  const r = analyze([makeScoutItem('BTC', 50)], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'delisted');
});

test('Emergency: цена выросла >10% → CLOSE price_spike (даже в hold lock)', () => {
  resetState();
  const pos = makePosition('BTC', 50, {
    entry_price: 100,
    entry_time:  Date.now() - 60_000,
  });
  const r = analyze(
    [makeScoutItem('BTC', 50, { price: 115, slowApy: 50 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'price_spike_protection');
});

test('Emergency: цена выросла на 9% → НЕ закрываем', () => {
  resetState();
  const pos = makePosition('BTC', 50, {
    entry_price: 100,
    entry_time:  Date.now() - 60_000,
  });
  const r = analyze(
    [makeScoutItem('BTC', 50, { price: 109, slowApy: 50 })],
    pos,
  );
  assert.notEqual(r.action, 'CLOSE');
});

test('Emergency: negative funding 1 тик → НЕ закрываем (гистерезис)', () => {
  resetState();
  const pos  = makePosition('BTC', 50, { entry_time: Date.now() - 60_000 });
  const item = makeScoutItem('BTC', 50, { fundingRate: -0.0001, slowApy: 50 });
  const r    = analyze([item], pos);
  assert.notEqual(r.action, 'CLOSE');
});

test('Emergency: negative funding 2 тика подряд → CLOSE negative_funding', () => {
  resetState();
  const pos  = makePosition('BTC', 50, { entry_time: Date.now() - 60_000 });
  const item = makeScoutItem('BTC', 50, { fundingRate: -0.0001, slowApy: 50 });
  analyze([item], pos);            // streak=1
  const r = analyze([item], pos);  // streak=2 → close
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'negative_funding');
});

test('Emergency: позитивный тик в середине сбрасывает streak', () => {
  resetState();
  const pos = makePosition('BTC', 50, { entry_time: Date.now() - 60_000 });
  analyze([makeScoutItem('BTC', 50, { fundingRate: -0.0001, slowApy: 50 })], pos); // 1
  analyze([makeScoutItem('BTC', 50, { fundingRate:  0.0001, slowApy: 50 })], pos); // reset
  const r = analyze([makeScoutItem('BTC', 50, { fundingRate: -0.0001, slowApy: 50 })], pos); // 1 снова
  assert.notEqual(r.action, 'CLOSE');
});

// ═══════════════════════════════════════════════
//  Динамический min-hold
// ═══════════════════════════════════════════════

test('Hold lock: позиция моложе effectiveMinHold → HOLD (даже если slowApy очень низкий)', () => {
  resetState();
  // entry_apy=50, hoursToBreakeven(50)≈17.5h, minHold=1051 мин
  // Позиция 60 минут — заперта.
  const pos = makePosition('BTC', 50, { entry_time: Date.now() - 60 * 60_000 });
  const r = analyze([makeScoutItem('BTC', 50, { slowApy: 5 })], pos);
  assert.equal(r.action, 'HOLD');
});

test('Hold lock: ротация тоже заблокирована во время hold lock', () => {
  resetState();
  const pos = makePosition('BTC', 50, { entry_time: Date.now() - 60 * 60_000 });
  // ETH с гигантским APY — без блокировки точно бы ротировались
  const r = analyze(
    [
      makeScoutItem('BTC', 50),
      makeScoutItem('ETH', 200),
    ],
    pos,
  );
  assert.equal(r.action, 'HOLD');
});

test('Hold lock: после истечения minHold soft-exit срабатывает', () => {
  resetState();
  // Время — HH:30, не в funding-gate
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    // entry_apy=50, hoursToBreakeven≈17.5h. Позиция 50ч назад — за minHold.
    const pos = makePosition('BTC', 50, { entry_time: Date.now() - 50 * HOUR_MS });
    // slowApy=10 << effectiveExit=15 (minApy 20 - exitBuffer 5)
    const r = analyze([makeScoutItem('BTC', 50, { slowApy: 10 })], pos);
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.reason, 'apy_below_threshold');
  } finally {
    restore();
  }
});

test('Hold lock: после minHold, slowApy выше exit → НЕ закрываем', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 50, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze([makeScoutItem('BTC', 50, { slowApy: 30 })], pos);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════
//  Funding-gate (10 минут до выплаты)
// ═══════════════════════════════════════════════

test('Funding-gate: soft-exit заблокирован в окне HH:55 (5 мин до выплаты)', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 55);
  try {
    const pos = makePosition('BTC', 50, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze([makeScoutItem('BTC', 50, { slowApy: 5 })], pos);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

test('Funding-gate: emergency CLOSE срабатывает даже в окне выплаты', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 55);
  try {
    const pos = makePosition('BTC', 50, { entry_price: 100, entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [makeScoutItem('BTC', 50, { price: 120, slowApy: 50 })], // +20%
      pos,
    );
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.reason, 'price_spike_protection');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════
//  Ротация
// ═══════════════════════════════════════════════

test('Rotation: после minHold, дельта 80% → ROTATE', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 40, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [
        makeScoutItem('BTC', 40, { slowApy: 40 }),
        makeScoutItem('ETH', 120, { slowApy: 120 }),
      ],
      pos,
    );
    assert.equal(r.action,    'ROTATE');
    assert.equal(r.closeCoin, 'BTC');
    assert.equal(r.openCoin,  'ETH');
  } finally {
    restore();
  }
});

test('Rotation: после minHold, малая дельта → HOLD (payback > 24h)', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 40, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [
        makeScoutItem('BTC', 40, { slowApy: 40 }),
        makeScoutItem('ETH', 60, { slowApy: 60 }),
      ],
      pos,
    );
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

test('Rotation: нет лучшей монеты → HOLD', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 40, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [
        makeScoutItem('BTC', 40, { slowApy: 40 }),
        makeScoutItem('ETH', 30, { slowApy: 30 }),
      ],
      pos,
    );
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

test('Rotation: блокируется funding-gate', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 55);
  try {
    const pos = makePosition('BTC', 40, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [
        makeScoutItem('BTC', 40, { slowApy: 40 }),
        makeScoutItem('ETH', 120, { slowApy: 120 }),
      ],
      pos,
    );
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});
