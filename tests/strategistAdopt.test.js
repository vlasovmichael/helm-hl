import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
// Дефолты adopt: BE_ARM=1.5, FLOOR=0, TRAIL_ARM=2, GIVE_BACK=30.

const { analyzeAdopt, resetAdoptState } = await import('../src/modules/strategistAdopt.js');

function short(id = 1) {
  return { id, coin: 'NIL', side: 'short', entry_price: 100 };
}
function long(id = 1) {
  return { id, coin: 'NIL', side: 'long', entry_price: 100 };
}

// ── SHORT ────────────────────────────────────────────────────────────────────

test('adopt SHORT: flat → HOLD', () => {
  resetAdoptState();
  assert.equal(analyzeAdopt(short(), 100).action, 'HOLD');
});

test('adopt SHORT: trail — пик +2% затем откат до +0.5% (give back 1.5 ≥ 0.6) → CLOSE', () => {
  resetAdoptState();
  const p = short();
  assert.equal(analyzeAdopt(p, 98).action, 'HOLD');     // +2% пик, ещё держим
  const r = analyzeAdopt(p, 99.5);                       // +0.5%, отдал 1.5 от пика 2
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_trail_tp');
  assert.ok(r.peakPct >= 2);
});

test('adopt SHORT: BE-храповик — пик +1.6% (<trail), возврат к входу → CLOSE в безубыток', () => {
  resetAdoptState();
  const p = short();
  assert.equal(analyzeAdopt(p, 98.4).action, 'HOLD');   // +1.6% — взвели храповик, не trail
  const r = analyzeAdopt(p, 100);                        // unrealized 0 ≤ floor
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_breakeven_ratchet');
});

test('adopt SHORT: жёсткий стоп НЕ дублируем — цена против входа без арма → HOLD (биржа держит SL)', () => {
  resetAdoptState();
  const p = short();
  // Сразу в минус (для шорта цена выше входа), пик никогда не дошёл до ARM.
  assert.equal(analyzeAdopt(p, 101.5).action, 'HOLD');
});

// ── LONG ─────────────────────────────────────────────────────────────────────

test('adopt LONG: trail — пик +2% затем откат до +0.5% → CLOSE', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 102).action, 'HOLD');    // +2% пик
  const r = analyzeAdopt(p, 100.5);                      // +0.5%
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_trail_tp');
});

test('adopt LONG: BE-храповик — пик +1.6%, возврат к входу → CLOSE в безубыток', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 101.6).action, 'HOLD');
  const r = analyzeAdopt(p, 100);
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_breakeven_ratchet');
});

test('adopt LONG: жёсткий стоп НЕ дублируем — цена против входа без арма → HOLD', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 98.5).action, 'HOLD');
});

// ── Защита от мусора ──────────────────────────────────────────────────────────

test('adopt: невалидная цена → HOLD', () => {
  resetAdoptState();
  assert.equal(analyzeAdopt(short(), 0).action, 'HOLD');
  assert.equal(analyzeAdopt(short(), NaN).action, 'HOLD');
});
