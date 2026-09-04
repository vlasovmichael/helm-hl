// Плановая цель adopt: дистанция от стопа, а не от ATR заново.
//
// Why: цель теперь висит на бирже reduce-only лимиткой с момента
// подхвата — так она исполняется мейкером и не зависит от того, проснулся ли
// бот. Считать её независимо по ATR нельзя: стоп зажат в [MIN_PCT, MAX_PCT], и
// в зажатых случаях заявленный R:R разъехался бы с настоящим. Здесь проверяется,
// что R:R держится, а потолок честно сообщает о срезе.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { computeAdoptTp, breakevenWinrate } = await import('../src/app/adoptReconcile.js');

test('LONG, RR=1: цель на той же дистанции, что и стоп', () => {
  const r = computeAdoptTp({ side: 'long', entry: 100, stopDistPct: 3, rr: 1, maxPct: 15 });
  assert.equal(r.distPct, 3);
  assert.ok(Math.abs(r.tpPrice - 103) < 1e-9);
  assert.equal(r.capped, false);
  assert.equal(r.rr, 1);
});

test('SHORT, RR=1: цель НИЖЕ входа — short зарабатывает на падении', () => {
  const r = computeAdoptTp({ side: 'short', entry: 100, stopDistPct: 3, rr: 1, maxPct: 15 });
  assert.ok(Math.abs(r.tpPrice - 97) < 1e-9);
});

test('RR=0.5: цель вдвое ближе стопа', () => {
  const r = computeAdoptTp({ side: 'long', entry: 200, stopDistPct: 4, rr: 0.5, maxPct: 15 });
  assert.equal(r.distPct, 2);
  assert.ok(Math.abs(r.tpPrice - 204) < 1e-9);
});

test('потолок режет цель и роняет фактический R:R — это видно в ответе', () => {
  const r = computeAdoptTp({ side: 'long', entry: 100, stopDistPct: 8, rr: 3, maxPct: 15 });
  assert.equal(r.capped, true);
  assert.equal(r.distPct, 15);          // 8 × 3 = 24 → срезано до 15
  assert.ok(Math.abs(r.rr - 15 / 8) < 1e-9); // заявляли 3, по факту 1.875
});

test('мусор на входе → null, а не кривая цена на бирже', () => {
  assert.equal(computeAdoptTp({ side: 'long', entry: 0, stopDistPct: 3, rr: 1, maxPct: 15 }), null);
  assert.equal(computeAdoptTp({ side: 'long', entry: 100, stopDistPct: 0, rr: 1, maxPct: 15 }), null);
  assert.equal(computeAdoptTp({ side: 'long', entry: 100, stopDistPct: 3, rr: 0, maxPct: 15 }), null);
  assert.equal(computeAdoptTp({ side: 'long', entry: 100, stopDistPct: NaN, rr: 1, maxPct: 15 }), null);
});

test('breakeven-winrate: цена решения по R:R', () => {
  assert.ok(Math.abs(breakevenWinrate(1) - 50) < 1e-9);
  assert.ok(Math.abs(breakevenWinrate(0.5) - 66.666) < 0.01);
  assert.ok(Math.abs(breakevenWinrate(1 / 3) - 75) < 1e-9);
  assert.equal(breakevenWinrate(0), null);
});

// ── Риск позиции против депо (серверная сторона) ─────────────────────────────
// Та же арифметика, что в тикете, но для няньки: она видит уже открытую позу и
// может только назвать цифру вслух — сужать стоп под чужой размер нельзя.

const { assessPositionRisk } = await import('../src/app/adoptReconcile.js');

test('assessPositionRisk: PUMP 22.08 — 36% депо, размер под порог ниже минимума', () => {
  const r = assessPositionRisk({
    notionalUsd: 21.97, stopDistPct: 7.12, equityUsd: 4.31, riskPct: 5,
  });
  assert.equal(r.riskUsd.toFixed(2), '1.56');
  assert.equal(r.riskPctOfEquity.toFixed(0), '36');
  assert.equal(r.overLimit, true);
  assert.equal(r.suggestedNotionalUsd.toFixed(2), '3.03');
});

test('assessPositionRisk: в пределах порога — тишина', () => {
  const r = assessPositionRisk({
    notionalUsd: 100, stopDistPct: 3, equityUsd: 2000, riskPct: 5,
  });
  assert.equal(r.overLimit, false);
});

test('assessPositionRisk: депо неизвестно — доля null, алерта не будет', () => {
  const r = assessPositionRisk({
    notionalUsd: 100, stopDistPct: 3, equityUsd: null, riskPct: 5,
  });
  assert.equal(r.riskPctOfEquity, null);
  assert.equal(r.overLimit, false);
  assert.equal(r.suggestedNotionalUsd, null);
});
