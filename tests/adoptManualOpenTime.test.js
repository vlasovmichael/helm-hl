// resolveManualOpenTime: время открытия текущей позы по монете из сырых HL fills
// (правда с биржи = знаковая сумма ВСЕХ fills, без реконструкции ручной истории).
//
// Регресс на XPL incident 2026-06-17: adopt брал возраст из reconstructManualTrades,
// которая выкидывает бот-fills по oid → net-размер не обнулялся на бот-закрытии
// усыновлённой позы → «открытая нога» копила древний entryTime → свежий ручной
// re-open считался возрастом в днях → adopt отказывал по too-old → поза без стопа
// → −$7.36. Net-position по всем fills делает фантом невозможным.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADING_MODE          = 'PAPER';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { resolveManualOpenTime } = await import('../src/app/adoptReconcile.js');

function makeFill({ coin = 'XPL', px = 0.11, sz = 1, time, dir }) {
  return { coin, px, sz, time, dir };
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test('re-open после bot-close той же монеты: берётся время свежего входа, не древний', () => {
  const T_OLD    = 0;                 // ручной вход (потом усыновлён + бот-закрыт)
  const T_CLOSE  = 5 * DAY;           // бот закрыл усыновлённую позу (adopt_trail_tp)
  const T_REOPEN = 5 * DAY + 35_000;  // ручной re-open через 35с

  const fills = [
    makeFill({ time: T_OLD,    dir: 'Open Short',  sz: 700 }),
    makeFill({ time: T_CLOSE,  dir: 'Close Short', sz: 700 }), // бот-закрытие — net→0
    makeFill({ time: T_REOPEN, dir: 'Open Short',  sz: 777 }),
  ];
  const openTime = resolveManualOpenTime({ coin: 'XPL', fills });
  assert.equal(openTime, T_REOPEN, 'должно вернуть время свежего входа (net обнулился на бот-close)');
});

test('частичные закрытия не обнуляют net раньше времени', () => {
  const T0 = 10 * MIN;
  const fills = [
    makeFill({ time: T0,           dir: 'Open Short',  sz: 700 }),
    makeFill({ time: T0 + 1 * MIN, dir: 'Close Short', sz: 200 }), // net −500, поза жива
    makeFill({ time: T0 + 2 * MIN, dir: 'Open Short',  sz: 100 }), // усреднение, net −600
  ];
  const openTime = resolveManualOpenTime({ coin: 'XPL', fills });
  assert.equal(openTime, T0, 'entryTime = первый Open, частичный close не сбрасывает');
});

test('разворот long→short датирует открытие новой стороны', () => {
  const T0 = 0;
  const fills = [
    makeFill({ time: T0,           dir: 'Open Long',  sz: 100 }), // net +100
    makeFill({ time: T0 + 5 * MIN, dir: 'Close Long', sz: 100 }), // net 0
    makeFill({ time: T0 + 6 * MIN, dir: 'Open Short', sz: 50 }),  // net −50
  ];
  const openTime = resolveManualOpenTime({ coin: 'XPL', fills });
  assert.equal(openTime, T0 + 6 * MIN, 'после разворота — время открытия short-ноги');
});

test('позиция полностью закрыта → null', () => {
  const fills = [
    makeFill({ time: 0,      dir: 'Open Short',  sz: 100 }),
    makeFill({ time: 1 * MIN, dir: 'Close Short', sz: 100 }),
  ];
  assert.equal(resolveManualOpenTime({ coin: 'XPL', fills }), null);
});

test('нет fills по монете → null', () => {
  assert.equal(resolveManualOpenTime({ coin: 'XPL', fills: [] }), null);
  assert.equal(resolveManualOpenTime({ coin: 'XPL', fills: [makeFill({ coin: 'ETH', time: 0, dir: 'Open Long', sz: 1 })] }), null);
});

test('обычная свежая ручная поза: возвращает её время', () => {
  const fills = [makeFill({ time: 10 * MIN, dir: 'Open Short', sz: 700 })];
  assert.equal(resolveManualOpenTime({ coin: 'XPL', fills }), 10 * MIN);
});
