// ─────────────────────────────────────────────────
//  Живые FVG-сетапы: та же геометрия, что у правила форварда
// ─────────────────────────────────────────────────
// Главный тест здесь — сверка с findTrades. Будильник и форвард считают одну
// гипотезу двумя разными кусками кода; разойдись они в уровнях, пуш позовёт на
// сетап, которого в журнале нет, и заметить это будет нечем.
//
// Остальное закрывает границы: узкая зона, несвежее касание, тренд против зоны.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLiveSetups } from '../tools/fvgZones.mjs';
import { findTrades, PARAMS } from '../tools/fvgRule.mjs';

const M15 = 15 * 60_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');   // кратно 4ч → группы ровно по 16 баров

/** HTF-бар → 16 баров 15m, агрегат которых даёт ровно (o,h,l,c). */
function expand(bar, startIdx) {
  const out = [];
  for (let k = 0; k < 16; k++) {
    const t = T0 + (startIdx + k) * M15;
    if (k === 1) out.push({ t, o: bar.o, h: bar.h, l: bar.o, c: bar.o });
    else if (k === 2) out.push({ t, o: bar.o, h: bar.o, l: bar.l, c: bar.o });
    else if (k === 15) out.push({ t, o: bar.o, h: bar.o, l: bar.o, c: bar.c });
    else out.push({ t, o: bar.o, h: bar.o, l: bar.o, c: bar.o });
  }
  return out;
}

/**
 * Серия с бычьей FVG на баре Z в растущем тренде и ретестом на Z+1.
 * gap — во сколько раз низ бара Z выше хая бара Z-2 (ширина зоны).
 */
function buildSeries({ gap = 1.03, htfCount = 90, Z = 85, retest = true, rally = true } = {}) {
  const htf = [];
  for (let i = 0; i < htfCount; i++) {
    const c = 100 * 1.005 ** i;                  // ровный рост: EMA20 > EMA50
    htf.push({ o: c * 0.999, h: c * 1.001, l: c * 0.998, c });
  }
  const zBot = htf[Z - 2].h;
  const zTop = zBot * gap;
  const width = zTop - zBot;
  const fillPx = zTop - PARAMS.pen * width;
  // Бар Z: разрыв вверх, его low и есть верх зоны.
  htf[Z] = { o: zTop * 1.001, h: zTop * 1.006, l: zTop, c: zTop * 1.004 };
  if (retest) {
    // Бар Z+1: прокол в зону до цены входа.
    htf[Z + 1] = { o: zTop * 1.002, h: zTop * 1.003, l: fillPx * 0.9999, c: zTop * 1.002 };
  }
  if (rally) {
    // Дальше ход вверх: сделка обязана закрыться, иначе findTrades её не отдаст.
    for (let i = Z + 2; i < htfCount; i++) {
      htf[i] = { o: zTop * 1.01, h: zBot * 1.12, l: zTop * 1.005, c: zBot * 1.1 };
    }
  }
  const bars = [];
  htf.forEach((b, i) => bars.push(...expand(b, i * 16)));
  // Индекс 15m бара, несущего прокол: третий в группе Z+1.
  return { bars, touchIdx: (Z + 1) * 16 + 2, zBot, zTop, fillPx };
}

test('живой сетап отдаёт те же вход и стоп, что находит правило форварда', () => {
  const { bars, touchIdx } = buildSeries();

  // Будильник смотрит серию, обрезанную ровно на баре прокола: это момент,
  // когда он и должен сработать — исход ещё не известен.
  const live = findLiveSetups('TEST', bars.slice(0, touchIdx + 1), { freshBars: 1 });
  assert.equal(live.length, 1, 'ожидали ровно один живой сетап');

  // Правило форварда видит всю серию и отдаёт закрытую сделку.
  const trades = findTrades('TEST', bars);
  assert.equal(trades.length, 1, 'ожидали ровно одну сделку правила');

  assert.equal(live[0].side, trades[0].side);
  assert.equal(live[0].entry, trades[0].entry, 'вход обязан совпадать до числа');
  assert.equal(live[0].stop, trades[0].stop, 'стоп обязан совпадать до числа');
  assert.equal(live[0].tgt, trades[0].tgt, 'цель обязана совпадать до числа');
  assert.equal(live[0].hitT, trades[0].entryT, 'момент входа тот же бар');
});

test('цель стоит на заявленных 2R от входа', () => {
  const { bars, touchIdx } = buildSeries();
  const [s] = findLiveSetups('TEST', bars.slice(0, touchIdx + 1), { freshBars: 1 });
  const risk = s.entry - s.stop;
  assert.ok(risk > 0);
  assert.ok(Math.abs(s.tgt - (s.entry + PARAMS.rr * risk)) < 1e-9);
});

test('узкая зона не проходит порог ширины', () => {
  // gap 1.005 = зона 0.5% при пороге minw 1.6%.
  const { bars, touchIdx } = buildSeries({ gap: 1.005 });
  assert.deepEqual(findLiveSetups('TEST', bars.slice(0, touchIdx + 1), { freshBars: 1 }), []);
});

test('касание не на последних барах не будит', () => {
  // Полная серия: прокол был давно, дальше рынок ушёл.
  const { bars } = buildSeries();
  assert.deepEqual(findLiveSetups('TEST', bars, { freshBars: 1 }), []);
});

test('без ретеста сетапа нет — зона есть, входа не было', () => {
  const { bars, touchIdx } = buildSeries({ retest: false });
  assert.deepEqual(findLiveSetups('TEST', bars.slice(0, touchIdx + 1), { freshBars: 1 }), []);
});

test('ширина зоны и дистанция стопа — разные числа', () => {
  // Стоп стоит на дальнем крае зоны, вход — внутри неё, поэтому дистанция
  // стопа всегда МЕНЬШЕ ширины зоны. Путать их = мерить не тот фильтр.
  const { bars, touchIdx } = buildSeries();
  const [s] = findLiveSetups('TEST', bars.slice(0, touchIdx + 1), { freshBars: 1 });
  assert.ok(s.zoneWidthPct >= PARAMS.minw);
  assert.ok(s.stopDistPct < s.zoneWidthPct);
});
