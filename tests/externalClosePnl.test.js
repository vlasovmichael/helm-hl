// Контракт внешнего закрытия: что executor/close.js обязан взять из fills.
//
// Регресс на баг kSHIB 2026-07-26. Юзер закрыл позу руками в 09:40:01, бот
// заметил это в 09:40:30, когда пошёл закрывать по трейлу. В history попал
// МОМЕНТ ДЕТЕКТА вместо времени сделки → дедуп ленты (makeHistoryCoverage,
// допуск 5с) промахнулся на 29с → одна сделка показалась дважды: `close` из
// history + `manual_close` из fills-реконструкции.
//
// Заодно тем же вызовом чинились ещё два поля: fee_paid писался нулём, а
// realized_pnl — gross'ом, хотя контракт БД = net (см. classifyClose jsdoc).
// Соседний путь sync.js (оффлайн-закрытие) всё это делал правильно — здесь
// проверяем, что источник данных отдаёт всё необходимое, и что дедуп ленты
// сходится, когда closed_at взят из fills.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { classifyClose } = await import('../src/modules/userFills.js');
const { makeHistoryCoverage } = await import('../src/modules/dashboard/server.js');

const makeFill = ({ coin = 'X', px = 100, sz = 1, time, dir, oid = null, closedPnl = 0, fee = 0 }) =>
  ({ coin, px, sz, time, dir, oid, closedPnl, fee });

// Живой кейс kSHIB: вход 09:15:38, ручное закрытие 09:40:01, детект 09:40:30.
const FILL_CLOSE_TS = 1_785_058_801_000;
const DETECT_TS = FILL_CLOSE_TS + 29_000;
const kshibFills = [
  makeFill({ coin: 'kSHIB', time: FILL_CLOSE_TS - 1_463_000, dir: 'Open Short', px: 0.005533, sz: 5903, fee: 0.020641 }),
  makeFill({ coin: 'kSHIB', time: FILL_CLOSE_TS, dir: 'Close Short', px: 0.005401, sz: 5903, closedPnl: 0.779196, fee: 0.020149 }),
];
const kshibPos = { coin: 'kSHIB', side: 'short', entry_time: FILL_CLOSE_TS - 1_463_000 };

test('classifyClose отдаёт closedAt = время close-fill, а не момент детекта', () => {
  const c = classifyClose(kshibPos, kshibFills);
  assert.equal(c.reason, 'manual_close');
  assert.equal(c.closedAt, FILL_CLOSE_TS, 'closed_at обязан приходить из fills');
  assert.notEqual(c.closedAt, DETECT_TS);
});

test('classifyClose отдаёт fee close-ног, а net = pnl − fee (контракт realized_pnl)', () => {
  const c = classifyClose(kshibPos, kshibFills);
  assert.ok(Math.abs(c.pnl - 0.779196) < 1e-9, 'pnl = price PnL ДО комиссий');
  assert.ok(Math.abs(c.fee - 0.020149) < 1e-9, 'fee = Σ комиссий close-fills');
  const net = c.pnl - c.fee;
  assert.ok(Math.abs(net - 0.759047) < 1e-9, `net = ${net}, ожидалось 0.759047`);
  assert.ok(net < c.pnl, 'net обязан быть меньше gross — иначе комиссия потеряна');
});

test('дедуп ленты сходится, когда closed_at взят из fills (и промахивается на детекте)', () => {
  // Так лента видит сделку из fills-реконструкции — всегда по времени fill.
  const fromFills = FILL_CLOSE_TS;

  // ✅ Починенный путь: history.closed_at = время fill → дубля нет.
  const fixed = makeHistoryCoverage([{ coin: 'kSHIB', closed_at: FILL_CLOSE_TS }], null);
  assert.equal(fixed.closedCovered('kSHIB', fromFills), true, 'сделка покрыта историей — второй раз не показываем');

  // ❌ Старый путь: history.closed_at = момент детекта (+29с) → дедуп мимо.
  const broken = makeHistoryCoverage([{ coin: 'kSHIB', closed_at: DETECT_TS }], null);
  assert.equal(broken.closedCovered('kSHIB', fromFills), false, 'воспроизводит баг: 29с > допуска 5с');
});

test('classifyClose: split-закрытие → closedAt по последней ноге, fee суммируется', () => {
  const t0 = 1_700_000_000_000;
  const pos = { coin: 'ETH', side: 'short', entry_time: t0 };
  const fills = [
    makeFill({ coin: 'ETH', time: t0, dir: 'Open Short', px: 2000, sz: 2 }),
    makeFill({ coin: 'ETH', time: t0 + 1000, dir: 'Close Short', px: 1990, sz: 1, closedPnl: 10, fee: 0.5 }),
    makeFill({ coin: 'ETH', time: t0 + 4000, dir: 'Close Short', px: 1980, sz: 1, closedPnl: 20, fee: 0.6 }),
  ];
  const c = classifyClose(pos, fills);
  assert.equal(c.closedAt, t0 + 4000, 'время последней закрывающей ноги');
  assert.ok(Math.abs(c.pnl - 30) < 1e-9);
  assert.ok(Math.abs(c.fee - 1.1) < 1e-9);
  assert.ok(Math.abs(c.closePx - 1985) < 1e-9, 'средневзвешенная цена закрытия');
});
