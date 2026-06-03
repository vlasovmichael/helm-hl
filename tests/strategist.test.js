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
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const BALANCE_CACHE_FILE = join('data', 'balance_cache.json');

// ── ENV до импорта модуля ─────────────────────
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.ENTRY_APY_THRESHOLD   = '40';
process.env.MIN_APY_THRESHOLD     = '20';
process.env.EXIT_BUFFER           = '5';
process.env.MIN_HOLD_TIME_MINUTES = '60';
process.env.BREATHING_MINUTES     = '30';
process.env.LEVERAGE              = '1';

const { analyze, hoursToBreakeven, calculatePaybackHours, _resetCarryLossCooldown, _resetBeRatchet } =
  await import('../src/modules/strategist.js');
const { _resetBalanceCache, _seedBalanceCache } =
  await import('../src/core/balanceCache.js');

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
    predictedApy: opts.predictedApy ?? smoothedApy,
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
// Также сбрасываем balance cache — иначе stale-position guard видит equity
// с диска (от balanceCache.test.js) и может фолсить на вне-темовых тестах.
function resetState() {
  analyze([], undefined);
  _resetCarryLossCooldown();
  _resetBeRatchet();
  _resetBalanceCache();
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

test('Delist hysteresis: 1 тик пропадания → HOLD (не паникуем)', () => {
  resetState();
  const pos = makePosition('OLDCOIN', 50, { entry_time: Date.now() - 60_000 });
  const r = analyze([makeScoutItem('BTC', 50)], pos);
  assert.equal(r.action, 'HOLD');
});

test('Delist hysteresis: 2 тика пропадания → всё ещё HOLD', () => {
  resetState();
  const pos = makePosition('OLDCOIN', 50, { entry_time: Date.now() - 60_000 });
  analyze([makeScoutItem('BTC', 50)], pos); // streak=1
  const r = analyze([makeScoutItem('BTC', 50)], pos); // streak=2
  assert.equal(r.action, 'HOLD');
});

test('Delist hysteresis: 3 тика пропадания → CLOSE delisted', () => {
  resetState();
  const pos = makePosition('OLDCOIN', 50, { entry_time: Date.now() - 60_000 });
  analyze([makeScoutItem('BTC', 50)], pos); // streak=1
  analyze([makeScoutItem('BTC', 50)], pos); // streak=2
  const r = analyze([makeScoutItem('BTC', 50)], pos); // streak=3 → close
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'delisted');
});

test('Delist hysteresis: возвращение сбрасывает streak', () => {
  resetState();
  const pos = makePosition('OLDCOIN', 50, { entry_time: Date.now() - 60_000 });
  analyze([makeScoutItem('BTC', 50)], pos);   // streak=1 (OLDCOIN missing)
  analyze([makeScoutItem('BTC', 50)], pos);   // streak=2
  analyze([makeScoutItem('OLDCOIN', 50)], pos); // reappeared → reset
  analyze([makeScoutItem('BTC', 50)], pos);   // streak=1 again
  const r = analyze([makeScoutItem('BTC', 50)], pos); // streak=2
  assert.equal(r.action, 'HOLD'); // не 3, не закрываем
});

test('Delist cooldown: после delisted не входим в ту же монету 30 мин', () => {
  resetState();
  const pos = makePosition('FART', 50, { entry_time: Date.now() - 60_000 });
  // Выводим в delist
  analyze([makeScoutItem('BTC', 50)], pos); // streak 1
  analyze([makeScoutItem('BTC', 50)], pos); // streak 2
  analyze([makeScoutItem('BTC', 50)], pos); // streak 3 → CLOSE

  // Теперь без позиции — FART лучшая монета, но на cooldown
  const r = analyze([makeScoutItem('FART', 50)], undefined);
  assert.equal(r.action, 'HOLD');
});

test('Delist cooldown: другая монета не на cooldown', () => {
  resetState();
  const pos = makePosition('FART', 50, { entry_time: Date.now() - 60_000 });
  analyze([makeScoutItem('BTC', 50)], pos);
  analyze([makeScoutItem('BTC', 50)], pos);
  analyze([makeScoutItem('BTC', 50)], pos); // FART delisted

  // BTC — другая монета, cooldown не мешает
  const r = analyze([makeScoutItem('BTC', 50)], undefined);
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin, 'BTC');
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

test('Loss cooldown: после price_spike_protection та же монета в бане (VVV регрессия)', () => {
  resetState();
  // Открыли позицию по VVV @ 14.5, цена скакнула до 15.2 (+4.8% — выше порога 4%)
  const pos = makePosition('VVV', 50, {
    entry_price: 14.5,
    entry_time:  Date.now() - 60_000,
  });
  const close = analyze(
    [makeScoutItem('VVV', 50, { price: 15.2, slowApy: 85 })],
    pos,
  );
  assert.equal(close.action, 'CLOSE');
  assert.equal(close.reason, 'price_spike_protection');

  // Без позиции: VVV всё ещё лучшая по APY, но должна быть пропущена.
  // Берётся следующая — BTC (тоже валидна).
  const r = analyze(
    [
      makeScoutItem('VVV', 50, { slowApy: 85 }),
      makeScoutItem('BTC', 50, { slowApy: 50 }),
    ],
    undefined,
  );
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin, 'BTC');
});

test('Loss cooldown: единственный кандидат на cooldown → HOLD', () => {
  resetState();
  const pos = makePosition('VVV', 50, {
    entry_price: 14.5,
    entry_time:  Date.now() - 60_000,
  });
  analyze([makeScoutItem('VVV', 50, { price: 15.2, slowApy: 85 })], pos);
  const r = analyze([makeScoutItem('VVV', 50, { slowApy: 85 })], undefined);
  assert.equal(r.action, 'HOLD');
});

test('Emergency: цена выросла на 3% → НЕ закрываем (под порогом spike protection=4%)', () => {
  resetState();
  const pos = makePosition('BTC', 50, {
    entry_price: 100,
    entry_time:  Date.now() - 60_000,
  });
  const r = analyze(
    [makeScoutItem('BTC', 50, { price: 103, slowApy: 50 })],
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

test('Hold lock: позиция моложе effectiveMinHold → HOLD (slowApy в "зоне спокойствия")', () => {
  resetState();
  // entry_apy=50, hoursToBreakeven(50)≈17.5h, minHold=1051 мин
  // Позиция 60 минут — заперта.
  // slowApy=30 (ratio 0.6 ≥ apy_decay_exit_ratio 0.5 → decay guard не фолсит).
  const pos = makePosition('BTC', 50, { entry_time: Date.now() - 60 * 60_000 });
  const r = analyze([makeScoutItem('BTC', 50, { slowApy: 30 })], pos);
  assert.equal(r.action, 'HOLD');
});

test('Smart guard: APY decay exit (новый guard) — overrides hold lock когда slowApy упал вдвое', () => {
  resetState();
  // entry_apy=50, slowApy=10 → ratio 0.2 < 0.5 → CLOSE даже на 60-минутной позиции.
  // Funding-gate: HH:30 (середина часа) — не блокирует. Цена не двигалась → unrealized=0% (≥0).
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 50, { entry_time: Date.now() - 60 * 60_000 });
    const r = analyze([makeScoutItem('BTC', 50, { slowApy: 10 })], pos);
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.reason, 'apy_decay');
  } finally {
    restore();
  }
});

test('Smart guard: APY decay НЕ фолсит когда позиция в минусе (защита от фиксации лосса)', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    // SHORT @100. Цена выросла до 102 → unrealizedPct = -2% (минус). APY decay
    // не должен fix лосс — fall through к spike protection / soft exit.
    const pos = makePosition('BTC', 50, { entry_price: 100, entry_time: Date.now() - 60 * 60_000 });
    const r = analyze([makeScoutItem('BTC', 50, { price: 102, slowApy: 10 })], pos);
    assert.notEqual(r.reason, 'apy_decay');
  } finally {
    restore();
  }
});

test('Smart guard: stale_position НЕ фолсит когда позиция в минусе', () => {
  resetState();
  _seedBalanceCache(100);
  // SHORT @100, цена 102 → unrealizedPct = -2% (выше -4% spike protection).
  // Held > stale_timeout (360min default), но guard должен пропустить.
  const pos = makePosition('BTC', 50, { entry_price: 100, entry_time: Date.now() - 7 * HOUR_MS });
  const r = analyze([makeScoutItem('BTC', 50, { price: 102, slowApy: 50 })], pos);
  assert.notEqual(r.reason, 'stale_position');
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
    // entry_apy=20, hoursToBreakeven≈43h, но capped CARRY_MAX_HOLD_MIN=480.
    // Позиция 50ч назад — за minHold.
    // slowApy=14 < effectiveExit=15. ratio 14/20=0.7 ≥ 0.5 → APY decay guard НЕ
    // фолсит, soft-exit отрабатывает чисто.
    const pos = makePosition('BTC', 20, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze([makeScoutItem('BTC', 20, { slowApy: 14 })], pos);
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

// ═══════════════════════════════════════════════
//  Trailing TP (carry)
//  Defaults: ARM=5%, GIVE_BACK=30%
//  Шорт — unrealized = (entry − current)/entry * 100.
// ═══════════════════════════════════════════════

test('Trailing: peak < ARM → не активируется', () => {
  resetState();
  const pos = makePosition('CHIP', 40, { entry_price: 100 });
  // unrealized +3% (price 97, entry 100) — ниже ARM=5%
  const r = analyze(
    [makeScoutItem('CHIP', 40, { price: 97, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'HOLD');
});

test('Trailing: peak ≥ ARM, give-back < threshold → HOLD', () => {
  resetState();
  const pos = makePosition('CHIP', 40, { entry_price: 100 });
  // Тик 1: +10% (price 90) → peak=10%
  analyze([makeScoutItem('CHIP', 40, { price: 90, slowApy: 40 })], pos);
  // Тик 2: +8% (price 92) → gave back 2/10 = 20% < 30%
  const r = analyze(
    [makeScoutItem('CHIP', 40, { price: 92, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'HOLD');
});

test('Trailing: give-back ≥ 30% от пика → CLOSE trailing_tp', () => {
  resetState();
  const pos = makePosition('CHIP', 40, { entry_price: 100 });
  // Тик 1: peak +20% (price 80)
  analyze([makeScoutItem('CHIP', 40, { price: 80, slowApy: 40 })], pos);
  // Тик 2: +13% (price 87) → gave back 7/20 = 35% ≥ 30%
  const r = analyze(
    [makeScoutItem('CHIP', 40, { price: 87, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trailing_tp');
  assert.equal(r.coin, 'CHIP');
});

test('Trailing: воспроизводит инцидент CHIP — peak +20.7% → exit при +14.5%', () => {
  // Реальный сценарий из temp/2.txt: бот сидел при пике +20.7%, закрылся на +0.1%.
  // С трейлингом должен был выйти примерно на +14.5%.
  resetState();
  const pos = makePosition('CHIP', 40, { entry_price: 0.086557 });
  // Peak 26.04 07:07: mark $0.067723 → unrealized +21.76%
  analyze([makeScoutItem('CHIP', 40, { price: 0.067723, slowApy: 40 })], pos);
  // Откат к +14.5% (mark ~$0.074002): gave back 33% → должен сработать.
  const r = analyze(
    [makeScoutItem('CHIP', 40, { price: 0.074002, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trailing_tp');
});

test('Trailing: peak persists across ticks (не падает с ценой)', () => {
  resetState();
  const pos = makePosition('CHIP', 40, { entry_price: 100 });
  // Tick 1: peak +10% (price 90)
  analyze([makeScoutItem('CHIP', 40, { price: 90, slowApy: 40 })], pos);
  // Tick 2: +8% (price 92) — gave back 2/10=20% < 30% → HOLD. Peak остаётся 10%.
  const r2 = analyze(
    [makeScoutItem('CHIP', 40, { price: 92, slowApy: 40 })],
    pos,
  );
  assert.equal(r2.action, 'HOLD');
  // Tick 3: +3% (price 97) — gave back 7/10=70% ≥ 30% → CLOSE
  // (peak от tick 1 пережил tick 2, иначе пик «забылся» бы и trailing не сработал)
  const r3 = analyze(
    [makeScoutItem('CHIP', 40, { price: 97, slowApy: 40 })],
    pos,
  );
  assert.equal(r3.action, 'CLOSE');
  assert.equal(r3.reason, 'trailing_tp');
});

test('Trailing: state очищается при переходе к новой позиции', () => {
  resetState();
  // Старая позиция с пиком
  const oldPos = makePosition('CHIP', 40, { entry_price: 100 });
  analyze([makeScoutItem('CHIP', 40, { price: 80, slowApy: 40 })], oldPos);
  // Возврат в Сценарий А → должен очистить peakUnrealizedPct
  resetState();
  // Новая позиция CHIP с тем же entry_price, но без истории пика
  const newPos = makePosition('CHIP', 40, { entry_price: 100 });
  // При +6% (peak только что зарегистрировался) trailing не должен срабатывать
  const r = analyze(
    [makeScoutItem('CHIP', 40, { price: 94, slowApy: 40 })],
    newPos,
  );
  assert.equal(r.action, 'HOLD');
});

// ═══════════════════════════════════════════════
//  Negative funding: soft (через snайпера) vs hard (market)
//  Default: NEGATIVE_FUNDING_SOFT_EXIT_MIN_PNL_PCT=2
//  В плюсе ≥+2% → soft (reason='negative_funding_softexit')
//  В минусе или ниже +2% → hard (reason='negative_funding')
// ═══════════════════════════════════════════════

test('Negative funding: позиция в плюсе ≥+2% → soft exit', () => {
  resetState();
  const pos = makePosition('BTC', 40, { entry_price: 100 });
  // unrealized = (100 - 95)/100 = +5% >= +2%
  // funding negative → нужно 2 тика подряд
  const tick1 = analyze(
    [makeScoutItem('BTC', 40, { price: 95, slowApy: 40, fundingRate: -1e-6 })],
    pos,
  );
  assert.equal(tick1.action, 'HOLD');  // streak=1, нужно 2
  const tick2 = analyze(
    [makeScoutItem('BTC', 40, { price: 95, slowApy: 40, fundingRate: -1e-6 })],
    pos,
  );
  assert.equal(tick2.action, 'CLOSE');
  assert.equal(tick2.reason, 'negative_funding_softexit');
});

test('Negative funding: позиция в минусе → hard exit (market)', () => {
  resetState();
  const pos = makePosition('BTC', 40, { entry_price: 100 });
  // unrealized = (100 - 103)/100 = -3% (короткий в минусе) < +2%
  analyze(
    [makeScoutItem('BTC', 40, { price: 103, slowApy: 40, fundingRate: -1e-6 })],
    pos,
  );
  const r = analyze(
    [makeScoutItem('BTC', 40, { price: 103, slowApy: 40, fundingRate: -1e-6 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'negative_funding');
});

test('Negative funding: позиция чуть-чуть в плюсе (<2%) → hard exit', () => {
  resetState();
  const pos = makePosition('BTC', 40, { entry_price: 100 });
  // unrealized = (100 - 99)/100 = +1% < +2%
  analyze(
    [makeScoutItem('BTC', 40, { price: 99, slowApy: 40, fundingRate: -1e-6 })],
    pos,
  );
  const r = analyze(
    [makeScoutItem('BTC', 40, { price: 99, slowApy: 40, fundingRate: -1e-6 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'negative_funding');
});

// ── Equity-based trailing (path B) — FARTCOIN регрессия ──
//   PnL +$1.80 на equity $44 = +4.1% eq, при движении цены ~0.8% (плечо ~5x).
//   Path A (5% price) не армится; path B (2% equity) должен.

test('Trailing equity: peak equity-PnL ≥ ARM_PCT_EQUITY → arm path B', () => {
  resetState();
  _seedBalanceCache(44);
  // size $200 (плечо ~5x на $44), entry $1.00 → qty=200
  // price $0.991 → pnl=(1.0-0.991)*200=$1.80 → 4.09% equity (≥ ARM 2%)
  const pos = makePosition('FART', 40, { entry_price: 1.0 });
  pos.size_usd = 200;
  // Тик 1: peak +4.09% equity (но всего 0.9% движения цены — path A не армится)
  analyze([makeScoutItem('FART', 40, { price: 0.991, slowApy: 40 })], pos);
  // Тик 2: цена откатилась к 0.9938 → pnl=$1.24 → 2.82% eq.
  // Gave back (4.09-2.82)/4.09 = 31% ≥ 30% → CLOSE trailing_tp_equity
  const r = analyze(
    [makeScoutItem('FART', 40, { price: 0.9938, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'trailing_tp_equity');
  assert.equal(r.coin, 'FART');
});

test('Trailing equity: без кэша equity → path B молча disabled', () => {
  _resetBalanceCache();
  // Также удаляем дисковый кэш — иначе предыдущий тестовый прогон
  // (например, wallet.test.js) оставит файл и loadFromDisk поднимет его.
  if (existsSync(BALANCE_CACHE_FILE)) unlinkSync(BALANCE_CACHE_FILE);
  // НЕ сидим кэш → getCachedAccountValueSync() → null
  resetState();
  const pos = makePosition('FART', 40, { entry_price: 1.0 });
  pos.size_usd = 200;
  // Тот же сценарий что выше — но без equity path B не должен сработать.
  analyze([makeScoutItem('FART', 40, { price: 0.991, slowApy: 40 })], pos);
  const r = analyze(
    [makeScoutItem('FART', 40, { price: 0.9938, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'HOLD');
});

test('Trailing equity: equityPct < ARM_PCT_EQUITY → path B не армится', () => {
  _resetBalanceCache();
  _seedBalanceCache(200); // equity=200, pnl 1.80 / 200 = 0.9% < 1.5% ARM
  resetState();
  const pos = makePosition('FART', 40, { entry_price: 1.0 });
  pos.size_usd = 200;
  analyze([makeScoutItem('FART', 40, { price: 0.991, slowApy: 40 })], pos);
  const r = analyze(
    [makeScoutItem('FART', 40, { price: 0.9938, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'HOLD');
});

test('Trailing: emergency-выходы имеют приоритет над trailing', () => {
  resetState();
  const pos = makePosition('CHIP', 40, { entry_price: 100 });
  // Пик +10%
  analyze([makeScoutItem('CHIP', 40, { price: 90, slowApy: 40 })], pos);
  // Цена скачком +11% (price 111) — это price_spike_protection (>10%)
  // и одновременно give-back 100% от пика. Должен выйти по price_spike, не trailing.
  const r = analyze(
    [makeScoutItem('CHIP', 40, { price: 111, slowApy: 40 })],
    pos,
  );
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'price_spike_protection');
});

// ═══════════════════════════════════════════════
//  Iter 1.1: side-aware entry & rotation
// ═══════════════════════════════════════════════

test('Iter 1.1: OPEN — strategist игнорирует long-кандидатов и берёт лучший short', () => {
  resetState();
  // Под флагом carryLongEnabled scout может вернуть mixed sides, отсортированных по abs(apy).
  // Strategist в Iter 1.1 ещё не умеет открывать long — должен взять лучший short.
  const r = analyze(
    [
      { ...makeScoutItem('LONGY', -80), side: 'long' }, // abs выше, но long
      { ...makeScoutItem('BTC',   50), side: 'short' },
      { ...makeScoutItem('ETH',   45), side: 'short' },
    ],
    undefined,
  );
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin,   'BTC');
});

test('Iter 1.1: OPEN — все кандидаты long → HOLD (Iter 1.2 включит логику)', () => {
  resetState();
  const r = analyze(
    [
      { ...makeScoutItem('LONGY', -80), side: 'long' },
      { ...makeScoutItem('LONG2', -60), side: 'long' },
    ],
    undefined,
  );
  assert.equal(r.action, 'HOLD');
});

test('Iter 1.1: ROTATE — не ротируется в long-кандидата даже при выше abs(APY)', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 40, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [
        { ...makeScoutItem('BTC',  40, { slowApy: 40 }), side: 'short' },
        { ...makeScoutItem('LONGY', -120, { slowApy: -120 }), side: 'long' },
      ],
      pos,
    );
    // Нет лучшего short → HOLD (long игнорируется)
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

test('Iter 1.1: ROTATE — переходит на лучший short, игнорируя long с большим abs', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('BTC', 40, { entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze(
      [
        { ...makeScoutItem('BTC',   40, { slowApy: 40 }),  side: 'short' },
        { ...makeScoutItem('LONGY', -200, { slowApy: -200 }), side: 'long' },
        { ...makeScoutItem('ETH',   120, { slowApy: 120 }),  side: 'short' },
      ],
      pos,
    );
    assert.equal(r.action,    'ROTATE');
    assert.equal(r.openCoin,  'ETH');
    assert.equal(r.closeCoin, 'BTC');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════
//  Дед v2 — breakeven храповик + «цена > фандинг»
// ═══════════════════════════════════════════════

test('BE ratchet: подарок ≥ $arm взвёл храповик, цена назад в 0 → CLOSE breakeven_ratchet', () => {
  resetState();
  // SHORT @100, size $100, qty=1. Без equity-кэша → arm по $-порогу ($0.40).
  const pos = makePosition('XMR', 40, { entry_price: 100 });
  // Тик 1: цена 99 → price-PnL = +$1.00 ≥ $0.40 → храповик взведён (> breakeven → HOLD)
  const r1 = analyze([makeScoutItem('XMR', 40, { price: 99, slowApy: 40 })], pos);
  assert.equal(r1.action, 'HOLD');
  // Тик 2: цена вернулась к 100 → price-PnL = $0 ≤ floor(0) → дед НЕ отдаёт в 0
  const r2 = analyze([makeScoutItem('XMR', 40, { price: 100, slowApy: 40 })], pos);
  assert.equal(r2.action, 'CLOSE');
  assert.equal(r2.reason, 'breakeven_ratchet');
  assert.equal(r2.coin, 'XMR');
});

test('BE ratchet: подарок был, но цена ещё в плюсе (выше пола) → HOLD', () => {
  resetState();
  const pos = makePosition('XMR', 40, { entry_price: 100 });
  analyze([makeScoutItem('XMR', 40, { price: 99, slowApy: 40 })], pos); // армится
  const r = analyze([makeScoutItem('XMR', 40, { price: 99.5, slowApy: 40 })], pos);
  assert.equal(r.action, 'HOLD');
});

test('BE ratchet: цена не давала плюса → храповик не взводится, обычная логика', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('XMR', 20, { entry_price: 100, entry_time: Date.now() - 50 * HOUR_MS });
    const r = analyze([makeScoutItem('XMR', 20, { price: 100, slowApy: 14 })], pos);
    assert.equal(r.action, 'CLOSE');
    assert.equal(r.reason, 'apy_below_threshold');
  } finally {
    restore();
  }
});

test('Цена > фандинг: армлен ценовой winner + slowApy упал → HOLD (не apy_below)', () => {
  resetState();
  const pos = makePosition('XMR', 20, { entry_price: 100, entry_time: Date.now() - 50 * HOUR_MS });
  const r = analyze([makeScoutItem('XMR', 20, { price: 99, slowApy: 14 })], pos);
  assert.equal(r.action, 'HOLD');
});

test('Цена > фандинг: армлен winner + apy_decay сработал бы → HOLD (не apy_decay)', () => {
  resetState();
  const restore = freezeTime(2026, 3, 15, 12, 30);
  try {
    const pos = makePosition('XMR', 50, { entry_price: 100, entry_time: Date.now() - 60 * 60_000 });
    const r = analyze([makeScoutItem('XMR', 50, { price: 99, slowApy: 10 })], pos);
    assert.equal(r.action, 'HOLD');
  } finally {
    restore();
  }
});

test('Цена > фандинг: negative_funding (hard) НЕ блокируется храповиком', () => {
  resetState();
  const pos = makePosition('XMR', 40, { entry_price: 100 });
  analyze([makeScoutItem('XMR', 40, { price: 99, slowApy: 40, fundingRate: -1e-6 })], pos);
  const r = analyze([makeScoutItem('XMR', 40, { price: 99, slowApy: 40, fundingRate: -1e-6 })], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'negative_funding'); // +1% < soft порог 2% → hard
});
