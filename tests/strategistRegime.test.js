// Tests for Market Regime velocity entry gate (Iter A).
// Гейт читается из config.trading в рантайме, поэтому в каждом тесте
// явно включаем флаг и сбрасываем после.

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

const { analyze } = await import('../src/modules/strategist.js');
const { config }  = await import('../src/core/config.js');
const priceHistory = await import('../src/core/priceHistory.js');

const MIN = 60_000;

function scoutItem(coin, smoothedApy, opts = {}) {
  return {
    coin,
    price:        opts.price ?? 100,
    fundingRate:  smoothedApy / 100 / 365 / 24,
    rawApy:       smoothedApy,
    smoothedApy,
    slowApy:      smoothedApy,
    predictedApy: smoothedApy,
    side:         opts.side ?? 'short',
  };
}

function withGate(pumpPct, lookbackMin, fn, opts = {}) {
  const t = config.trading;
  const prev = { ...t };
  t.marketRegimeVelocityEnabled = true;
  t.marketRegimeCoinPumpPct     = pumpPct;
  t.marketRegimeLookbackMin     = lookbackMin;
  // По дефолту в этих тестах второй bucket выключаем — фокусируемся на bucket 1.
  // Тесты dual-bucket поведения передают opts.lookback2Min/pumpPct2 явно.
  t.marketRegimeLookback2Min    = opts.lookback2Min ?? 0;
  t.marketRegimeCoinPumpPct2    = opts.pumpPct2 ?? 5;
  try { fn(); }
  finally {
    t.marketRegimeVelocityEnabled = prev.marketRegimeVelocityEnabled;
    t.marketRegimeCoinPumpPct     = prev.marketRegimeCoinPumpPct;
    t.marketRegimeLookbackMin     = prev.marketRegimeLookbackMin;
    t.marketRegimeLookback2Min    = prev.marketRegimeLookback2Min;
    t.marketRegimeCoinPumpPct2    = prev.marketRegimeCoinPumpPct2;
    priceHistory.clearAll();
    analyze([], undefined); // reset internal state
  }
}

test('Velocity gate: short — coin pumped > threshold → HOLD', () => {
  withGate(3, 30, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // 30мин назад цена была 100; сейчас 105 → +5% > 3% threshold
    priceHistory.push('XMR', 100, now - 30 * MIN - 1000);
    priceHistory.push('XMR',  103, now - 15 * MIN);
    priceHistory.push('XMR',  105, now);

    const r = analyze([scoutItem('XMR', 50, { price: 105 })], undefined);
    assert.equal(r.action, 'HOLD');
  });
});

test('Velocity gate: short — coin spокойна (< threshold) → OPEN', () => {
  withGate(3, 30, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // 30мин назад 100, сейчас 101 → +1% < 3% threshold
    priceHistory.push('XMR', 100, now - 30 * MIN - 1000);
    priceHistory.push('XMR', 101, now);

    const r = analyze([scoutItem('XMR', 50, { price: 101 })], undefined);
    assert.equal(r.action, 'OPEN');
    assert.equal(r.coin, 'XMR');
  });
});

test('Velocity gate: short — coin падает → OPEN (падение для шорта благоприятно)', () => {
  withGate(3, 30, () => {
    const now = Date.now();
    priceHistory.clearAll();
    priceHistory.push('XMR', 100, now - 30 * MIN - 1000);
    priceHistory.push('XMR',  90, now);                // -10% — для шорта это попутный ветер

    const r = analyze([scoutItem('XMR', 50, { price: 90 })], undefined);
    assert.equal(r.action, 'OPEN');
  });
});

test('Velocity gate: нет истории на lookback назад → HOLD (защитный default)', () => {
  withGate(3, 30, () => {
    priceHistory.clearAll();
    // Только свежие сэмплы, < lookback назад
    priceHistory.push('XMR', 100, Date.now() - 5 * MIN);
    priceHistory.push('XMR', 101, Date.now());

    const r = analyze([scoutItem('XMR', 50, { price: 101 })], undefined);
    assert.equal(r.action, 'HOLD');
  });
});

// Long-side гейт (симметричный) ждёт Iter 1.2 carry-long roadmap'а:
// сейчас analyze() в Сценарии А берёт только side==='short'. Когда long-вход
// появится — добавить здесь long-кейсы (TON dumpанула → HOLD, etc).

// ── Dual-bucket regression (XMR/TON pump→plateau pattern) ──
// Кейс: pump случился 2ч назад, затем плато. 30-мин bucket видит почти ровно
// и пропускает; 2-часовой bucket должен поймать.
test('Dual-bucket: pump 2ч назад → plateau → 30мин bucket пропускает, 2ч bucket блокирует', () => {
  withGate(3, 30, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // 2ч назад: $100. 1.5ч назад: $107 (pump). Последние 30 мин: ровно $108-$108.5.
    priceHistory.push('XMR', 100, now - 130 * MIN);
    priceHistory.push('XMR', 100, now - 121 * MIN);
    priceHistory.push('XMR', 107, now -  90 * MIN);
    priceHistory.push('XMR', 108, now -  35 * MIN);
    priceHistory.push('XMR', 108, now -  20 * MIN);
    priceHistory.push('XMR', 108.3, now);  // 30мин ago=108→now=108.3 = +0.28%, проходит b1

    const r = analyze([scoutItem('XMR', 50, { price: 108.3 })], undefined);
    assert.equal(r.action, 'HOLD');
  }, { lookback2Min: 120, pumpPct2: 5 });
});

test('Dual-bucket: оба bucket в норме → OPEN', () => {
  withGate(3, 30, () => {
    const now = Date.now();
    priceHistory.clearAll();
    priceHistory.push('XMR', 100, now - 130 * MIN);
    priceHistory.push('XMR', 100, now - 121 * MIN);
    priceHistory.push('XMR', 101, now -  60 * MIN);
    priceHistory.push('XMR', 101, now -  30 * MIN);
    priceHistory.push('XMR', 102, now);  // +2% за 2ч (<5%), +1% за 30мин (<3%)

    const r = analyze([scoutItem('XMR', 50, { price: 102 })], undefined);
    assert.equal(r.action, 'OPEN');
  }, { lookback2Min: 120, pumpPct2: 5 });
});

test('Dual-bucket: bucket 2 нет истории на 2ч назад → HOLD (защитный default)', () => {
  withGate(3, 30, () => {
    const now = Date.now();
    priceHistory.clearAll();
    // Только 30 мин истории, 2ч bucket не наполнен
    priceHistory.push('XMR', 100, now - 35 * MIN);
    priceHistory.push('XMR', 101, now);

    const r = analyze([scoutItem('XMR', 50, { price: 101 })], undefined);
    assert.equal(r.action, 'HOLD');
  }, { lookback2Min: 120, pumpPct2: 5 });
});

test('Velocity gate: off (default) → не вмешивается, OPEN без истории', () => {
  // Флаг НЕ включаем — гейт должен пропустить вход даже при пустой priceHistory
  priceHistory.clearAll();
  analyze([], undefined);
  const r = analyze([scoutItem('XMR', 50, { price: 100 })], undefined);
  assert.equal(r.action, 'OPEN');
});
