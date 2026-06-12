import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoinFeatures, evaluateCoinAlert } from '../src/modules/hotMoversSetup.js';

const W = (vals) => [2, 5, 15, 60].map((mins, i) => ({ mins, spikePct: vals[i] }));
const ITEM = { coin: 'TEST', price: 100, oiUsd: 1000 };
const MIN = 3; // порог силы для пуша (как дефолт воркера)
const evalAlert = (item, feats, prev) => evaluateCoinAlert(item, feats, prev, MIN);

// Сильный trend-long сетап (OI↑), но 15m у базы → чейз-зона 🎯.
const ZONE = { windows: W([0.1, 0.2, 0.2, 4]), oiDelta5m: null, oiDelta15m: 2 };
// Тот же сетап, но 15m улетел вверх → extended ⛔.
const EXT = { windows: W([3, 3, 3, 3]), oiDelta5m: null, oiDelta15m: 2 };

test('evaluateCoinAlert: первое наблюдение не пушит (анти-спам на старте)', () => {
  const prev = new Map();
  const r = evalAlert(ITEM, ZONE, prev);
  assert.equal(r.fire, false);
  assert.equal(prev.get('TEST').state, 'zone');
});

test('evaluateCoinAlert: переход extended → zone пушит', () => {
  const prev = new Map();
  evalAlert(ITEM, EXT, prev); // tick1: extended
  const r = evalAlert(ITEM, ZONE, prev); // tick2: откатился в зону
  assert.equal(r.fire, true);
  assert.equal(r.side, 'LONG');
  assert.equal(r.mode, 'trend');
});

test('evaluateCoinAlert: zone → zone не пушит повторно', () => {
  const prev = new Map();
  evalAlert(ITEM, EXT, prev);
  assert.equal(evalAlert(ITEM, ZONE, prev).fire, true);
  assert.equal(evalAlert(ITEM, ZONE, prev).fire, false); // держится в зоне
});

test('evaluateCoinAlert: WAIT (нет режима/слабый) не пушит', () => {
  const prev = new Map();
  // OI флэт → mode null → не actionable, даже если в зоне
  const flat = { windows: W([0.1, 0.2, 0.2, 4]), oiDelta15m: 0 };
  evalAlert(ITEM, EXT, prev);
  assert.equal(evalAlert(ITEM, flat, prev).fire, false);
});

test('buildCoinFeatures: spikePct и OI-дельты из истории', () => {
  const deps = {
    priceNMinAgo: (_c, m) => (m === 15 ? 98 : 100), // 15m назад было 98
    oiNMinAgo: (_c, m) => (m === 5 ? 900 : 950),
  };
  const f = buildCoinFeatures(ITEM, Date.now(), deps);
  const w15 = f.windows.find((w) => w.mins === 15);
  assert.ok(Math.abs(w15.spikePct - ((100 - 98) / 98) * 100) < 1e-9);
  assert.ok(Math.abs(f.oiDelta5m - ((1000 - 900) / 900) * 100) < 1e-9);
});
