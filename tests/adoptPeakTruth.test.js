// Пик по свечам биржи — источник, который видит проколы между WS-кадрами.
// Регрессия, ради которой всё затевалось, — последний тест файла (HEMI 03.09).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  peakPctFromCandles,
  lastClosedClose,
  lookbackMinutesFor,
  MAX_LOOKBACK_MIN,
} from '../src/modules/adoptPeakTruth.js';

const MIN = 60_000;
const c = (time, high, low, close = low) => ({ time, high, low, open: high, close });

test('нет свечей / мусорный вход → null, а не ноль', () => {
  assert.equal(peakPctFromCandles({ candles: null, entry: 100, entryTime: 0, isShort: true }), null);
  assert.equal(peakPctFromCandles({ candles: [], entry: 100, entryTime: 0, isShort: true }), null);
  assert.equal(
    peakPctFromCandles({ candles: [c(0, 101, 99)], entry: 0, entryTime: 0, isShort: true }),
    null,
  );
});

test('SHORT: пик считается по самому низкому low', () => {
  const pct = peakPctFromCandles({
    candles: [c(0, 101, 99), c(MIN, 100, 95), c(2 * MIN, 99, 97)],
    entry: 100,
    entryTime: 0,
    isShort: true,
  });
  assert.equal(pct, 5); // 100 → 95
});

test('LONG: пик считается по самому высокому high', () => {
  const pct = peakPctFromCandles({
    candles: [c(0, 101, 99), c(MIN, 108, 100), c(2 * MIN, 103, 101)],
    entry: 100,
    entryTime: 0,
    isShort: false,
  });
  assert.equal(pct, 8);
});

test('свечи целиком до входа не считаются', () => {
  const pct = peakPctFromCandles({
    // Первая свеча закрылась ДО входа: её low 90 не мой.
    candles: [c(0, 101, 90), c(5 * MIN, 100, 98)],
    entry: 100,
    entryTime: 5 * MIN,
    isShort: true,
  });
  assert.equal(pct, 2); // 100 → 98, а не 10
});

test('свеча входа берётся целиком — импульс чаще всего в ней', () => {
  const pct = peakPctFromCandles({
    // Вход на 30-й секунде свечи, открывшейся в 0.
    candles: [c(0, 101, 97)],
    entry: 100,
    entryTime: 30_000,
    isShort: true,
  });
  assert.equal(pct, 3);
});

test('ход только против позиции → пик 0, не отрицательный', () => {
  const pct = peakPctFromCandles({
    candles: [c(0, 105, 102)],
    entry: 100,
    entryTime: 0,
    isShort: true,
  });
  assert.equal(pct, 0);
});

test('битые свечи пропускаются, а не роняют счёт', () => {
  const pct = peakPctFromCandles({
    candles: [
      { time: 0, high: NaN, low: NaN },
      { time: MIN, high: 100, low: 0 },
      c(2 * MIN, 100, 96),
    ],
    entry: 100,
    entryTime: 0,
    isShort: true,
  });
  assert.equal(pct, 4);
});

test('lookback: от возраста позы, но не длиннее ретеншена 1m у HL', () => {
  const now = 3 * 24 * 60 * MIN; // трое суток от эпохи
  assert.equal(lookbackMinutesFor(now - 3 * MIN, now), 5); // пол минимума → минимум 5
  assert.equal(lookbackMinutesFor(now - 30 * MIN, now), 32); // +2 на незакрытую свечу
  assert.equal(lookbackMinutesFor(0, now), MAX_LOOKBACK_MIN); // старая поза → потолок
});

test('регрессия HEMI 03.09: прокол между WS-кадрами попадает в пик', () => {
  // Факты сделки: SHORT, вход 0.016233, стоп 0.016638825 (риск 2.5%).
  // Тиковый пик показывал 2.06% (0.83R) — ниже порога взвода 0.9R.
  // Цена при этом сходила на 0.015726 (там исполнилась лимитка) = 3.12% = 1.25R.
  const entry = 0.016233;
  const stop = 0.016638825;
  const riskPct = ((stop - entry) / entry) * 100;

  const pct = peakPctFromCandles({
    candles: [c(0, 0.016300, 0.015898), c(MIN, 0.016100, 0.015726)],
    entry,
    entryTime: 0,
    isShort: true,
  });

  const peakR = pct / riskPct;
  assert.ok(pct > 3.1 && pct < 3.2, `ожидал ~3.12%, получил ${pct}`);
  assert.ok(peakR >= 0.9, `трейл обязан взводиться: ${peakR.toFixed(2)}R < 0.9R`);
});

// ── Закрытие последнего бара: цена, на которой принимается решение о выходе ──

test('берётся close последнего ЗАКРЫТОГО бара, незакрытый игнорируется', () => {
  const now = 3 * MIN + 30_000; // идёт бар, открывшийся в 3*MIN
  const got = lastClosedClose(
    [c(MIN, 105, 100, 101), c(2 * MIN, 106, 101, 104), c(3 * MIN, 120, 103, 119)],
    now,
  );
  assert.deepEqual(got, { px: 104, time: 2 * MIN });
});

test('все бары ещё идут / мусор → null', () => {
  assert.equal(lastClosedClose([c(0, 105, 100, 103)], 30_000), null);
  assert.equal(lastClosedClose(null, 0), null);
  assert.equal(lastClosedClose([{ time: 0, close: 0 }], 10 * MIN), null);
});

test('порядок баров не важен — берётся самый поздний закрытый', () => {
  const now = 10 * MIN;
  const got = lastClosedClose([c(5 * MIN, 1, 1, 55), c(MIN, 1, 1, 11), c(3 * MIN, 1, 1, 33)], now);
  assert.equal(got.px, 55);
});

test('фитиль в пике есть, а в решении о выходе — нет', () => {
  // Бар с глубоким фитилём вниз (SHORT): пик его видит, close — нет.
  const bar = c(0, 101, 90, 99); // low 90, close 99
  const now = 2 * MIN;
  assert.equal(peakPctFromCandles({ candles: [bar], entry: 100, entryTime: 0, isShort: true }), 10);
  assert.equal(lastClosedClose([bar], now).px, 99); // решение — по 99, не по 90
});
