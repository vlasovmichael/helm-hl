// Target-trail: снять лимитку у цели и дальше вести стоп за ценой.
//
// Why (03.09.2026): просьба оператора — фиксация отдаёт ровно RR и обрезает редкие
// сделки, где движение продолжается. Замер (46 сделок) дал +0.154R против
// фиксации при CI95 [−0.033, +0.378] и медиане +0.844R, поэтому правило
// выключено по умолчанию и живёт как гипотеза adopt-target-trail.
//
// Здесь проверяется только механика решения — она обязана быть предсказуемой,
// раз уж снимает живой ордер с биржи.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { decideTargetTrail, unrealizedR, riskDistance, trailFloorPrice } =
  await import('../src/modules/targetTrail.js');

const ARM = 0.9, GB = 0.25;

test('ход в R считается от расстояния до стопа, а не от входа в процентах', () => {
  // лонг: вход 100, стоп 96 → риск 4. Цена 102 = +0.5R
  assert.equal(unrealizedR({ entry: 100, price: 102, stopPrice: 96, isShort: false }), 0.5);
  // шорт: вход 100, стоп 104 → риск 4. Цена 98 = +0.5R
  assert.equal(unrealizedR({ entry: 100, price: 98, stopPrice: 104, isShort: true }), 0.5);
});

test('без стопа правило молчит — R-шкалы нет', () => {
  assert.equal(riskDistance({ entry: 100, stopPrice: 0 }), null);
  assert.equal(unrealizedR({ entry: 100, price: 102, stopPrice: null, isShort: false }), null);
  assert.deepEqual(decideTargetTrail({ currentR: NaN, peakR: 1, armed: false, armR: ARM, giveBackR: GB }),
    { action: 'NONE' });
});

test('до порога лимитка не снимается', () => {
  const d = decideTargetTrail({ currentR: 0.7, peakR: 0.85, armed: false, armR: ARM, giveBackR: GB });
  assert.equal(d.action, 'NONE');
});

test('на подходе к цели правило взводится', () => {
  const d = decideTargetTrail({ currentR: 0.9, peakR: 0.9, armed: false, armR: ARM, giveBackR: GB });
  assert.equal(d.action, 'ARM');
});

test('взведённый трейл держит, пока откат меньше отступа', () => {
  // пик 1.5R, откат до 1.3R — отступ 0.25R ещё не выбран
  const d = decideTargetTrail({ currentR: 1.3, peakR: 1.5, armed: true, armR: ARM, giveBackR: GB });
  assert.equal(d.action, 'NONE');
});

test('закрывает, когда откат от пика достиг отступа', () => {
  const d = decideTargetTrail({ currentR: 1.25, peakR: 1.5, armed: true, armR: ARM, giveBackR: GB });
  assert.equal(d.action, 'CLOSE');
  assert.match(d.reason, /откат с пика/);
});

test('правило не откатывается назад: взведённое состояние не сбрасывается низким ходом', () => {
  // цена вернулась к 0.3R, но позиция уже взведена → это CLOSE, а не «разоружить»
  const d = decideTargetTrail({ currentR: 0.3, peakR: 1.0, armed: true, armR: ARM, giveBackR: GB });
  assert.equal(d.action, 'CLOSE', 'вернуть снятую лимитку нельзя — остаётся только выйти');
});

test('пол трейла в цене считается от пика, и только для взведённой позиции', () => {
  assert.equal(trailFloorPrice({ entry: 100, stopPrice: 96, isShort: false, peakR: 1.5, giveBackR: GB, armed: false }),
    null, 'до взвода пол держит обычный стоп');
  // лонг: риск 4, пик 1.5R, отступ 0.25R → пол на 1.25R = 105
  assert.equal(trailFloorPrice({ entry: 100, stopPrice: 96, isShort: false, peakR: 1.5, giveBackR: GB, armed: true }), 105);
  // шорт зеркально: 100 − 1.25×4 = 95
  assert.equal(trailFloorPrice({ entry: 100, stopPrice: 104, isShort: true, peakR: 1.5, giveBackR: GB, armed: true }), 95);
});
