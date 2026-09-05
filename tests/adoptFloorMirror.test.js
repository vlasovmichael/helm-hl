// Пол в карточке = цена РЕАЛЬНОГО ордера, а не пересчитанный идеал.
//
// Why: пол едет биржевым ордером шагами ADOPT_TRAIL_FLOOR_STEP_PCT, а идеал
// считается от свежего пика и убегает вперёд. 05.09 карточка обещала +$0.21,
// на бирже стоял ордер на +$0.17 — оператор принял решение по числу, которого
// на бирже не было. Тот же класс, что остальные «зеркало ≠ биржа».
//
// Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { resolveFloor } = await import('../src/modules/dashboard/server.js');

// Тот самый DASH: вход 67.992, ордер-пол на 66.8259, идеал от пика 66.5915.
const DASH = { entry: 67.992, isShort: true, slPrice: 66.8259, floorOrderMode: true };
const IDEAL_PCT = ((67.992 - 66.5915) / 67.992) * 100; // 2.06% — то, что рисовал идеал

test('трейл-пол ордером: берётся цена ордера, а не идеал от пика', () => {
  const r = resolveFloor({ ...DASH, floorPct: IDEAL_PCT, floorKind: 'trail' });
  assert.equal(r.floorSource, 'order');
  assert.ok(Math.abs(r.floorPct - 1.7151) < 0.001, `ожидали 1.7151%, получили ${r.floorPct}`);
  // Ровно та разница, что обманула: идеал обещал заметно больше ордера.
  assert.ok(r.floorPct < IDEAL_PCT);
});

test('безубыточный пол ордером — тоже с биржи', () => {
  const r = resolveFloor({ ...DASH, slPrice: 67.992, floorPct: 0.5, floorKind: 'be' });
  assert.equal(r.floorSource, 'order');
  assert.ok(Math.abs(r.floorPct) < 1e-9);
});

test('LONG считается зеркально', () => {
  const r = resolveFloor({ entry: 100, isShort: false, slPrice: 102, floorOrderMode: true, floorPct: 5, floorKind: 'trail' });
  assert.equal(r.floorSource, 'order');
  assert.ok(Math.abs(r.floorPct - 2) < 1e-9);
});

// Когда ордера нет, закрывает сам бот — тогда расчётный уровень и есть правда.
test('без ордера на бирже показывается плановый уровень', () => {
  const off = resolveFloor({ ...DASH, floorOrderMode: false, floorPct: IDEAL_PCT, floorKind: 'trail' });
  assert.equal(off.floorSource, 'planned');
  assert.equal(off.floorPct, IDEAL_PCT);

  const noSl = resolveFloor({ ...DASH, slPrice: null, floorPct: IDEAL_PCT, floorKind: 'trail' });
  assert.equal(noSl.floorSource, 'planned');
});

// Жёсткий стоп и так берётся из sl_price веткой выше — подменять его незачем.
test('жёсткий стоп не подменяется', () => {
  const r = resolveFloor({ ...DASH, floorPct: -4.6, floorKind: 'stop' });
  assert.equal(r.floorSource, 'planned');
  assert.equal(r.floorPct, -4.6);
});
