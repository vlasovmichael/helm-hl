// TP-сетка: разбор спецификации и раскладка ступеней по цене/размеру.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTpGrid,
  buildTpGrid,
  gridRemainder,
  gridMinNotionalUsd,
} from '../src/modules/tpGrid.js';

// ── parseTpGrid ─────────────────────────────────────────────────────────────

test('пустая спецификация = выключено, без ошибки', () => {
  assert.deepEqual(parseTpGrid(''), { legs: [] });
  assert.deepEqual(parseTpGrid(undefined), { legs: [] });
  assert.deepEqual(parseTpGrid('   '), { legs: [] });
});

test('разбирает ступени и сортирует по возрастанию R', () => {
  const { legs } = parseTpGrid('0.3@1.5, 0.5@1.0');
  assert.deepEqual(legs, [{ frac: 0.5, r: 1 }, { frac: 0.3, r: 1.5 }]);
});

test('сумма долей ≥ 1 отвергается — под остаток ничего не остаётся', () => {
  assert.match(parseTpGrid('0.5@1, 0.5@2').error, /сумма долей/);
  assert.match(parseTpGrid('0.9@1, 0.2@2').error, /сумма долей/);
});

test('кривой формат и границы долей отвергаются, а не чинятся молча', () => {
  assert.match(parseTpGrid('половину@1').error, /не в формате/);
  assert.match(parseTpGrid('0.5-1.0').error, /не в формате/);
  assert.match(parseTpGrid('1.0@1').error, /должна быть в \(0, 1\)/);
  assert.match(parseTpGrid('0@1').error, /должна быть в \(0, 1\)/);
  assert.match(parseTpGrid('0.5@0').error, /ход.*> 0/);
});

// ── buildTpGrid ─────────────────────────────────────────────────────────────

const legs = [{ frac: 0.5, r: 1 }, { frac: 0.25, r: 2 }];

test('SHORT: ступени ниже входа, LONG: выше', () => {
  const short = buildTpGrid({
    legs, entry: 100, stopDistPct: 2, isShort: true, sizeSz: 1000,
  });
  assert.deepEqual(short.map((g) => g.px), [98, 96]); // 1R = 2%, 2R = 4%
  assert.deepEqual(short.map((g) => g.sz), [500, 250]);

  const long = buildTpGrid({
    legs, entry: 100, stopDistPct: 2, isShort: false, sizeSz: 1000,
  });
  assert.deepEqual(long.map((g) => g.px), [102, 104]);
});

test('остаток под цель/трейл = позиция минус ступени', () => {
  const grid = buildTpGrid({ legs, entry: 100, stopDistPct: 2, isShort: true, sizeSz: 1000 });
  assert.equal(gridRemainder(1000, grid), 250);
});

test('ступень мельче минимального ордера пропускается целиком', () => {
  // Позиция $20 при минимуме $11: ступень 0.5 = $10 — не проходит.
  const grid = buildTpGrid({
    legs: [{ frac: 0.5, r: 1 }],
    entry: 1, stopDistPct: 2, isShort: true, sizeSz: 20, minSz: 11,
  });
  assert.deepEqual(grid, []);
  assert.equal(gridRemainder(20, grid), 20); // всё уходит на обычную цель
});

test('округление размера не даёт ступеням съесть всю позицию', () => {
  // roundSz вверх до целого + доли почти на всю позу → последняя ступень отсечена.
  const grid = buildTpGrid({
    legs: [{ frac: 0.6, r: 1 }, { frac: 0.39, r: 2 }],
    entry: 100, stopDistPct: 2, isShort: true, sizeSz: 10,
    roundSz: (n) => Math.ceil(n),
  });
  assert.equal(gridRemainder(10, grid) > 0, true, 'остаток обязан быть > 0');
});

test('мусорный вход → пустая сетка, а не исключение', () => {
  assert.deepEqual(buildTpGrid({ legs: [], entry: 100, stopDistPct: 2, isShort: true, sizeSz: 10 }), []);
  assert.deepEqual(buildTpGrid({ legs, entry: 0, stopDistPct: 2, isShort: true, sizeSz: 10 }), []);
  assert.deepEqual(buildTpGrid({ legs, entry: 100, stopDistPct: 0, isShort: true, sizeSz: 10 }), []);
  assert.deepEqual(buildTpGrid({ legs, entry: 100, stopDistPct: 2, isShort: true, sizeSz: 0 }), []);
});

// ── проценты вместо R ───────────────────────────────────────────────────────

test('доля@N% разбирается как ход в процентах от входа', () => {
  assert.deepEqual(parseTpGrid('0.5@1%').legs, [{ frac: 0.5, pct: 1 }]);
  assert.deepEqual(parseTpGrid('0.25@1.5%').legs, [{ frac: 0.25, pct: 1.5 }]);
});

test('смешивать R и проценты в одной спеке нельзя', () => {
  assert.match(parseTpGrid('0.3@1, 0.3@1%').error, /либо все ступени в R, либо все в процентах/);
  assert.match(parseTpGrid('0.3@1%, 0.3@2').error, /либо все ступени в R, либо все в процентах/);
});

test('процентные ступени сортируются по ходу, как и R', () => {
  assert.deepEqual(parseTpGrid('0.2@2%, 0.3@0.5%').legs, [{ frac: 0.3, pct: 0.5 }, { frac: 0.2, pct: 2 }]);
});

test('процентная ступень не зависит от дистанции стопа — в этом весь смысл', () => {
  const legs = parseTpGrid('0.5@1%').legs;
  for (const stopDistPct of [2, 4, 8]) {
    const [rung] = buildTpGrid({ legs, entry: 100, stopDistPct, isShort: false, sizeSz: 1000 });
    assert.equal(rung.px, 101, `стоп ${stopDistPct}% не должен двигать ступень`);
  }
  // Та же доля в R едет вслед за стопом — контраст к процентам.
  const rLegs = parseTpGrid('0.5@0.5').legs;
  const a = buildTpGrid({ legs: rLegs, entry: 100, stopDistPct: 2, isShort: false, sizeSz: 1000 })[0];
  const b = buildTpGrid({ legs: rLegs, entry: 100, stopDistPct: 8, isShort: false, sizeSz: 1000 })[0];
  assert.equal(a.px, 101);
  assert.equal(b.px, 104);
});

test('подпись ступени различает проценты и R — по ней идёт дедупликация', () => {
  const pct = buildTpGrid({
    legs: parseTpGrid('0.3@1%, 0.3@2%').legs,
    entry: 100, stopDistPct: 2, isShort: false, sizeSz: 1000,
  });
  assert.deepEqual(pct.map((g) => g.label), ['1%', '2%']);
  assert.deepEqual(pct.map((g) => g.r), [null, null]);

  const r = buildTpGrid({
    legs: parseTpGrid('0.3@1, 0.3@1.5').legs,
    entry: 100, stopDistPct: 2, isShort: false, sizeSz: 1000,
  });
  assert.deepEqual(r.map((g) => g.label), ['1R', '1.5R']);
  assert.deepEqual(r.map((g) => g.pct), [null, null]);
});

test('сообщение о кривом формате называет оба варианта', () => {
  assert.match(parseTpGrid('0.5').error, /доля@R или доля@N%/);
  assert.match(parseTpGrid('0.5@%').error, /доля@R или доля@N%/);
  assert.match(parseTpGrid('0.5@0%').error, /ход.*> 0/);
});

// ── gridMinNotionalUsd ──────────────────────────────────────────────────────

test('порог позиции задаёт самая мелкая доля, а не первая', () => {
  assert.equal(gridMinNotionalUsd([{ frac: 0.5, r: 1 }], 11), 22);
  assert.equal(gridMinNotionalUsd([{ frac: 0.5, r: 1 }, { frac: 0.25, r: 2 }], 11), 44);
  assert.equal(gridMinNotionalUsd([{ frac: 0.3, r: 0.5 }, { frac: 0.3, r: 1 }], 11), 11 / 0.3);
});

test('порог согласован с пропуском ступени в buildTpGrid', () => {
  // На пороге встают все ступени, центом ниже — уже не все.
  const legs = [{ frac: 0.5, r: 1 }, { frac: 0.25, r: 2 }];
  const need = gridMinNotionalUsd(legs, 11);
  const at = buildTpGrid({ legs, entry: 1, stopDistPct: 2, isShort: true, sizeSz: need, minSz: 11 });
  const below = buildTpGrid({ legs, entry: 1, stopDistPct: 2, isShort: true, sizeSz: need - 0.01, minSz: 11 });
  assert.equal(at.length, legs.length);
  assert.ok(below.length < legs.length);
});

test('нет сетки или мусорный минимум → порога нет, а не ноль', () => {
  assert.equal(gridMinNotionalUsd([], 11), null);
  assert.equal(gridMinNotionalUsd(null, 11), null);
  assert.equal(gridMinNotionalUsd([{ frac: 0.5, r: 1 }], 0), null);
  assert.equal(gridMinNotionalUsd([{ frac: 0.5, r: 1 }], NaN), null);
});

test('ступени сетки стоят БЛИЖЕ цели — иначе они бессмысленны', () => {
  // Цель adopt при R:R=1.25 и стопе 2% лежит на 2.5%. Ступень 1R = 2% ближе.
  const grid = buildTpGrid({
    legs: [{ frac: 0.5, r: 1 }], entry: 100, stopDistPct: 2, isShort: true, sizeSz: 1000,
  });
  const tpPx = 100 * (1 - 2.5 / 100);
  assert.ok(grid[0].px > tpPx, 'ступень шорта обязана быть выше цели (ближе к рынку)');
});
