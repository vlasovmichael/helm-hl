// riskTint: фазы полосы на PnL-карточке.
// Регресс: с выключенным храповиком (ADOPT_BE_ARM_PCT=999) веха
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

// ── Веха трейла ──────────────────────────────────────────────────────────────
// Регресс: храповик выключен, трейл на +2%, а полоса мерила
// до 2R (≈+10% при стопе 5%) — ползла на седьмую часть, и понять, когда
// наступит трейл, можно было только гадая по «peak +1.69%».
const SKR = {
  entry: 0.007517,
  side: 'LONG',
  stopPrice: 0.007146, // risk ≈ 4.93% → 2R ≈ +9.87%
  sizeUsd: 34.3,
  beArmPct: 999,       // храповик выключен
  trailArmPct: 2,
};

test('трейл — ближайшая веха: полоса мерит до него, а не до 2R', () => {
  const t = riskTint({ ...SKR, now: 0.007621, peakPct: 1.69 }); // +1.38%, пик +1.69%
  assert.strictEqual(t.phase, 'trail');
  assert.ok(Math.abs(t.milestonePct - 2) < 1e-9, `веха должна быть +2%, получили ${t.milestonePct}`);
  // Край заливки = 1.38/2 ≈ 0.69 (раньше было 1.38/9.87 ≈ 0.14).
  assert.ok(t.now > 0.65 && t.now < 0.72, `заливка ~0.69, получили ${t.now}`);
  // Призрак = пик 1.69/2 ≈ 0.845 — именно он взводит трейл.
  assert.ok(t.peak > 0.83 && t.peak < 0.86, `призрак ~0.845, получили ${t.peak}`);
});

test('остаток до трейла считается от ПИКА, а не от текущей цены', () => {
  const t = riskTint({ ...SKR, now: 0.007621, peakPct: 1.69 });
  // До вехи по пику 0.31%, а не 0.62% как от текущей.
  assert.match(t.tip, /\+0\.31%/);
  assert.match(t.tip, /at peak/);
});

test('трейл взведён (по пику) → полоса переезжает на отрезок до профита', () => {
  const t = riskTint({ ...SKR, now: 0.007621, peakPct: 2.4 });
  assert.strictEqual(t.phase, 'profit');
  // Отрезок стартует от вехи трейла (+2%), а текущий ход +1.38% — ещё до неё.
  assert.strictEqual(t.now, 0);
});

test('trailArmed с бэка главнее локального расчёта по пику', () => {
  const t = riskTint({ ...SKR, now: 0.007621, peakPct: 0.5, trailArmed: true });
  assert.strictEqual(t.phase, 'profit');
});

test('трейл выключен (null) — фазы «до трейла» нет, как раньше', () => {
  const t = riskTint({ ...LONG, now: 102, beArmPct: 999, trailArmPct: null });
  assert.strictEqual(t.phase, 'profit');
});

test('веха трейла дальше цели прибыли — не веха', () => {
  const t = riskTint({ ...LONG, now: 102, beArmPct: 999, trailArmPct: 50 });
  assert.strictEqual(t.phase, 'profit');
});

test('SHORT: фаза «до трейла» зеркальна', () => {
  const t = riskTint({
    entry: 100, side: 'SHORT', stopPrice: 105, now: 99, beArmPct: 999,
    trailArmPct: 2, peakPct: 1,
  });
  assert.strictEqual(t.phase, 'trail');
  assert.ok(Math.abs(t.milestonePct - 2) < 1e-9);
  assert.ok(Math.abs(t.now - 0.5) < 1e-9);
});
