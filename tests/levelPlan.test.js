// План от зоны страницы уровней: сторона, стоп, цель, чтение цены и размер.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

const { planFromZone, readPrice, sizing, shownZones } = await import(
  "../src/modules/dashboard/web/src/features/levelPlan.js"
);

const zone = (price, w = 0.5) => ({ price, lo: price - w, hi: price + w, sources: ["swing"], touches: 3, strength: 3 });

const market = (price, zones) => ({ price, atr: 2, zones, candles: [] });

test("planFromZone: поддержка под ценой — лонг от верхнего края, цель у следующей зоны", () => {
  const s1 = zone(95);
  const r1 = zone(110);
  const p = planFromZone(market(100, [s1, r1]), s1);
  assert.equal(p.side, "long");
  assert.equal(p.entry, 95.5);
  assert.equal(p.stop, 94.5 - 0.5);
  assert.equal(p.target, 109.5);
  assert.equal(p.targetZone, r1);
  assert.equal(p.atMarket, false);
});

test("planFromZone: цена внутри сопротивления — шорт по рынку, стоп за зоной", () => {
  const r1 = zone(100, 1);
  const s1 = zone(90);
  const p = planFromZone(market(99.5, [s1, r1]), r1);
  assert.equal(p.side, "short");
  assert.equal(p.entry, 99.5);
  assert.equal(p.atMarket, true);
  assert.ok(p.stop > r1.hi);
  assert.equal(p.target, 90.5);
});

test("planFromZone: за зоной нет следующей — план без цели", () => {
  const s1 = zone(95);
  const p = planFromZone(market(100, [s1]), s1);
  assert.equal(p.incomplete, true);
});

test("readPrice: посередине между зонами — ждать, у поддержки — лонг", () => {
  const zs = [zone(90), zone(110)];
  assert.equal(readPrice(market(100, zs)).kind, "middle");
  const near = readPrice(market(91.5, zs));
  assert.equal(near.kind, "support");
  assert.equal(near.long.side, "long");
  assert.equal(near.s1.name, "S1");
});

test("shownZones: по две зоны с каждой стороны цены", () => {
  const zs = [zone(80), zone(85), zone(90), zone(110), zone(115), zone(120)];
  const shown = shownZones(market(100, zs), null).map((z) => z.price);
  assert.deepEqual(shown, [85, 90, 110, 115]);
});

test("sizing: убыток на стопе с комиссией равен заданному риску", () => {
  const plan = { entry: 100, riskPct: 2, rewardPct: 4 };
  const z = sizing({ equity: 1000, riskPct: 1, plan, costBp: 0 });
  assert.equal(z.riskUsd, 10);
  assert.ok(Math.abs(z.notional - 500) < 1e-9);
  assert.ok(Math.abs(z.profitUsd - 20) < 1e-9);
  assert.ok(sizing({ equity: 1000, riskPct: 1, plan }).notional < 500);
});
