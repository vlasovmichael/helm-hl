// Нянька — разбор открытых позиций против их плана на бирже.
//
// Запуск: npm test
//
// Что закрыто тестами (всё это — способы соврать о риске, а не косметика):
//  - стоп берётся ТОЛЬКО из trigger + reduceOnly: обычная reduce-only лимитка
//    это цель, и принять её за стоп значит показать защиту там, где её нет
//  - reduce-only лимитка ПРОТИВ хода целью не считается
//  - стоп в прибыли (подтянутый за вход) не даёт отрицательного/бесконечного R
//  - частичный стоп (объём меньше позиции) не выдаётся за полную защиту
//  - позиция без стопа сортируется первой и попадает в счётчик unprotected
//  - суммарный риск не смешивает «риск $0» и «риск неизвестен»

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { protectiveOrders, buildPositionView, buildNannyView } from '../src/modules/positionNanny.js';

const stopOrder = (coin, px, sz = 1) => ({
  coin, isTrigger: true, reduceOnly: true, orderType: 'Stop Market', triggerPx: String(px), sz: String(sz),
});
const limitOrder = (coin, px, sz = 1) => ({
  coin, isTrigger: false, reduceOnly: true, orderType: 'Limit', limitPx: String(px), sz: String(sz),
});

const longPos = { side: 'LONG', entryPx: 100, szi: 1, notionalUsd: 100, unrealizedPnl: 2 };

test('стоп ищется только среди trigger-ордеров', () => {
  // Обычная reduce-only лимитка ниже цены для лонга — это выход в убыток
  // лимитом, а не стоп. Принять её за стоп = нарисовать защиту, которой нет.
  const o = protectiveOrders([limitOrder('AAA', 95)], 'AAA', 'LONG', 102);
  assert.equal(o.stop, null);
});

test('цель против хода сделки целью не считается', () => {
  // Для лонга цель обязана быть ВЫШЕ цены. Лимитка ниже — не цель.
  const o = protectiveOrders([limitOrder('AAA', 95)], 'AAA', 'LONG', 102);
  assert.equal(o.target, null);
  const ok = protectiveOrders([limitOrder('AAA', 110)], 'AAA', 'LONG', 102);
  assert.equal(ok.target.px, 110);
});

test('из нескольких стопов берётся ближайший к цене', () => {
  const o = protectiveOrders([stopOrder('AAA', 90), stopOrder('AAA', 97)], 'AAA', 'LONG', 102);
  assert.equal(o.stop.px, 97);
  assert.equal(o.stopCount, 2);
});

test('риск считается в долларах от входа до стопа', () => {
  const v = buildPositionView({
    coin: 'AAA', position: longPos, price: 102,
    orders: [stopOrder('AAA', 95), limitOrder('AAA', 115)],
  });
  assert.equal(v.status, 'armed');
  assert.equal(v.plan.riskUsd, 5);      // (100 − 95) × 1
  assert.equal(v.plan.rewardUsd, 15);   // (115 − 100) × 1
  assert.equal(v.plan.rr, 3);
  assert.equal(v.plan.rNow, 0.4);       // pnl 2 / риск 5
});

test('стоп в прибыли не даёт отрицательного R', () => {
  // Стоп подтянут выше входа: риска больше нет. Делить на «отрицательный риск»
  // нельзя — R не определён, и панель обязана сказать это словами.
  const v = buildPositionView({
    coin: 'AAA', position: longPos, price: 105, orders: [stopOrder('AAA', 103)],
  });
  assert.equal(v.plan.stopLocksProfit, true);
  assert.equal(v.plan.riskUsd, null);
  assert.equal(v.plan.rNow, null);
  assert.ok(v.notes.some((n) => /locks in profit/.test(n)));
});

test('позиция без стопа помечается unprotected, риск не выдаётся за ноль', () => {
  const v = buildPositionView({ coin: 'AAA', position: longPos, price: 102, orders: [] });
  assert.equal(v.status, 'unprotected');
  assert.equal(v.plan.riskUsd, null);
  assert.ok(/There is NO stop on the exchange/.test(v.headline));
});

test('нечитаемые ордера — отдельный статус, а не «стопа нет»', () => {
  const v = buildPositionView({
    coin: 'AAA', position: longPos, price: 102, orders: [], ordersKnown: false,
  });
  assert.equal(v.status, 'orders_unknown');
});

test('частичный стоп помечается: прикрыт не весь объём', () => {
  const v = buildPositionView({
    coin: 'AAA', position: { ...longPos, szi: 2, notionalUsd: 200 }, price: 102,
    orders: [stopOrder('AAA', 95, 1)],
  });
  assert.ok(v.notes.some((n) => /the rest of the position is unprotected/.test(n)));
});

test('шорт: риск и цель считаются в обратную сторону', () => {
  const v = buildPositionView({
    coin: 'AAA',
    position: { side: 'SHORT', entryPx: 100, szi: -1, notionalUsd: 100, unrealizedPnl: 3 },
    price: 97,
    orders: [stopOrder('AAA', 104), limitOrder('AAA', 92)],
  });
  assert.equal(v.plan.riskUsd, 4);
  assert.equal(v.plan.rewardUsd, 8);
  assert.equal(v.position.gainPct, 3);
});

test('незащищённые позиции идут первыми, сумма риска не включает неизвестное', () => {
  const positions = new Map([
    ['AAA', longPos],
    ['BBB', { side: 'LONG', entryPx: 50, szi: 2, notionalUsd: 100, unrealizedPnl: 0 }],
  ]);
  const prices = new Map([['AAA', 102], ['BBB', 50]]);
  const view = buildNannyView({
    positions, prices,
    orders: [stopOrder('AAA', 95), limitOrder('AAA', 115)], // у BBB стопа нет
  });
  assert.equal(view.positions[0].coin, 'BBB');
  assert.equal(view.totals.unprotected, 1);
  // Только риск AAA: у BBB он не ноль, а неизвестен, и в сумму не входит.
  assert.equal(view.totals.riskUsd, 5);
});

test('R:R ниже единицы попадает в заметки с нужным винрейтом', () => {
  const v = buildPositionView({
    coin: 'AAA', position: longPos, price: 100,
    orders: [stopOrder('AAA', 96), limitOrder('AAA', 102)],
  });
  assert.equal(v.plan.rr, 0.5);
  assert.ok(v.notes.some((n) => /Plan R:R 0\.50/.test(n) && /67%/.test(n)));
});
