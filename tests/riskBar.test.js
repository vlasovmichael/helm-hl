// riskTint: фазы полосы на PnL-карточке.
// Регресс 2026-08-06: с выключенным храповиком (ADOPT_BE_ARM_PCT=999) веха
// «до храповика» уезжала на +999% от входа, фаза «arm» съедала весь плюс и
// заливка стояла на нуле — в минусе полоса при этом работала.
import test from 'node:test';
import assert from 'node:assert';
import { riskTint } from '../src/modules/dashboard/web/src/utils/riskBar.js';

const LONG = { entry: 100, side: 'LONG', stopPrice: 98, sizeUsd: 50 }; // risk=2, target=2R=+4%

test('храповик выключен (999): плюс меряется до профита, а не до недостижимой вехи', () => {
  const t = riskTint({ ...LONG, now: 102, beArmPct: 999 }); // +2% = половина до 2R
  assert.strictEqual(t.phase, 'profit');
  assert.ok(t.now > 0.4 && t.now < 0.6, `заливка должна быть ~0.5, получили ${t.now}`);
});

test('храповик включён (1.5): пока не взведён — фаза «до храповика»', () => {
  const t = riskTint({ ...LONG, now: 100.75, beArmPct: 1.5 });
  assert.strictEqual(t.phase, 'arm');
  assert.ok(Math.abs(t.now - 0.5) < 1e-9);
});

test('минус меряется до стопа независимо от храповика', () => {
  for (const beArmPct of [1.5, 999]) {
    const t = riskTint({ ...LONG, now: 99, beArmPct });
    assert.strictEqual(t.phase, 'stop');
    assert.ok(Math.abs(t.now - 0.5) < 1e-9);
  }
});

test('SHORT: та же симметрия при выключенном храповике', () => {
  const t = riskTint({ entry: 100, side: 'SHORT', stopPrice: 102, now: 98, beArmPct: 999 });
  assert.strictEqual(t.phase, 'profit');
  assert.ok(Math.abs(t.now - 0.5) < 1e-9);
});
