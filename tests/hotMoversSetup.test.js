import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveOiKind,
  evaluateSetup,
  classifyChase,
} from '../src/modules/hotMoversSetup.js';

const W = (vals) => [2, 5, 15, 60].map((mins, i) => ({ mins, spikePct: vals[i] }));

test('deriveOiKind: 15m приоритетнее 5m, пороги', () => {
  assert.equal(deriveOiKind({ oiDelta15m: 2 }), 'up');
  assert.equal(deriveOiKind({ oiDelta15m: -2 }), 'down');
  assert.equal(deriveOiKind({ oiDelta15m: 0.3 }), 'flat');
  assert.equal(deriveOiKind({ oiDelta5m: 0.6 }), 'up'); // fallback на 5m
  assert.equal(deriveOiKind({}), null);
});

test('evaluateSetup: trend long = цена↑ + OI↑', () => {
  const s = evaluateSetup(W([3, 3, 3, 3]), { oiDelta15m: 2 });
  assert.equal(s.side, 'LONG');
  assert.equal(s.mode, 'trend');
  assert.ok(s.score > 3);
});

test('evaluateSetup: fade short = цена↑ + OI↓', () => {
  const s = evaluateSetup(W([3, 3, 3, 3]), { oiDelta15m: -2 });
  assert.equal(s.side, 'SHORT');
  assert.equal(s.mode, 'fade');
});

test('evaluateSetup: OI флэт → mode null, направление по движению', () => {
  const s = evaluateSetup(W([-2, -2, -2, -2]), { oiDelta15m: 0 });
  assert.equal(s.side, 'SHORT');
  assert.equal(s.mode, null);
});

test('evaluateSetup: нет данных → side null', () => {
  const s = evaluateSetup(W([null, null, null, null]), { oiDelta15m: 2 });
  assert.equal(s.side, null);
  assert.equal(s.score, 0);
});

test('classifyChase: WAIT (score<1.5) → none', () => {
  const c = classifyChase(W([0.1, 0.1, 0.1, 0.1]), 'LONG', 0.5);
  assert.equal(c.state, 'none');
});

test('classifyChase: LONG растяжка вверх = extended (поздно)', () => {
  const c = classifyChase(W([3, 3, 3, 3]), 'LONG', 7.8);
  assert.equal(c.state, 'extended');
  assert.ok(c.extDir >= 2.5);
});

test('classifyChase: LONG у базы / откат = zone', () => {
  const c = classifyChase(W([0.1, 0.2, 0.2, 4]), 'LONG', 5);
  assert.equal(c.state, 'zone'); // 15m=+0.2 в сторону сделки ≤0.5
});

test('classifyChase: LONG откат вниз = zone (а не extended)', () => {
  // 15m −2% для лонга = откат → вход рядом, не «улетела»
  const c = classifyChase(W([0, 0, -2, 0]), 'LONG', 5);
  assert.equal(c.state, 'zone');
});

test('classifyChase: FADE SHORT на пампе = zone (вход до разворота)', () => {
  // side SHORT, цена пампит (15m +3) → extDir = −3 ≤ 0.5 → zone
  const c = classifyChase(W([3, 3, 3, 3]), 'SHORT', 7.8);
  assert.equal(c.state, 'zone');
});

test('classifyChase: SHORT цена уже упала = extended (фейд отыгран)', () => {
  // side SHORT, 15m −3 → extDir = +3 → late
  const c = classifyChase(W([0, 0, -3, 0]), 'SHORT', 5);
  assert.equal(c.state, 'extended');
});
