// Трейл няньки выключен по умолчанию (23.08.2026).
//
// Why: на 127 закрытиях adopt_trail_tp медиана отдачи от пика была 40% при
// пороге 30% (p90 = 68%), а худший случай ушёл с пика +2.86% в минус −0.72%.
// Правило «дать прибыли тянуться» на практике отдавало её обратно. Здесь
// проверяется, что без ADOPT_TRAIL_ENABLED откат от пика больше не закрывает
// позу, а BE-храповик и биржевой SL продолжают работать.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
delete process.env.ADOPT_TRAIL_ENABLED; // дефолт = выключен

const { analyzeAdopt, resetAdoptState, getAdoptPeakPct } =
  await import('../src/modules/strategistAdopt.js');

const short = (id = 1) => ({ id, coin: 'NIL', side: 'short', entry_price: 100 });
const long  = (id = 1) => ({ id, coin: 'NIL', side: 'long',  entry_price: 100 });

test('трейл выключен: SHORT отдал 75% пика — HOLD, а не adopt_trail_tp', () => {
  resetAdoptState();
  const p = short();
  assert.equal(analyzeAdopt(p, 98).action, 'HOLD');   // пик +2%
  assert.equal(analyzeAdopt(p, 99.5).action, 'HOLD'); // отдал 1.5 из 2 — раньше CLOSE
});

test('трейл выключен: LONG отдал 75% пика — HOLD', () => {
  resetAdoptState();
  const p = long();
  assert.equal(analyzeAdopt(p, 102).action, 'HOLD');
  assert.equal(analyzeAdopt(p, 100.5).action, 'HOLD');
});

test('BE-храповик продолжает работать без трейла', () => {
  resetAdoptState();
  const p = short();
  assert.equal(analyzeAdopt(p, 98.4).action, 'HOLD'); // пик +1.6% ≥ BE_ARM 1.5 → взвод
  const r = analyzeAdopt(p, 100);                     // вернулись к входу
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.reason, 'adopt_breakeven_ratchet');
});

test('пик всё равно копится — MFE для разбора не теряется', () => {
  resetAdoptState();
  const p = short(7);
  analyzeAdopt(p, 97);  // +3%
  analyzeAdopt(p, 99);  // откат
  assert.ok(getAdoptPeakPct(7) >= 3);
});
