import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
// Дефолты: ADOPT_TIMECUT_MIN=75, GREEN_PCT=0.3; PEAK_ALERT MFE=2.5, GIVEBACK=15,
// TRAIL_GIVE_BACK=30.

const { isBeyondPlannedStop } = await import('../src/app/adoptReconcile.js');
const { shouldFirePeakAlert } = await import('../src/app/adoptSupervise.js');

// ── Сирота-гард: цена уже за плановым стопом ─────────────────────────────────

test('orphan-guard SHORT: цена выше SL → beyond (стоп сработал бы мгновенно)', () => {
  assert.equal(isBeyondPlannedStop({ side: 'short', price: 105.1, plannedSl: 105 }), true);
  assert.equal(isBeyondPlannedStop({ side: 'short', price: 105, plannedSl: 105 }), true);
});

test('orphan-guard SHORT: цена ниже SL → ok, усыновляем', () => {
  assert.equal(isBeyondPlannedStop({ side: 'short', price: 104.9, plannedSl: 105 }), false);
});

test('orphan-guard LONG: цена ниже SL → beyond', () => {
  assert.equal(isBeyondPlannedStop({ side: 'long', price: 94.9, plannedSl: 95 }), true);
});

test('orphan-guard LONG: цена выше SL → ok', () => {
  assert.equal(isBeyondPlannedStop({ side: 'long', price: 95.1, plannedSl: 95 }), false);
});

test('orphan-guard: нет цены (getLivePrice упал) → НЕ beyond, идём прежним путём', () => {
  assert.equal(isBeyondPlannedStop({ side: 'short', price: null, plannedSl: 105 }), false);
  assert.equal(isBeyondPlannedStop({ side: 'long', price: NaN, plannedSl: 95 }), false);
});

// ── Пик-алерт: peak ≥ 2.5% и откат ≥ 15% от пика, 1 раз на позицию ───────────

test('peak-alert: пик 3%, откат до +2.4% (20% от пика) → алерт', () => {
  assert.equal(shouldFirePeakAlert({ peakPct: 3, unrealizedPct: 2.4, alreadyFired: false }), true);
});

test('peak-alert: пик 3%, откат до +2.7% (10% < 15%) → рано', () => {
  assert.equal(shouldFirePeakAlert({ peakPct: 3, unrealizedPct: 2.7, alreadyFired: false }), false);
});

test('peak-alert: пик 2% < порога MFE 2.5 → молчим (это зона трейла/BE)', () => {
  assert.equal(shouldFirePeakAlert({ peakPct: 2, unrealizedPct: 1, alreadyFired: false }), false);
});

test('peak-alert: уже отправляли по этой позе → молчим', () => {
  assert.equal(shouldFirePeakAlert({ peakPct: 3, unrealizedPct: 2.4, alreadyFired: true }), false);
});

test('peak-alert: улетели в минус → молчим (история про BE/стоп, не про пик)', () => {
  assert.equal(shouldFirePeakAlert({ peakPct: 3, unrealizedPct: -0.5, alreadyFired: false }), false);
});
