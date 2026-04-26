// Тесты Strategy #3 Sniper-Hunter (Iter A.1): analyzeHunter pure logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const { push, clearAll } =
  await import('../src/core/priceHistory.js');
const {
  analyzeHunter, resetHunterCooldowns,
  HUNTER_SPIKE_PCT, HUNTER_SL_PCT, HUNTER_TP_PCT, HUNTER_COOLDOWN_MS,
} = await import('../src/modules/strategistSniper.js');

const MIN = 60_000;
const T0  = 1_700_000_000_000;

function reset() {
  clearAll();
  resetHunterCooldowns();
}

function seedHistory(coin, basePrice, now) {
  // Заполняем историю 3 мин назад → now, ровная цена basePrice
  push(coin, basePrice, now - 3 * MIN);
  push(coin, basePrice, now - 2 * MIN);
  push(coin, basePrice, now - 1 * MIN);
}

// ── Entry logic ─────────────────────────────────

test('IDLE + нет истории → HOLD', () => {
  reset();
  const now = T0;
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + ровный прайс → HOLD', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + pump < 5% → HOLD', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // +3% за 2мин — недотягивает
  const r = analyzeHunter([{ coin: 'BTC', price: 51500 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('IDLE + pump ≥ 5% → OPEN SHORT с корректным SL/TP', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // +6% за 2мин
  const r = analyzeHunter([{ coin: 'BTC', price: 53000 }], null, now);

  assert.equal(r.action, 'OPEN');
  assert.equal(r.strategy_id, 'hunter');
  assert.equal(r.coin, 'BTC');
  assert.equal(r.price, 53000);
  assert.equal(r.direction, 'SHORT');
  assert.ok(r.spikePct >= HUNTER_SPIKE_PCT);
  // SL = +2% (53000 * 1.02)
  assert.equal(r.sl.toFixed(4), (53000 * 1.02).toFixed(4));
  // TP = -3% (53000 * 0.97)
  assert.equal(r.tp.toFixed(4), (53000 * 0.97).toFixed(4));
});

test('IDLE + dump ≥ 5% → HOLD (short-only, никаких long-after-dump)', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  // -6% за 2мин
  const r = analyzeHunter([{ coin: 'BTC', price: 47000 }], null, now);
  assert.equal(r.action, 'HOLD');
});

test('cooldown: повторный сигнал по той же монете в течение 2мин игнорится', () => {
  reset();
  const now1 = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now1);
  const r1 = analyzeHunter([{ coin: 'BTC', price: 53000 }], null, now1);
  assert.equal(r1.action, 'OPEN');

  // Через 1 мин — всё ещё в cooldown
  const now2 = now1 + 1 * MIN;
  push('BTC', 53000, now2);  // поддерживаем историю
  const r2 = analyzeHunter([{ coin: 'BTC', price: 54000 }], null, now2);
  assert.equal(r2.action, 'HOLD', 'cooldown должен держать HOLD');
});

test('cooldown истёк → новый сигнал допустим', () => {
  reset();
  const now1 = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now1);
  analyzeHunter([{ coin: 'BTC', price: 53000 }], null, now1);

  const now2 = now1 + HUNTER_COOLDOWN_MS + 1_000;  // +2мин+1с
  // Чтобы был новый спайк ≥5% за 2мин от now2, нужна цена ~now2-2min.
  // Добавим ровную историю от now2-3min до now2-1min на 52000, потом спайк.
  push('BTC', 52000, now2 - 3 * MIN);
  push('BTC', 52000, now2 - 2 * MIN);
  push('BTC', 52000, now2 - 1 * MIN);
  const r = analyzeHunter([{ coin: 'BTC', price: 55000 }], null, now2);
  assert.equal(r.action, 'OPEN', 'после 2+мин cooldown должен пропустить');
});

test('IDLE + несколько монет спайкуют → выбираем максимум', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  seedHistory('ETH', 3000, now);

  const r = analyzeHunter(
    [
      { coin: 'BTC', price: 53000 },  // +6%
      { coin: 'ETH', price: 3300 },   // +10%  ← жирнее
    ],
    null, now,
  );
  assert.equal(r.action, 'OPEN');
  assert.equal(r.coin, 'ETH');
});

test('активная позиция ДРУГОЙ стратегии → HOLD (no evict в Iter A)', () => {
  reset();
  const now = T0 + 3 * MIN;
  seedHistory('BTC', 50000, now);
  const carryPosition = { coin: 'SOL', strategy_id: 'carry' };
  const r = analyzeHunter(
    [{ coin: 'BTC', price: 53000 }],  // жирный спайк по BTC
    carryPosition, now,
  );
  assert.equal(r.action, 'HOLD');
});

// ── Exit logic (SL/TP) ─────────────────────────

function hunterPos(overrides = {}) {
  return {
    coin:        'BTC',
    strategy_id: 'hunter',
    entry_price: 50000,
    sl_price:    50000 * 1.02,  // 51000
    tp_price:    50000 * 0.97,  // 48500
    ...overrides,
  };
}

test('hunter-позиция, цена между SL и TP → HOLD', () => {
  reset();
  const r = analyzeHunter([{ coin: 'BTC', price: 50500 }], hunterPos());
  assert.equal(r.action, 'HOLD');
});

test('hunter-позиция, цена ≥ SL → CLOSE hunter_sl', () => {
  reset();
  const r = analyzeHunter([{ coin: 'BTC', price: 51100 }], hunterPos());
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_sl');
  assert.equal(r.coin, 'BTC');
  assert.equal(r.price, 51000);  // закрываем по уровню SL
});

test('hunter-позиция, цена ≤ TP → CLOSE hunter_tp', () => {
  reset();
  const r = analyzeHunter([{ coin: 'BTC', price: 48000 }], hunterPos());
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_tp');
  assert.equal(r.price, 48500);  // закрываем по уровню TP
});

test('hunter-позиция, SL и TP оба пересекаются → приоритет SL (консервативно)', () => {
  reset();
  // Нонсенс с точки зрения рынка, но защита на случай giant-тика
  const weird = hunterPos({ sl_price: 49000, tp_price: 50500 });  // SL < TP
  const r = analyzeHunter([{ coin: 'BTC', price: 50000 }], weird);
  // price >= sl_price(49000) И price <= tp_price(50500) — оба триггерят
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_sl');
});

test('hunter-позиция, но монеты нет в scoutData → HOLD', () => {
  reset();
  const r = analyzeHunter([{ coin: 'ETH', price: 3000 }], hunterPos());
  assert.equal(r.action, 'HOLD');
});

test('IDLE с пустым scoutData не падает', () => {
  reset();
  assert.equal(analyzeHunter([], null).action, 'HOLD');
  assert.equal(analyzeHunter(null, null).action, 'HOLD');
});

// ═══════════════════════════════════════════════
//  Anti-trend filter (HUNTER_TREND_LOOKBACK_MIN/MAX_RISE_PCT)
//  Default: 15 мин lookback, 8% rise threshold.
// ═══════════════════════════════════════════════

test('anti-trend: цена 15мин назад была ниже current на ≥8% → HOLD (это тренд)', () => {
  reset();
  const now = T0 + 16 * MIN;
  // 15мин назад — 100, сейчас 110 (+10% за 15мин). Спайк +6% за 2мин — есть, но это часть тренда.
  push('BTC', 100, now - 15 * MIN);
  push('BTC', 102, now - 10 * MIN);
  push('BTC', 104, now - 2 * MIN);  // 2мин назад
  const r = analyzeHunter([{ coin: 'BTC', price: 110 }], null, now);
  // Спайк (110 - 104)/104 = +5.77% — выше 5% порога. Но 15-мин рост (110-100)/100 = +10% > 8% → HOLD.
  assert.equal(r.action, 'HOLD');
});

test('anti-trend: цена 15мин назад была ниже current <8% → OPEN (не тренд, чистый спайк)', () => {
  reset();
  const now = T0 + 16 * MIN;
  // 15мин назад — 100, 2мин назад — 100, current 106 (+6% спайк за 2мин, +6% за 15мин).
  push('BTC', 100, now - 15 * MIN);
  push('BTC', 100, now - 10 * MIN);
  push('BTC', 100, now - 2 * MIN);
  const r = analyzeHunter([{ coin: 'BTC', price: 106 }], null, now);
  // 15-мин рост = 6% < 8% → фильтр пропускает.
  assert.equal(r.action, 'OPEN');
});

test('anti-trend: нет истории 15мин → фильтр пропускает (свежий старт)', () => {
  reset();
  const now = T0 + 3 * MIN;
  // Только 2-мин история — фильтр анти-тренда не может работать, поэтому OPEN допустим.
  seedHistory('BTC', 100, now);
  const r = analyzeHunter([{ coin: 'BTC', price: 106 }], null, now);
  assert.equal(r.action, 'OPEN');
});

test('anti-trend: воспроизводит APE 17:56 (повторный SL по более высокой цене)', () => {
  // В логе: 17:27 entry $0.12667 → SL.
  // 17:56 entry $0.15591 (на 23% выше за 30 мин) → опять SL.
  // Anti-trend должен был это поймать.
  reset();
  const now = T0 + 30 * MIN;
  push('APE', 0.12667, now - 15 * MIN);   // 15мин назад — близко к first entry
  push('APE', 0.14000, now - 10 * MIN);
  push('APE', 0.14800, now - 2 * MIN);    // 2мин назад
  // Спайк: (0.15591 - 0.14800)/0.14800 = +5.34% > 5%
  // Тренд: (0.15591 - 0.12667)/0.12667 = +23% > 8%
  const r = analyzeHunter([{ coin: 'APE', price: 0.15591 }], null, now);
  assert.equal(r.action, 'HOLD');  // anti-trend сработал
});

// ═══════════════════════════════════════════════
//  Post-SL cooldown (HUNTER_POST_SL_COOLDOWN_MIN, default 30)
// ═══════════════════════════════════════════════

test('post-SL cooldown: после SL Hunter не возвращается к этой монете 30 мин', () => {
  reset();
  // 1) Открываем hunter-позицию, она получает SL.
  const slPrice = 50000 * 1.02;  // +2%
  const pos = {
    id: 1, coin: 'BTC', strategy_id: 'hunter',
    sl_price: slPrice, tp_price: 50000 * 0.97,
  };
  // SL exit — current price >= sl_price
  const slResult = analyzeHunter([{ coin: 'BTC', price: slPrice + 1 }], pos);
  assert.equal(slResult.action, 'CLOSE');
  assert.equal(slResult.reason, 'hunter_sl');

  // 2) Через 5мин — пытаемся снова войти. Спайк есть, history достаточная.
  // (используем Date.now мок на этот тест нельзя — strategistSniper использует 'now' аргумент,
  // а post-SL cooldown пишется через Date.now() внутри checkHunterExit. Берём тест "напрямую":
  // SL только что сработал, а entry-проверка делается сразу = within 30 min.)
  const now = Date.now();
  push('BTC', 50000, now - 3 * MIN);
  push('BTC', 50000, now - 2 * MIN);
  const entry = analyzeHunter([{ coin: 'BTC', price: 53000 }], null, now);
  assert.equal(entry.action, 'HOLD', 'должен быть в post-SL cooldown');
});

// ═══════════════════════════════════════════════
//  Time-stop (HUNTER_TIME_STOP_MIN, default 60)
// ═══════════════════════════════════════════════

test('time-stop: позиция держится <60мин и цена в range → HOLD', () => {
  reset();
  const pos = {
    coin:        'BTC',
    strategy_id: 'hunter',
    entry_price: 50000,
    sl_price:    50000 * 1.02,
    tp_price:    50000 * 0.97,
    entry_time:  Date.now() - 30 * MIN,  // 30 мин назад
  };
  // Цена в range — ни SL ни TP
  const r = analyzeHunter([{ coin: 'BTC', price: 50100 }], pos);
  assert.equal(r.action, 'HOLD');
});

test('time-stop: ≥60мин и цена в range → CLOSE hunter_time_stop по market', () => {
  reset();
  const pos = {
    coin:        'BTC',
    strategy_id: 'hunter',
    entry_price: 50000,
    sl_price:    50000 * 1.02,
    tp_price:    50000 * 0.97,
    entry_time:  Date.now() - 61 * MIN,  // 61 мин назад
  };
  const r = analyzeHunter([{ coin: 'BTC', price: 50100 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_time_stop');
  assert.equal(r.price, 50100);  // market price, не SL/TP
});

test('time-stop: после срабатывания регистрирует post-cooldown на монету', () => {
  reset();
  const pos = {
    coin:        'BTC',
    strategy_id: 'hunter',
    entry_price: 50000,
    sl_price:    50000 * 1.02,
    tp_price:    50000 * 0.97,
    entry_time:  Date.now() - 61 * MIN,
  };
  const exitResult = analyzeHunter([{ coin: 'BTC', price: 50100 }], pos);
  assert.equal(exitResult.action, 'CLOSE');
  assert.equal(exitResult.reason, 'hunter_time_stop');

  // Сразу пробуем войти снова — должен быть HOLD из-за post-cooldown
  const now = Date.now();
  push('BTC', 50000, now - 3 * MIN);
  push('BTC', 50000, now - 2 * MIN);
  const entry = analyzeHunter([{ coin: 'BTC', price: 53000 }], null, now);
  assert.equal(entry.action, 'HOLD', 'post-time-stop cooldown должен блокировать');
});

test('time-stop: SL/TP имеют приоритет над time-stop', () => {
  reset();
  const pos = {
    coin:        'BTC',
    strategy_id: 'hunter',
    entry_price: 50000,
    sl_price:    50000 * 1.02,
    tp_price:    50000 * 0.97,
    entry_time:  Date.now() - 90 * MIN,  // 90 мин — time-stop активен
  };
  // Но цена выше SL → SL должен сработать первым
  const r = analyzeHunter([{ coin: 'BTC', price: 51500 }], pos);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'hunter_sl');
});

test('post-SL cooldown НЕ блокирует другие монеты', () => {
  reset();
  const slPrice = 50000 * 1.02;
  const pos = {
    id: 1, coin: 'BTC', strategy_id: 'hunter',
    sl_price: slPrice, tp_price: 50000 * 0.97,
  };
  analyzeHunter([{ coin: 'BTC', price: slPrice + 1 }], pos);

  // ETH должен быть свободен — он не получал SL.
  const now = Date.now();
  push('ETH', 3000, now - 3 * MIN);
  push('ETH', 3000, now - 2 * MIN);
  const entry = analyzeHunter([{ coin: 'ETH', price: 3180 }], null, now);
  assert.equal(entry.action, 'OPEN');
});
