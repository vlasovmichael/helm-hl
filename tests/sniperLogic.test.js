// Тесты чистых функций Iter 2: calcPaperClose (математика маркер/таймаут)
// и decideSniperAction (state machine снайпера).
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта ──
process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const {
  calcPaperClose,
  ONE_LEG, MAKER_FEE_RATE, SNIPER_WINDOW_MS, FEE_RATE, SLIPPAGE,
} = await import('../src/modules/executor/math.js');

const { decideSniperAction } =
  await import('../src/modules/executor/sniper.js');

// ── calcPaperClose ────────────────────────────

test('calcPaperClose default — две taker-ноги (обратная совместимость)', () => {
  // size=$100, APY=100%, hold=1h. hourlyRate = 1/365/24. fundingPnl = 100 * rate * 1.
  const pos = { size_usd: 100, entry_apy: 100 };
  const { fundingPnl, totalFee, realizedPnl } = calcPaperClose(pos, 1);

  const expectedFunding = 100 * (100 / 100 / 365 / 24) * 1;
  const expectedFee = 100 * ONE_LEG * 2;  // вход + выход = 2 × ONE_LEG

  assert.equal(fundingPnl.toFixed(8), expectedFunding.toFixed(8));
  assert.equal(totalFee, expectedFee);
  assert.equal(realizedPnl.toFixed(8), (expectedFunding - expectedFee).toFixed(8));
});

test('calcPaperClose с MAKER exit — fees ниже, чем у market', () => {
  const pos = { size_usd: 100, entry_apy: 100 };
  const market = calcPaperClose(pos, 1);                         // default ONE_LEG
  const maker  = calcPaperClose(pos, 1, MAKER_FEE_RATE);

  assert.ok(maker.totalFee < market.totalFee, 'maker fee должен быть меньше market fee');

  const expectedMakerFee = 100 * (ONE_LEG + MAKER_FEE_RATE);
  assert.equal(maker.totalFee.toFixed(8), expectedMakerFee.toFixed(8));

  // Сэкономленные комиссии = size × (ONE_LEG − MAKER_FEE_RATE)
  const savings = market.totalFee - maker.totalFee;
  const expectedSavings = 100 * (ONE_LEG - MAKER_FEE_RATE);
  assert.equal(savings.toFixed(8), expectedSavings.toFixed(8));
});

test('calcPaperClose: маркер-сценарий на $44 позиции (контекст из kPEPE-инцидента)', () => {
  // Из памяти пользователя: позиция ~$44, profit ~$2.60 gross съел taker+slippage.
  const pos = { size_usd: 44, entry_apy: 300 };  // высокий APY, типовой кандидат
  const market = calcPaperClose(pos, 0.5);       // 30 мин hold
  const maker  = calcPaperClose(pos, 0.5, MAKER_FEE_RATE);

  const savings = market.totalFee - maker.totalFee;
  // ONE_LEG − MAKER = 0.0003 − 0.00003 = 0.00027, × $44 ≈ $0.01188
  assert.ok(savings > 0.011 && savings < 0.013, `savings ~$0.012 ожидался, получено $${savings}`);
});

// ── decideSniperAction ────────────────────────

const now = 1_700_000_000_000;
const slot = (overrides = {}) => ({
  positionId: 1,
  coin:       'kPEPE',
  reason:     'apy_below_threshold',
  armPrice:   0.001000,
  side:       'BUY',
  armedAt:    now - 60_000,   // 1 мин назад
  ...overrides,
});
const pos = (overrides = {}) => ({
  id: 1, coin: 'kPEPE', size_usd: 44, entry_price: 0.001100,
  entry_apy: 300, entry_time: now - 3600_000, ...overrides,
});

test('decideSniperAction: нет слота → idle', () => {
  const r = decideSniperAction(null, pos(), [], now);
  assert.equal(r.kind, 'idle');
});

test('decideSniperAction: позиция пропала → no-position', () => {
  const r = decideSniperAction(slot(), null, [{ coin: 'kPEPE', price: 0.001 }], now);
  assert.equal(r.kind, 'no-position');
});

test('decideSniperAction: позиция на другой монете → no-position', () => {
  const r = decideSniperAction(slot(), pos({ coin: 'ETH' }), [{ coin: 'kPEPE', price: 0.001 }], now);
  assert.equal(r.kind, 'no-position');
});

test('decideSniperAction: окно истекло → timeout с ценой из scout', () => {
  const oldSlot = slot({ armedAt: now - SNIPER_WINDOW_MS - 1_000 });  // 15m+ назад
  const r = decideSniperAction(
    oldSlot, pos(),
    [{ coin: 'kPEPE', price: 0.001050 }],
    now,
  );
  assert.equal(r.kind, 'timeout');
  assert.equal(r.price, 0.001050);
});

test('decideSniperAction: окно истекло + монеты нет в scout → timeout по armPrice', () => {
  const oldSlot = slot({ armedAt: now - SNIPER_WINDOW_MS - 1_000 });
  const r = decideSniperAction(oldSlot, pos(), [], now);
  assert.equal(r.kind, 'timeout');
  assert.equal(r.price, 0.001000);  // armPrice
});

test('decideSniperAction: нет scout-данных + окно НЕ истекло → wait', () => {
  const r = decideSniperAction(slot(), pos(), [], now);
  assert.equal(r.kind, 'wait');
});

test('decideSniperAction: цена выше armPrice → wait', () => {
  const r = decideSniperAction(
    slot(), pos(),
    [{ coin: 'kPEPE', price: 0.001005 }],  // выше armPrice=0.001
    now,
  );
  assert.equal(r.kind, 'wait');
});

test('decideSniperAction: цена = armPrice → fill (граничный случай)', () => {
  const r = decideSniperAction(
    slot(), pos(),
    [{ coin: 'kPEPE', price: 0.001000 }],
    now,
  );
  assert.equal(r.kind, 'fill');
  assert.equal(r.price, 0.001000);
});

test('decideSniperAction: цена ниже armPrice → fill', () => {
  const r = decideSniperAction(
    slot(), pos(),
    [{ coin: 'kPEPE', price: 0.000995 }],
    now,
  );
  assert.equal(r.kind, 'fill');
  assert.equal(r.price, 0.001000);  // fill по armPrice, не по market
});

test('decideSniperAction: null scoutData безопасен → wait', () => {
  const r = decideSniperAction(slot(), pos(), null, now);
  assert.equal(r.kind, 'wait');
});
