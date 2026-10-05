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

test('R и прогресс считаются от показанной цены, а не от биржевого uPnL', () => {
  // Цена ровно на входе, но биржа отдала uPnL от mark (на дешёвых монетах mid и
  // mark расходятся). Панель обязана показать 0R: иначе она спорит сама с собой —
  // «+0.00%» рядом с «−0.07R».
  const v = buildPositionView({
    coin: 'PUMP',
    position: { side: 'SHORT', entryPx: 0.00484, szi: -3239, notionalUsd: 15.71, unrealizedPnl: -0.04 },
    price: 0.00484,
    orders: [stopOrder('PUMP', 0.004991, 3239), limitOrder('PUMP', 0.004689, 3239)],
  });
  assert.equal(v.plan.rNow, 0, 'цена на входе → ноль R, что бы ни отдал uPnL');
  assert.equal(v.plan.progressPct, 0);
  assert.equal(v.position.unrealizedPnl, -0.04, 'деньги остаются биржевыми');
});

test('фильтрует чужие, не reduce-only и битые защитные ордера', () => {
  const o = protectiveOrders([
    stopOrder('BBB', 90),
    { ...stopOrder('AAA', 90), reduceOnly: false },
    { ...stopOrder('AAA', 90), orderType: 'Take Profit' },
    { ...stopOrder('AAA', 0) },
    { ...limitOrder('AAA', 110), limitPx: 'not-a-price' },
    stopOrder('aaa', 95, -2), limitOrder('aAa', 112, -3),
  ], 'AAA', 'LONG', 100);
  assert.deepEqual(o, {
    stop: { px: 95, sz: 2 }, target: { px: 112, sz: 3 },
    stopCount: 1, targetCount: 1, stopSz: 2, targetSz: 3,
  });
});

test('шорт выбирает ближайшую цель ниже текущей цены и не принимает trigger как цель', () => {
  const o = protectiveOrders([
    limitOrder('AAA', 94), limitOrder('AAA', 98), limitOrder('AAA', 101),
    { ...stopOrder('AAA', 105), orderType: 'Take Profit' },
  ], 'AAA', 'SHORT', 100);
  assert.equal(o.target.px, 98);
  assert.equal(o.targetCount, 2);
});

test('стоп без цели и нулевая дистанция до стопа имеют разные факты риска', () => {
  const onlyStop = buildPositionView({
    coin: 'AAA', position: longPos, price: 100, orders: [stopOrder('AAA', 95)],
  });
  assert.equal(onlyStop.status, 'stop_only');
  assert.equal(onlyStop.plan.rewardUsd, null);
  assert.equal(onlyStop.plan.progressPct, null);
  assert.ok(onlyStop.notes.some((n) => /stop costs \$5\.00/.test(n)));

  const breakeven = buildPositionView({
    coin: 'AAA', position: longPos, price: 100, orders: [stopOrder('AAA', 100)],
  });
  assert.equal(breakeven.plan.stopLocksProfit, true);
  assert.equal(breakeven.plan.riskUsd, null);
  assert.equal(breakeven.plan.riskPct, 0);
});

test('прогресс ограничен интервалом 0..100, а близкий стоп отмечается', () => {
  const below = buildPositionView({
    coin: 'AAA', position: longPos, price: 90,
    orders: [stopOrder('AAA', 89.5), limitOrder('AAA', 110)],
  });
  assert.equal(below.plan.progressPct, 0);
  assert.ok(below.notes.some((n) => /0\.56% to the stop/.test(n)));

  const passedTarget = buildPositionView({
    coin: 'AAA', position: longPos, price: 130,
    orders: [stopOrder('AAA', 90), limitOrder('AAA', 110)],
  });
  // Лимитка, уже оставшаяся позади цены, больше не плановая цель.
  assert.equal(passedTarget.plan.target, null);
  assert.equal(passedTarget.plan.progressPct, null);
  assert.equal(passedTarget.plan.rNow, 3);
});

test('несколько целей и стопов выводятся в заметках, а coverage считает полный объём', () => {
  const v = buildPositionView({
    coin: 'AAA', position: { ...longPos, szi: -2 }, price: 102,
    orders: [stopOrder('AAA', 90, 1), stopOrder('AAA', 95, 1), limitOrder('AAA', 110), limitOrder('AAA', 120)],
  });
  assert.equal(v.plan.stopCoverage, 1);
  assert.ok(v.notes.some((n) => /several stops \(2\)/.test(n)));
  assert.ok(v.notes.some((n) => /several targets \(2\)/.test(n)));
});

test('сводка пропускает позиции с невалидной ценой, фиксирует время и сортирует равные риски по размеру', () => {
  const positions = new Map([
    ['BAD_PRICE', { ...longPos, entryPx: 0 }],
    ['A', { ...longPos, notionalUsd: 100 }],
    ['B', { ...longPos, notionalUsd: 200 }],
  ]);
  const v = buildNannyView({
    positions, prices: new Map([['A', 100], ['B', 100]]), orders: [], now: 123,
  });
  assert.equal(v.generatedAt, 123);
  assert.deepEqual(v.positions.map((x) => x.coin), ['B', 'A']);
  assert.deepEqual(v.totals, { count: 2, notionalUsd: 300, riskUsd: null, unprotected: 2 });
});

test('пустые ордера, отсутствующая цена и цена на границе не создают вымышленный план', () => {
  assert.deepEqual(protectiveOrders(null, 'AAA', 'LONG', 100), {
    stop: null, target: null, stopCount: 0, targetCount: 0, stopSz: 0, targetSz: 0,
  });
  const atPrice = protectiveOrders([limitOrder('AAA', 100)], 'AAA', 'LONG', 100);
  assert.equal(atPrice.target, null);
  const v = buildPositionView({ coin: 'AAA', position: { ...longPos, entryPx: 0 }, price: 10, orders: [] });
  assert.equal(v.position.gainPct, null);
  assert.equal(v.plan.stopCoverage, null);
});

test('все показанные проценты и текст статусов отражают только существующий план', () => {
  const armed = buildPositionView({
    coin: 'AAA', position: { ...longPos, szi: 2 }, price: 105,
    orders: [stopOrder('AAA', 90, 2), limitOrder('AAA', 120, 2)],
  });
  assert.equal(armed.headline, 'Stop and target are both in place');
  assert.match(armed.detail, /nothing to do/);
  assert.equal(armed.position.gainPct, 5);
  assert.equal(armed.plan.riskPct, 10);
  assert.equal(armed.plan.rewardPct, 20);
  assert.equal(armed.plan.toStopPct, 14.285714285714285);
  assert.equal(armed.plan.toTargetPct, 14.285714285714285);
  assert.equal(armed.plan.rewardUsd, 40);
  assert.equal(armed.plan.stopCoverage, 1);

  const unknown = buildPositionView({ coin: 'AAA', position: longPos, price: 100, ordersKnown: false });
  assert.equal(unknown.headline, 'Could not read orders from the exchange');
  assert.match(unknown.detail, /protected is unknown/);
  assert.equal(unknown.plan.stop, null);
  assert.equal(unknown.plan.target, null);
});

test('нулевая либо обратная цель не становится доходом, а полный стоп не рисует предупреждение части объёма', () => {
  const noReward = buildPositionView({
    coin: 'AAA', position: longPos, price: 100,
    orders: [stopOrder('AAA', 95), limitOrder('AAA', 90)],
  });
  assert.equal(noReward.status, 'stop_only');
  assert.equal(noReward.plan.rewardUsd, null);
  assert.equal(noReward.plan.rr, null);
  assert.equal(noReward.plan.toTargetPct, null);
  assert.ok(!noReward.notes.some((n) => /rest of the position/.test(n)));
});

test('сводка считает orders_unknown как незашищённую и использует entry как fallback цены', () => {
  const v = buildNannyView({
    positions: new Map([['AAA', longPos]]), prices: new Map(), orders: [], ordersKnown: false, now: 7,
  });
  assert.equal(v.positions[0].position.price, 100);
  assert.equal(v.positions[0].status, 'orders_unknown');
  assert.equal(v.totals.unprotected, 1);
  assert.equal(v.totals.riskUsd, null);
  assert.equal(v.ordersKnown, false);
});

test('границы ордеров не допускают нулевую цену и равную текущей цель', () => {
  const o = protectiveOrders([
    null,
    { coin: 'AAA', reduceOnly: true, isTrigger: true, triggerPx: '95', sz: '1' },
    limitOrder('AAA', 0), limitOrder('AAA', 100), limitOrder('AAA', 101),
  ], 'AAA', 'LONG', 100);
  assert.equal(o.stop, null, 'без типа stop trigger не является стопом');
  assert.equal(o.targetCount, 1);
  assert.equal(o.target.px, 101);
});

test('сообщения статуса не деградируют в пустой текст', () => {
  const cases = [
    [{ ordersKnown: false }, 'Could not read orders from the exchange', 'The list of open orders could not be fetched. Whether the position is protected is unknown; staying quiet about that is worse than saying it. Check the stop by hand in the terminal.'],
    [{ orders: [] }, 'There is NO stop on the exchange', 'The position has no protective trigger order. Rule 2 of TRADING_RULES: the stop goes in BEFORE the entry. Until it exists, the loss on this trade is unbounded.'],
    [{ orders: [stopOrder('AAA', 95)] }, 'Stop is set, target is not', 'The position is protected but has no profit exit. Without a target limit the exit gets decided in the moment — and in the journal that is exactly how green turns into flat.'],
  ];
  for (const [extra, headline, detail] of cases) {
    const v = buildPositionView({ coin: 'AAA', position: longPos, price: 100, ...extra });
    assert.equal(v.headline, headline);
    assert.equal(v.detail, detail);
  }
});

test('некорректные нулевые входы не превращаются в бесконечные проценты или позицию', () => {
  const noEntry = buildPositionView({
    coin: 'AAA', position: { ...longPos, entryPx: 0 }, price: 10, orders: [stopOrder('AAA', 5)],
  });
  assert.equal(noEntry.plan.riskPct, 0);
  assert.equal(noEntry.plan.toStopPct, 50);
  const v = buildNannyView({
    positions: new Map([['ZERO', { ...longPos, entryPx: 0 }], ['NO_PRICE', longPos]]),
    prices: new Map([['NO_PRICE', 0]]), orders: [], now: 2,
  });
  assert.equal(v.positions.length, 0);
  assert.equal(v.totals.notionalUsd, 0);
});

test('отсутствующий план сохраняет пустые заметки и null-поля, а не псевдо-значения', () => {
  const v = buildPositionView({ coin: 'AAA', position: longPos, price: 100, orders: [], ordersKnown: false });
  assert.deepEqual(v.notes, []);
  assert.equal(v.plan.riskPct, null);
  assert.equal(v.plan.rewardPct, null);
  assert.equal(v.plan.toStopPct, null);
  assert.equal(v.plan.toTargetPct, null);
  assert.equal(v.plan.rr, null);
  assert.equal(v.plan.rNow, null);
  assert.equal(v.plan.progressPct, null);
});
