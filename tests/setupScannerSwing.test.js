// Тесты Setup Scanner Swing: классификация тренда + свинг-вердикт (карточка B).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  classifySwingTrend, scoreSwingSignal, classifyEntryZone,
} = await import('../src/modules/setupScannerSwing.js');

// ── Helpers ────────────────────────────────────
function fromCloses(closes) {
  return closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c }));
}
function rising(n, start, step) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

const P1H = { fast: 20, slow: 200 };

// ── classifySwingTrend ─────────────────────────

test('classifySwingTrend: insufficient history → none', () => {
  const r = classifySwingTrend(fromCloses(rising(50, 100, 1)), P1H);
  assert.equal(r.trend, 'none');
  assert.equal(r.reason, 'insufficient_history');
});

test('classifySwingTrend: steady uptrend → up', () => {
  const r = classifySwingTrend(fromCloses(rising(250, 100, 1)), P1H);
  assert.equal(r.trend, 'up');
  assert.ok(r.emaFast > r.emaSlow);
});

test('classifySwingTrend: steady downtrend → down', () => {
  const r = classifySwingTrend(fromCloses(rising(250, 400, -1)), P1H);
  assert.equal(r.trend, 'down');
  assert.ok(r.emaFast < r.emaSlow);
});

test('classifySwingTrend: mixed (спайк против тренда) → none', () => {
  // Даунтренд, последняя свеча выстреливает выше EMA200, но EMA20 всё ещё ниже:
  // цена > emaSlow при emaFast < emaSlow — чёткого расклада нет.
  const closes = [...rising(249, 400, -1), 260];
  const r = classifySwingTrend(fromCloses(closes), P1H);
  assert.equal(r.trend, 'none');
  assert.equal(r.reason, 'mixed');
});

// ── scoreSwingSignal ───────────────────────────

const OI_UP   = { deltaOi: 0.12, deltaPx: 0.08 };   // OI↑ + цена↑
const OI_DUMP = { deltaOi: 0.10, deltaPx: -0.15 };  // OI↑ + цена↓

test('LONG: 4h↑ + 1h↑ + OI confirm + funding ok', () => {
  const r = scoreSwingSignal({ trend4h: 'up', trend1h: 'up', oi7d: OI_UP, fundingApy: 12 });
  assert.equal(r.signal, 'LONG');
  assert.ok(r.strength > 0);
  assert.ok(r.reasons.some((s) => s.includes('real demand')));
});

test('SHORT: 4h↓ + 1h↓ + OI растёт на падении + funding ok', () => {
  const r = scoreSwingSignal({ trend4h: 'down', trend1h: 'down', oi7d: OI_DUMP, fundingApy: -10 });
  assert.equal(r.signal, 'SHORT');
  assert.ok(r.reasons.some((s) => s.includes('shorts pressing')));
});

test('WAIT: тренды 4h/1h разошлись', () => {
  const r = scoreSwingSignal({ trend4h: 'up', trend1h: 'down', oi7d: OI_UP, fundingApy: 5 });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes('diverge')));
});

test('WAIT: нет тренда на 4h', () => {
  const r = scoreSwingSignal({ trend4h: 'none', trend1h: 'up', oi7d: OI_UP, fundingApy: 5 });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes('no 4h trend')));
});

test('WAIT: OI не подтверждает лонг (OI падает)', () => {
  const r = scoreSwingSignal({
    trend4h: 'up', trend1h: 'up',
    oi7d: { deltaOi: -0.2, deltaPx: 0.1 }, fundingApy: 5,
  });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes("doesn't confirm long")));
});

test('WAIT: OI-история ещё копится', () => {
  const r = scoreSwingSignal({
    trend4h: 'up', trend1h: 'up',
    oi7d: { ageHours: 30, etaHours: 138 }, fundingApy: 5,
  });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes('collecting')));
});

test('WAIT: funding в эйфории блокирует LONG', () => {
  const r = scoreSwingSignal({ trend4h: 'up', trend1h: 'up', oi7d: OI_UP, fundingApy: 55 });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes('euphoric')));
});

test('WAIT: funding в панике блокирует SHORT', () => {
  const r = scoreSwingSignal({ trend4h: 'down', trend1h: 'down', oi7d: OI_DUMP, fundingApy: -60 });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes('panicked')));
});

test('LONG без funding-данных (null) — funding не блокирует', () => {
  const r = scoreSwingSignal({ trend4h: 'up', trend1h: 'up', oi7d: OI_UP, fundingApy: null });
  assert.equal(r.signal, 'LONG');
});

test('WAIT (pending): тренд ещё не посчитан', () => {
  const r = scoreSwingSignal({ trend4h: null, trend1h: null, oi7d: OI_UP, fundingApy: 5 });
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.reasons.some((s) => s.includes('computing')));
});

// ── classifyEntryZone ──────────────────────────

test('entryZone LONG: откат к/ниже EMA20 = zone', () => {
  assert.equal(classifyEntryZone('LONG', -1.2), 'zone');
  assert.equal(classifyEntryZone('LONG', 0.3), 'zone');
});

test('entryZone LONG: растянута вверх = extended, между = mid', () => {
  assert.equal(classifyEntryZone('LONG', 3.1), 'extended');
  assert.equal(classifyEntryZone('LONG', 1.5), 'mid');
});

test('entryZone SHORT: зеркало (откат вверх = zone, растянута вниз = extended)', () => {
  assert.equal(classifyEntryZone('SHORT', 0.8), 'zone');
  assert.equal(classifyEntryZone('SHORT', -0.2), 'zone');
  assert.equal(classifyEntryZone('SHORT', -3.0), 'extended');
  assert.equal(classifyEntryZone('SHORT', -1.5), 'mid');
});

test('entryZone: WAIT или нет данных → null', () => {
  assert.equal(classifyEntryZone('WAIT', 1.0), null);
  assert.equal(classifyEntryZone('LONG', null), null);
});
