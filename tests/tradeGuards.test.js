// Гейты ручного входа — дневной бюджет сделок и пауза перезахода.
//
// Запуск: npm test
//
// Что закрыто тестами (всё это — способы тихо пропустить вход, который гейт
// обязан был отбить):
//  - открытые позиции считаются в бюджет наравне с закрытыми
//  - бюджет запирается ПО достижении лимита, не после его превышения
//  - пауза считается от закрытия ЛЮБОЙ сделки, включая прибыльную
//  - выключенная пауза (0 минут) не блокирует ничего
//  - истёкшая пауза не тянется на секунду дольше срока

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeTradesToday, computeCooldown } from '../src/modules/tradeGuards.js';

const MIN = 60_000;

test('открытые позиции входят в дневной бюджет', () => {
  // Иначе можно набрать пять открытых поз и увидеть «0 / 5»: ни одна ещё не
  // закрылась, а лимит уже выбран.
  const r = computeTradesToday({ closed: 3, open: 2, cap: 5 });
  assert.equal(r.today, 5);
  assert.equal(r.over, true);
});

test('бюджет запирается ПО достижении лимита, а не после превышения', () => {
  // Граница именно здесь: at cap вход уже запрещён. 31.08 счётчик пустил
  // сделки с шестой по семнадцатую, показывая «over the daily trade budget».
  assert.equal(computeTradesToday({ closed: 4, open: 0, cap: 5 }).over, false);
  assert.equal(computeTradesToday({ closed: 5, open: 0, cap: 5 }).over, true);
  assert.equal(computeTradesToday({ closed: 9, open: 0, cap: 5 }).over, true);
});

test('пауза блокирует перезаход и считает остаток', () => {
  const now = 1_000 * MIN;
  const r = computeCooldown({ lastCloseAt: now - 4 * MIN, lastPnl: -1.1, minutes: 15, now });
  assert.equal(r.blocked, true);
  assert.equal(r.secondsLeft, 11 * 60);
  assert.equal(r.lastPnl, -1.1);
});

test('пауза действует и после ПРИБЫЛЬНОЙ сделки', () => {
  // «Можно сразу перезайти, если предыдущая была в плюс» — это правило,
  // которое учит добирать, пока не отдашь обратно. Паузу платят все.
  const now = 1_000 * MIN;
  const r = computeCooldown({ lastCloseAt: now - MIN, lastPnl: 1.21, minutes: 15, now });
  assert.equal(r.blocked, true);
  assert.equal(r.lastPnl, 1.21);
});

test('истёкшая пауза не блокирует', () => {
  const now = 1_000 * MIN;
  assert.equal(computeCooldown({ lastCloseAt: now - 15 * MIN, minutes: 15, now }).blocked, false);
  assert.equal(computeCooldown({ lastCloseAt: now - 99 * MIN, minutes: 15, now }).blocked, false);
});

test('нулевая пауза и отсутствие сделок по монете не блокируют', () => {
  const now = 1_000 * MIN;
  assert.equal(computeCooldown({ lastCloseAt: now - MIN, minutes: 0, now }).blocked, false);
  assert.equal(computeCooldown({ lastCloseAt: null, minutes: 15, now }).blocked, false);
});
