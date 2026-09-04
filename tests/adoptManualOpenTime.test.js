// resolveManualOpenTime: время открытия текущей позы по монете из сырых HL fills
// (правда с биржи = знаковая сумма ВСЕХ fills, без реконструкции ручной истории).
//
// Регресс на adopt брал возраст из reconstructManualTrades,
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

// ── Регресс: усечение окна fills ──────────────────────
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

// ── Регресс: индексатор HL не успел за открытием ─────────────
// Юзер открыл шорт в 12:50:15, бот усыновил позу через 13 секунд — и записал
// entry_time = 11:45:14, время закрытия ПРЕДЫДУЩЕЙ (лонговой) позы. Карточка
// показала возраст 1:10 вместо шести минут.
//
// Механика: fills индексируются с лагом 10-30с, и открывающего fill'а в ленте
// ещё не было. Тогда replay заканчивается на флэте (net=0), а биржа говорит
// −105.8 → offset = 105.8. Этот сдвиг задуман для ДРУГОГО случая (поза открылась
// раньше окна fills), но здесь он смещает ВСЮ траекторию: каждый реальный проход
// через ноль начинает читаться как смена знака, и openTime уползает на последний
// из них.
//
// Цена ошибки выросла 03.09: от entry_time считается пик по свечам, а за пиком
// теперь ползёт биржевой стоп. Пик, посчитанный от чужой позиции, двигает
// реальный ордер на живом счету.
test('открывающий fill ещё не проиндексирован → возраст неизвестен, а не выдуман', () => {
  const T = (h, m, s) => Date.UTC(2026, 8, 3, h, m, s);
  const arb = (time, dir, sz) => makeFill({ coin: 'ARB', time, dir, sz });

  // Лента до сегодняшнего шорта: три полных round-trip'а, все схлопнулись в ноль.
  const indexed = [
    arb(T(0, 17, 18), 'Open Short', 175.5),
    arb(T(4, 10, 13), 'Close Short', 175.5),
    arb(T(8, 43, 35), 'Open Long', 215.9),
    arb(T(9, 58, 21), 'Close Long', 146.2),
    arb(T(9, 58, 21), 'Close Long', 69.7),
    arb(T(10, 50, 49), 'Open Long', 124.8),
    arb(T(11, 45, 14), 'Close Long', 124.8),
  ];

  // Биржа уже показывает шорт, ленте о нём ещё не сообщили.
  const stale = resolveManualOpenTime({ coin: 'ARB', fills: indexed, currentNet: -105.8 });
  assert.equal(
    stale, null,
    'ленты не хватает — обязаны честно сказать «не знаю», а не назвать чужое время',
  );

  // Тот же расчёт, когда fill долетел: время открытия ровно наше.
  const fresh = resolveManualOpenTime({
    coin: 'ARB',
    fills: [...indexed, arb(T(12, 50, 15), 'Open Short', 105.8)],
    currentNet: -105.8,
  });
  assert.equal(fresh, T(12, 50, 15));
});

test('поза открыта раньше окна fills — offset по-прежнему чинит усечение', () => {
  // Ради этого случая offset и заводили: первый fill в окне —
  // Close, открытия не видно. Лента НЕ заканчивается флэтом, поэтому правило
  // «нет открытия в ленте» её не задевает.
  const T = (h) => Date.UTC(2026, 8, 3, h, 0, 0);
  const fills = [
    makeFill({ coin: 'HYPE', time: T(1), dir: 'Close Short', sz: 5 }),
    makeFill({ coin: 'HYPE', time: T(2), dir: 'Open Short', sz: 3 }),
  ];
  const got = resolveManualOpenTime({ coin: 'HYPE', fills, currentNet: -3 });
  assert.equal(got, T(2), 'усечение окна лечится якорем, как и раньше');
});
