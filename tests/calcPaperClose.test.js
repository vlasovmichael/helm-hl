// Тесты чистой функции calcPaperClose (математика funding − fees, maker vs taker
// exitFeeRate). Раньше жили вместе с decideSniperAction (Sniper Mode удалён
// 2026-06-17), оставлены ради покрытия maker-exit ветки exitFeeRate.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── ENV до импорта ──
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.TELEGRAM_BOT_TOKEN    = '';

const {
  calcPaperClose,
  ONE_LEG, MAKER_FEE_RATE,
} = await import('../src/modules/executor/math.js');

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
