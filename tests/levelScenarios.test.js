// Сценарии страницы уровней: Фибо, частота «цель до стопа», размер от риска.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

const { fibLevels, baseRate, barsToTouch, breakevenHit, sizing, buildScenarios, keyZones } = await import(
  "../src/modules/dashboard/web/src/features/levelScenarios.js"
);

const bar = (time, low, high, close = (low + high) / 2) => ({ time, open: close, high, low, close });

test("fibLevels: импульс вверх — ретрейс 0.5 посередине, 1.618 ниже начала", () => {
  const f = fibLevels([bar(1, 100, 101), bar(2, 105, 110), bar(3, 115, 120)]);
  assert.equal(f.up, true);
  assert.equal(f.from, 100);
  assert.equal(f.to, 120);
  const at = (r) => f.levels.find((l) => l.ratio === r).price;
  assert.equal(at(0), 120);
  assert.equal(at(0.5), 110);
  assert.equal(at(1), 100);
  assert.ok(Math.abs(at(1.618) - 87.64) < 1e-9);
});

test("fibLevels: импульс вниз — ретрейс ложится выше минимума", () => {
  const f = fibLevels([bar(1, 119, 120), bar(2, 100, 101)]);
  assert.equal(f.up, false);
  assert.equal(f.levels.find((l) => l.ratio === 0.5).price, 110);
});

test("baseRate: бар, задевший и стоп, и цель, засчитан стопу", () => {
  const candles = [bar(1, 99.9, 100.1, 100), bar(2, 98, 102), bar(3, 99.9, 100.1, 100), bar(4, 99.9, 100.1, 100)];
  const r = baseRate(candles, { side: "long", riskPct: 1, rewardPct: 1, horizon: 1 });
  assert.equal(r.wins, 0);
  assert.equal(r.losses, 1);
});

test("baseRate: цель без стопа — победа, ни того ни другого — открыто", () => {
  const candles = [bar(1, 99.9, 100.1, 100), bar(2, 100, 103, 100), bar(3, 99.5, 100.5, 100)];
  const r = baseRate(candles, { side: "long", riskPct: 1, rewardPct: 2, horizon: 1 });
  assert.equal(r.wins, 1);
  assert.equal(r.open, 1);
  assert.equal(r.n, 2);
  assert.ok(r.ciLo <= r.hit && r.hit <= r.ciHi);
});

test("breakevenHit: 1R к 2R без комиссий — треть, комиссия поднимает порог", () => {
  assert.ok(Math.abs(breakevenHit({ riskPct: 1, rewardPct: 2, costBp: 0 }) - 1 / 3) < 1e-9);
  assert.ok(breakevenHit({ riskPct: 1, rewardPct: 2 }) > 1 / 3);
});

test("sizing: убыток на стопе с комиссией равен заданному риску", () => {
  const plan = { entry: 100, riskPct: 2, rewardPct: 4 };
  const z = sizing({ equity: 1000, riskPct: 1, plan, costBp: 0 });
  assert.equal(z.riskUsd, 10);
  assert.ok(Math.abs(z.notional - 500) < 1e-9);
  assert.ok(Math.abs(z.profitUsd - 20) < 1e-9);
  const withFee = sizing({ equity: 1000, riskPct: 1, plan });
  assert.ok(withFee.notional < 500);
});

test("buildScenarios: две стороны всегда, keyZones держит зоны их стопов и целей", () => {
  const zone = (price) => ({ price, lo: price - 0.2, hi: price + 0.2, sources: ["swing"], touches: 3, strength: 3 });
  const candles = Array.from({ length: 60 }, (_, i) => bar(i, 99, 101, 100));
  const data = { price: 100, atr: 1, candles, zones: [80, 90, 95, 105, 110, 120].map(zone) };
  const sc = buildScenarios(data);
  assert.deepEqual(sc.map((s) => s.side), ["long", "short"]);
  const kept = keyZones(data, sc);
  for (const s of sc) {
    if (s.plan?.stopZone) assert.ok(kept.includes(s.plan.stopZone));
    if (s.plan?.targetZone) assert.ok(kept.includes(s.plan.targetZone));
  }
  assert.ok(kept.length < data.zones.length);
});

test("barsToTouch: медиана баров до касания расстояния в нужную сторону", () => {
  const candles = [bar(1, 99.9, 100.1, 100), bar(2, 100, 100.5, 100), bar(3, 100, 102, 100), bar(4, 100, 100.2, 100)];
  assert.equal(barsToTouch(candles, { up: true, pct: 1.5, horizon: 3 }), 2);
  assert.equal(barsToTouch(candles, { up: false, pct: 5, horizon: 3 }), null);
});

test("buildScenarios: без годного входа у зоны сторона помечена noTrade", () => {
  const zone = (price) => ({ price, lo: price - 0.2, hi: price + 0.2, sources: ["swing"], touches: 3, strength: 3 });
  const candles = Array.from({ length: 60 }, (_, i) => bar(i, 99, 101, 100));
  // Зоны вплотную к цене: стоп за зоной дальше цели, порог не проходит никто.
  const data = { price: 100, atr: 4, candles, zones: [99.5, 100.5].map(zone) };
  const sc = buildScenarios(data);
  assert.ok(sc.every((s) => s.noTrade));
});
