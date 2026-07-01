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

// ── Регресс: усечение окна fills (баг HYPE 2026-07-01) ──────────────────────
// Позиция открылась ДО начала окна fills, закрылась внутри → окно начинается с
// Close, replay стартует с ложного net=0 → постоянное смещение, которое никогда
// не обнуляется. Без якоря к бирже флэт читается как открытая поза (ложное
// «too old» → поза без стопа). currentNet (истина с биржи) чинит.
test('усечённое окно: Open обрезан, оператор флэт → null (был ложный age)', () => {
  const fills = [
    // Open Short (−1.17) обрезан окном. Первый видимый fill — его закрытие:
    makeFill({ time: 1 * DAY, dir: 'Close Short', sz: 1.17 }), // replay net → +1.17
    makeFill({ time: 2 * DAY, dir: 'Open Long',   sz: 2 }),    // replay net → +3.17
    makeFill({ time: 3 * DAY, dir: 'Close Long',  sz: 2 }),    // replay net → +1.17 (реально флэт)
  ];
  // Без якоря (legacy) — баг: смещение +1.17 → «открытая поза».
  assert.notEqual(resolveManualOpenTime({ coin: 'XPL', fills }), null,
    'демонстрация бага: без currentNet смещение читается как открытая поза');
  // С якорем currentNet=0 (биржа: флэт) → корректно null.
  assert.equal(resolveManualOpenTime({ coin: 'XPL', fills, currentNet: 0 }), null,
    'якорь к бирже (флэт) убирает ложный возраст');
});

test('усечённое окно: реально открытая поза → время текущего входа', () => {
  const fills = [
    makeFill({ time: 1 * DAY, dir: 'Close Short', sz: 1.17 }), // занос из-за окна
    makeFill({ time: 2 * DAY, dir: 'Open Long',   sz: 2 }),
    makeFill({ time: 3 * DAY, dir: 'Close Long',  sz: 2 }),    // флэт
    makeFill({ time: 4 * DAY, dir: 'Open Short',  sz: 3 }),    // текущий вход
  ];
  // Биржа: net = −3 (short 3). Якорь датирует открытие текущей ноги.
  assert.equal(resolveManualOpenTime({ coin: 'XPL', fills, currentNet: -3 }), 4 * DAY,
    'открытие текущей позы, а не занесённое смещение');
});
