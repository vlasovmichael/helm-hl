import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveOiKind,
  evaluateSetup,
  classifyChase,
  computeBreadthFlush,
  isFadeMutedByFlush,
  deriveAccelKind,
  fadeExhaustionMuted,
} from '../src/modules/hotMoversSetup.js';

const W = (vals) => [2, 5, 15, 60].map((mins, i) => ({ mins, spikePct: vals[i] }));

// Строка breadth: ход + OI 15m.
const ROW = (priceVals, oi15) => ({ windows: W(priceVals), oiDelta15m: oi15 });
const DOWN_FLUSH = ROW([-2, -2, -2, -2], -2); // цена↓ + OI↓
const UP_SQUEEZE = ROW([2, 2, 2, 2], -2); // цена↑ + OI↓
const TREND_DOWN = ROW([-2, -2, -2, -2], 2); // цена↓ + OI↑ (не делевередж)

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

// ── Breadth-слив ──────────────────────────────────────────────────────────────

test('computeBreadthFlush: <FLUSH_MIN_N монет → inactive', () => {
  const f = computeBreadthFlush(Array(5).fill(DOWN_FLUSH));
  assert.equal(f.active, false);
  assert.equal(f.n, 5);
});

test('computeBreadthFlush: широкий down-слив → active dir=down', () => {
  const rows = [...Array(6).fill(DOWN_FLUSH), TREND_DOWN]; // 6/7 ≈ 0.86 ≥ 0.6
  const f = computeBreadthFlush(rows);
  assert.equal(f.active, true);
  assert.equal(f.dir, 'down');
  assert.ok(f.share >= 0.6);
});

test('computeBreadthFlush: широкий up-сквиз → active dir=up', () => {
  const f = computeBreadthFlush(Array(8).fill(UP_SQUEEZE));
  assert.equal(f.active, true);
  assert.equal(f.dir, 'up');
});

test('computeBreadthFlush: ниже порога доли → inactive', () => {
  // 3 down-flush + 5 trend-down = down-share 3/8 < 0.6
  const rows = [...Array(3).fill(DOWN_FLUSH), ...Array(5).fill(TREND_DOWN)];
  const f = computeBreadthFlush(rows);
  assert.equal(f.active, false);
});

test('isFadeMutedByFlush: fade-long против down-слива → mute', () => {
  assert.equal(isFadeMutedByFlush('LONG', 'fade', { active: true, dir: 'down' }), true);
  assert.equal(isFadeMutedByFlush('SHORT', 'fade', { active: true, dir: 'up' }), true);
});

test('isFadeMutedByFlush: trend и fade В СТОРОНУ слива не трогаем', () => {
  assert.equal(isFadeMutedByFlush('SHORT', 'trend', { active: true, dir: 'down' }), false);
  assert.equal(isFadeMutedByFlush('SHORT', 'fade', { active: true, dir: 'down' }), false);
  assert.equal(isFadeMutedByFlush('LONG', 'fade', { active: false, dir: null }), false);
});

test('evaluateSetup: fade-long в down-сливе → mode снят, flushMuted', () => {
  const flush = { active: true, dir: 'down' };
  const s = evaluateSetup(W([-3, -3, -3, -3]), { oiDelta15m: -2 }, flush);
  assert.equal(s.side, 'LONG');
  assert.equal(s.mode, null);
  assert.equal(s.flushMuted, true);
  assert.ok(s.score > 3); // сила сохраняется, гаснет только actionable
});

test('evaluateSetup: тот же сетап без flush → fade long actionable', () => {
  const s = evaluateSetup(W([-3, -3, -3, -3]), { oiDelta15m: -2 });
  assert.equal(s.side, 'LONG');
  assert.equal(s.mode, 'fade');
});

// ── deriveAccelKind ──────────────────────────────────────────────────────────
test('deriveAccelKind: ускорение/выдох/разворот', () => {
  // NIL-кейс: 2m −0.36, 5m −0.50 → ratio 1.8 → ускорение в сторону движения.
  assert.equal(deriveAccelKind({ spikePct: -0.36 }, { spikePct: -0.5 }), 'up');
  // 2m мал относительно 5m → выдыхается.
  assert.equal(deriveAccelKind({ spikePct: -0.1 }, { spikePct: -0.5 }), 'down');
  // знаки разные + |2m|>0.2 → разворот.
  assert.equal(deriveAccelKind({ spikePct: 0.5 }, { spikePct: -0.5 }), 'rev');
  assert.equal(deriveAccelKind(null, { spikePct: -0.5 }), null);
});

// ── fadeExhaustionMuted (юнит) ───────────────────────────────────────────────
test('fadeExhaustionMuted: только fade, accel↑ и фейд-по-тренду', () => {
  assert.equal(fadeExhaustionMuted('fade', true, 'up', null), 'accel'); // нож разгоняется
  assert.equal(fadeExhaustionMuted('fade', true, 'down', 'up'), 'htf'); // fade-short в up-тренде
  assert.equal(fadeExhaustionMuted('fade', false, 'down', 'down'), 'htf'); // fade-long в down-тренде
  assert.equal(fadeExhaustionMuted('fade', false, 'down', 'none'), null); // выдох + нет тренда → ок
  assert.equal(fadeExhaustionMuted('trend', true, 'up', 'up'), null); // trend не трогаем
});

// ── evaluateSetup: fade-гейт по ускорению (NIL/CHIP — лов ножа) ──────────────
test('evaluateSetup: fade + accel↑ → mode снят, fadeMuted=accel', () => {
  const s = evaluateSetup(W([-3, -3, -3, -3]), { oiDelta15m: -2 }, null, 'up', null);
  assert.equal(s.side, 'LONG');
  assert.equal(s.mode, null);
  assert.equal(s.fadeMuted, 'accel');
  assert.ok(s.score > 3); // сила есть, гаснет только actionable
});

// ── evaluateSetup: fade-гейт по старшему тренду (BABY) ───────────────────────
test('evaluateSetup: fade-short против 1h-аплёта → fadeMuted=htf', () => {
  const s = evaluateSetup(W([3, 3, 3, 3]), { oiDelta15m: -2 }, null, 'down', 'up');
  assert.equal(s.side, 'SHORT');
  assert.equal(s.mode, null);
  assert.equal(s.fadeMuted, 'htf');
});

test('evaluateSetup: fade-long при затухании и без тренда → остаётся actionable', () => {
  const s = evaluateSetup(W([-3, -3, -3, -3]), { oiDelta15m: -2 }, null, 'down', 'none');
  assert.equal(s.side, 'LONG');
  assert.equal(s.mode, 'fade');
});

test('evaluateSetup: trend не трогается accel↑/htf', () => {
  const s = evaluateSetup(W([3, 3, 3, 3]), { oiDelta15m: 2 }, null, 'up', 'down');
  assert.equal(s.side, 'LONG');
  assert.equal(s.mode, 'trend');
});
