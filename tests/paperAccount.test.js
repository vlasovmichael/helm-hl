// Бухгалтерия бумажного счёта: комиссии, маржа, развороты, ликвидация.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAKER_FEE_RATE, TAKER_FEE_RATE,
  accrueFunding, availableOf, clearinghouseView, createPaperState, equityOf, executeFill,
  limitReached, liquidationHit, liquidationPrice, marginHeld, marginShortfall, spotView, triggerFired,
} from '../src/core/paperAccount.js';

const NOW = 1_800_000_000_000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const fresh = () => createPaperState(100, NOW);
const buy = (state, sz, px, extra = {}) => executeFill(state, { coin: 'BTC', isBuy: true, sz, px, oid: 1, crossed: true, now: NOW, ...extra });
const sell = (state, sz, px, extra = {}) => executeFill(state, { coin: 'BTC', isBuy: false, sz, px, oid: 2, crossed: true, now: NOW, ...extra });

test('вход списывает тейкерскую комиссию и держит маржу', () => {
  const state = fresh();
  state.leverage.BTC = 2;
  const [fill] = buy(state, 0.001, 50_000);
  near(state.cash, 100 - 50 * TAKER_FEE_RATE);
  near(marginHeld(state), 25);
  assert.equal(fill.dir, 'Open Long');
  assert.equal(fill.side, 'B');
  assert.equal(fill.closedPnl, '0');
});

test('закрытие фиксирует PnL до комиссии, как closedPnl на бирже', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  const [fill] = sell(state, 0.001, 51_000);
  near(parseFloat(fill.closedPnl), 1);
  near(state.cash, 100 + 1 - 50 * TAKER_FEE_RATE - 51 * TAKER_FEE_RATE);
  assert.equal(fill.dir, 'Close Long');
  assert.equal(fill.startPosition, '0.001');
  assert.deepEqual(state.positions, {});
  assert.equal(marginHeld(state), 0);
});

test('шорт зарабатывает на падении', () => {
  const state = fresh();
  sell(state, 0.001, 50_000);
  const [fill] = buy(state, 0.001, 49_000);
  near(parseFloat(fill.closedPnl), 1);
  assert.equal(fill.dir, 'Close Short');
});

test('мейкерский филл платит мейкерскую ставку', () => {
  const state = fresh();
  buy(state, 0.001, 50_000, { crossed: false });
  near(state.cash, 100 - 50 * MAKER_FEE_RATE);
});

test('разворот даёт два филла: закрытие и открытие', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  const fills = sell(state, 0.003, 50_000);
  assert.deepEqual(fills.map((f) => f.dir), ['Close Long', 'Open Short']);
  near(state.positions.BTC.szi, -0.002);
});

test('reduce-only не открывает позицию сверх закрываемого объёма', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  const fills = sell(state, 0.003, 50_000, { reduceOnly: true });
  assert.equal(fills.length, 1);
  assert.deepEqual(state.positions, {});
});

test('частичное закрытие освобождает маржу пропорционально', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  sell(state, 0.0004, 50_000);
  near(marginHeld(state), 30);
});

test('докупка усредняет вход', () => {
  const state = fresh();
  buy(state, 0.0005, 50_000);
  buy(state, 0.0005, 52_000);
  near(state.positions.BTC.entryPx, 51_000);
});

test('equity включает uPnL, свободное за вычетом маржи не уходит ниже нуля', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  const marks = { BTC: 49_000 };
  near(equityOf(state, marks), state.cash - 1);
  near(availableOf(state, marks), state.cash - 1 - 50);

  const levered = fresh();
  levered.leverage.BTC = 5;
  buy(levered, 0.005, 50_000);
  assert.equal(availableOf(levered, { BTC: 35_000 }), 0);
});

test('нехватка маржи считается с учётом плеча и разворота', () => {
  const state = fresh();
  const order = { coin: 'BTC', isBuy: true, sz: 0.01, px: 50_000 };
  assert.ok(marginShortfall(state, order, {}) > 0);
  state.leverage.BTC = 5;
  assert.equal(marginShortfall(state, order, {}), 0);

  const flip = fresh();
  buy(flip, 0.001, 50_000);
  assert.equal(marginShortfall(flip, { coin: 'BTC', isBuy: false, sz: 0.001, px: 50_000 }, {}), 0);
});

test('резервная лимитка на открытие держит маржу, reduce-only нет', () => {
  const state = fresh();
  state.orders.push({ coin: 'BTC', isBuy: true, sz: 0.001, px: 50_000, reduceOnly: false, kind: 'limit' });
  state.orders.push({ coin: 'BTC', isBuy: false, sz: 0.001, px: 60_000, reduceOnly: true, kind: 'limit' });
  near(marginHeld(state), 50);
});

test('цена ликвидации: без плеча лонгу её нет, с плечом ближе к входу', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  assert.equal(liquidationPrice(state.positions.BTC, 20), null);

  const levered = fresh();
  levered.leverage.BTC = 10;
  buy(levered, 0.001, 50_000);
  const level = liquidationPrice(levered.positions.BTC, 20);
  assert.ok(level > 45_000 && level < 50_000);
  assert.ok(liquidationHit(levered.positions.BTC, level - 1, 20));
  assert.ok(!liquidationHit(levered.positions.BTC, level + 100, 20));
});

test('стоп и цель срабатывают в свою сторону для лонга и шорта', () => {
  const longStop = { isBuy: false, tpsl: 'sl', px: 100 };
  assert.ok(triggerFired(longStop, 99));
  assert.ok(!triggerFired(longStop, 101));
  const longTake = { isBuy: false, tpsl: 'tp', px: 100 };
  assert.ok(triggerFired(longTake, 101));
  assert.ok(!triggerFired(longTake, 99));
  const shortStop = { isBuy: true, tpsl: 'sl', px: 100 };
  assert.ok(triggerFired(shortStop, 101));
  const shortTake = { isBuy: true, tpsl: 'tp', px: 100 };
  assert.ok(triggerFired(shortTake, 99));
});

test('лимитка наливается, только когда цена дошла до неё', () => {
  assert.ok(limitReached({ isBuy: true, px: 100 }, 100));
  assert.ok(!limitReached({ isBuy: true, px: 100 }, 100.5));
  assert.ok(limitReached({ isBuy: false, px: 100 }, 100));
  assert.ok(!limitReached({ isBuy: false, px: 100 }, 99.5));
});

test('фандинг: лонг при положительной ставке платит, шорт получает', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  const before = state.cash;
  accrueFunding(state, { BTC: 0.0001 }, { BTC: 50_000 }, NOW);
  near(state.cash, before - 0.005);
  near(state.positions.BTC.funding.sinceOpen, 0.005);
  assert.equal(state.funding[0].delta.coin, 'BTC');
  near(parseFloat(state.funding[0].delta.usdc), -0.005);

  const short = fresh();
  sell(short, 0.001, 50_000);
  const shortBefore = short.cash;
  accrueFunding(short, { BTC: 0.0001 }, { BTC: 50_000 }, NOW);
  near(short.cash, shortBefore + 0.005);
});

test('ответы чтения повторяют форму биржи', () => {
  const state = fresh();
  buy(state, 0.001, 50_000);
  const marks = { BTC: 51_000 };
  const view = clearinghouseView(state, marks, () => 40, NOW);
  const { position } = view.assetPositions[0];
  assert.equal(position.coin, 'BTC');
  assert.equal(position.szi, '0.001');
  near(parseFloat(position.unrealizedPnl), 1);
  near(parseFloat(position.positionValue), 51);
  assert.equal(position.leverage.type, 'isolated');
  assert.equal(view.marginSummary.totalUnrealizedPnl, undefined);

  const [usdc] = spotView(state, marks).balances;
  near(parseFloat(usdc.total), equityOf(state, marks));
  near(parseFloat(usdc.hold), 50);
});
