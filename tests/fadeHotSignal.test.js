import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kaufmanER,
  evaluateFadeHot,
  fadeHotZone,
} from '../src/modules/fadeHotSignal.js';

// Хелпер: массив closes → массив свечей {close}.
const C = (closes) => closes.map((close) => ({ close }));

// ── kaufmanER ────────────────────────────────────────────────────────────────

test('kaufmanER: идеально направленный ряд = 1', () => {
  // монотонный рост: net change == сумма абс. изменений → ER = 1
  const closes = [100, 101, 102, 103, 104];
  assert.equal(kaufmanER(closes, 4), 1);
});

test('kaufmanER: пила вокруг старта = низкий ER', () => {
  // вверх-вниз: net ≈ 0, vol большой → ER → 0
  const closes = [100, 110, 100, 110, 100];
  const er = kaufmanER(closes, 4);
  assert.ok(er < 0.01, `ожидали ~0, получили ${er}`);
});

test('kaufmanER: зеркалит формулу backtestExits (net/vol)', () => {
  const closes = [100, 102, 101, 105]; // win=3
  // net = |105-100| = 5; vol = |102-100|+|101-102|+|105-101| = 2+1+4 = 7
  assert.equal(kaufmanER(closes, 3), 5 / 7);
});

test('kaufmanER: мало данных → null', () => {
  assert.equal(kaufmanER([100, 101], 4), null);
});

test('kaufmanER: нулевая волатильность → null', () => {
  assert.equal(kaufmanER([100, 100, 100, 100, 100], 4), null);
});

// ── evaluateFadeHot ──────────────────────────────────────────────────────────

// Базовый направленный памп: 17 баров монотонного роста +2%/бар (компаундинг) →
// ER=1 (идеально направленный) + ход за 30м (2 бара) ≈ +4% (> порога 3%).
function pumpCloses() {
  const out = [];
  for (let i = 0; i < 17; i++) out.push(100 * 1.02 ** i);
  return out;
}

test('evaluateFadeHot: high-ER памп → fade SHORT', () => {
  const res = evaluateFadeHot(C(pumpCloses()));
  assert.equal(res.fired, true);
  assert.equal(res.side, 'SHORT');
  assert.ok(res.move > 0);
  assert.ok(res.er >= 0.47);
  assert.equal(res.reason, null);
});

test('evaluateFadeHot: high-ER дамп → fade LONG', () => {
  const closes = pumpCloses().map((_, i) => 100 * 0.98 ** i);
  const res = evaluateFadeHot(C(closes));
  assert.equal(res.fired, true);
  assert.equal(res.side, 'LONG');
  assert.ok(res.move < 0);
});

test('evaluateFadeHot: ход < порога → flat-move, не fired', () => {
  // 17 баров, но последние 2 почти ровные (ход 30м < 3%)
  const closes = pumpCloses();
  closes[closes.length - 1] = closes[closes.length - 2] * 1.001; // +0.1% за бар
  closes[closes.length - 2] = closes[closes.length - 3] * 1.001;
  const res = evaluateFadeHot(C(closes));
  assert.equal(res.fired, false);
  assert.equal(res.reason, 'flat-move');
});

test('evaluateFadeHot: большой ход но низкий ER (чоп) → low-er, не fired', () => {
  // пила (низкий ER) + резкий последний бар (большой ход 30м)
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(i % 2 === 0 ? 100 : 104);
  closes.push(110); // резкий рывок вверх на последних барах
  closes.push(116);
  const res = evaluateFadeHot(C(closes));
  assert.equal(res.fired, false);
  assert.equal(res.reason, 'low-er');
  assert.ok(Math.abs(res.move) >= 3);
});

test('evaluateFadeHot: мало свечей → warmup', () => {
  const res = evaluateFadeHot(C([100, 101, 102]));
  assert.equal(res.fired, false);
  assert.equal(res.reason, 'warmup');
});

test('evaluateFadeHot: не массив → warmup', () => {
  assert.equal(evaluateFadeHot(null).reason, 'warmup');
});

test('evaluateFadeHot: кастомные пороги уважаются', () => {
  // ровный ряд НЕ сработает при дефолте, но при erMin=0 и низком moveThr — да
  const closes = pumpCloses();
  const res = evaluateFadeHot(C(closes), { moveThr: 0.1, erMin: 0 });
  assert.equal(res.fired, true);
});

// ── fadeHotZone ──────────────────────────────────────────────────────────────

test('fadeHotZone: SHORT стоп выше цены, LONG ниже', () => {
  const s = fadeHotZone('SHORT', 100, 3);
  assert.equal(s.stop, 103);
  assert.ok(s.zoneLo < 100 && s.zoneHi > 100);

  const l = fadeHotZone('LONG', 100, 3);
  assert.equal(l.stop, 97);
});
