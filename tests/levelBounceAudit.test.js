// Ретро отскока: плацебо той же геометрии и агрегация баров с объёмом.

import { test } from "node:test";
import assert from "node:assert/strict";

const { placeboOf, aggregate, foldTouches, differenceBootstrap } = await import("../tools/levelBounceAudit.mjs");
const { levelZones } = await import("../src/modules/dashboard/routes/levelZones.js");

test("placeboOf: вход дальше от цены, расстояния до стопа и цели те же", () => {
  const sc = { kind: "bounce", side: "long", entry: 99, stop: 98, target: 102, atMarket: false };
  const p = placeboOf(sc, 100, () => 0.5);
  assert.equal(p.entry, 100 - 1 * 1.25);
  assert.equal(p.entry - p.stop, 1);
  assert.equal(p.target - p.entry, 3);
  assert.equal(placeboOf({ ...sc, atMarket: true }, 100, () => 0.5), null);
});

test("placeboOf: шорт уходит вверх от цены", () => {
  const sc = { kind: "bounce", side: "short", entry: 101, stop: 102, target: 98, atMarket: false };
  const p = placeboOf(sc, 100, () => 1);
  assert.equal(p.entry, 102);
  assert.equal(p.stop - p.entry, 1);
});

test("aggregate: неполный час выпадает, объём суммируется", () => {
  const t0 = Date.UTC(2024, 0, 1);
  const bar = (i, px) => ({ t: t0 + i * 900_000, o: px, h: px + 1, l: px - 1, c: px, v: 2 });
  const { higher, ends } = aggregate([0, 1, 2, 3, 4].map((i) => bar(i, 10 + i)), 4);
  assert.equal(higher.length, 1);
  assert.equal(higher[0].vol, 8);
  assert.equal(higher[0].high, 14);
  assert.deepEqual(ends, [3]);
});

test("differenceBootstrap: одинаковые исходы зоны и плацебо дают ноль", () => {
  const days = foldTouches(new Map(), [
    { day: 1, holdout: false, real: 1, placebo: 1 },
    { day: 2, holdout: false, real: -1, placebo: -1 },
  ]);
  const out = differenceBootstrap([...days.values()], 200, 1);
  assert.equal(out.mean, 0);
  assert.equal(out.lo, 0);
  assert.equal(out.hi, 0);
});

test("levelZones: зоны силы не ниже 2, по возрастанию цены", () => {
  const t0 = Date.UTC(2024, 0, 1);
  const candles = Array.from({ length: 200 }, (_, i) => {
    const px = 100 + 5 * Math.sin(i / 6);
    return { time: t0 + i * 3_600_000, open: px, high: px + 0.5, low: px - 0.5, close: px, vol: 10 };
  });
  const { zones, price } = levelZones(candles);
  assert.equal(price, candles.at(-1).close);
  assert.ok(zones.length > 0);
  assert.ok(zones.every((z) => z.strength >= 2));
  assert.ok(zones.every((z, i) => i === 0 || zones[i - 1].price <= z.price));
});
