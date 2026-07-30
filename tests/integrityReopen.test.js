// classifyEntryDrift: «та же поза / скейл-ин / перезаход».
// Регресс на KAITO 30.07: оператор закрыл шорт 28 @1.0637 (+$1.76) и через 41с
// перезашёл шортом 29 @1.0371. liveMatchesPosition (монета+сторона) считала позу
// живой, DB-строка жила со СТАРЫМ entry $1.1264 → трейл увидел фейковый пик
// +8.8% и записал в history +$1.94 вместо реальных −$0.58.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { classifyEntryDrift } = await import('../src/app/integrity.js');

const T0 = 1_785_000_000_000;   // entry_time DB-строки

test('цена входа совпала → та же поза (fills не нужны)', () => {
  assert.equal(
    classifyEntryDrift({ dbEntryPrice: 1.1264, exEntryPx: 1.1264, dbEntryTime: T0, openTime: null }),
    'same',
  );
});

test('дрейф внутри допуска (0.1%) → та же поза', () => {
  assert.equal(
    classifyEntryDrift({ dbEntryPrice: 1.1264, exEntryPx: 1.1275, dbEntryTime: T0, openTime: T0 }),
    'same',
  );
});

test('KAITO 30.07: вход уехал 1.1264→1.0371, поза открыта позже → перезаход', () => {
  assert.equal(
    classifyEntryDrift({
      dbEntryPrice: 1.1264, exEntryPx: 1.0371,
      dbEntryTime: T0, openTime: T0 + 41 * 60_000,
    }),
    'reopen',
  );
});

test('скейл-ин: средняя цена уехала, но время открытия то же → не трогаем', () => {
  assert.equal(
    classifyEntryDrift({
      dbEntryPrice: 1.1264, exEntryPx: 1.1000,
      dbEntryTime: T0, openTime: T0,
    }),
    'scale-in',
  );
});

test('лаг индексации: openTime на 3с позже entry_time → это та же поза, не перезаход', () => {
  assert.equal(
    classifyEntryDrift({
      dbEntryPrice: 1.1264, exEntryPx: 1.1000,
      dbEntryTime: T0, openTime: T0 + 3_000,
    }),
    'scale-in',
  );
});

test('openTime неизвестен (поза старше окна fills) → unknown, строку не рвём', () => {
  assert.equal(
    classifyEntryDrift({
      dbEntryPrice: 1.1264, exEntryPx: 1.0371, dbEntryTime: T0, openTime: null,
    }),
    'unknown',
  );
});

test('нулевые/мусорные цены → unknown', () => {
  assert.equal(
    classifyEntryDrift({ dbEntryPrice: 0, exEntryPx: 1.03, dbEntryTime: T0, openTime: T0 }),
    'unknown',
  );
  assert.equal(
    classifyEntryDrift({ dbEntryPrice: 1.03, exEntryPx: NaN, dbEntryTime: T0, openTime: T0 }),
    'unknown',
  );
});
