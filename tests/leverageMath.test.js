// Потолок плеча по стопу: ликвидация изолированной позиции дальше стопа бота.

import { test } from "node:test";
import assert from "node:assert/strict";

import { liquidationDist, stopSafeLeverage, LIQ_BUFFER } from "../src/modules/dashboard/web/src/features/leverageMath.js";

test("stopSafeLeverage: узкий стоп даёт биржевой максимум", () => {
  assert.deepEqual(stopSafeLeverage({ exchangeMax: 40, stopDistPct: 1 }), { cap: 40, basis: "exchange" });
});

test("stopSafeLeverage: широкий стоп прижимает плечо", () => {
  assert.deepEqual(stopSafeLeverage({ exchangeMax: 40, stopDistPct: 3 }), { cap: 20, basis: "stop" });
  assert.deepEqual(stopSafeLeverage({ exchangeMax: 10, stopDistPct: 8 }), { cap: 6, basis: "stop" });
});

test("stopSafeLeverage: на потолке ликвидация дальше стопа с запасом", () => {
  for (const [ex, stop] of [[40, 2], [25, 4.5], [10, 7], [3, 20]]) {
    const { cap } = stopSafeLeverage({ exchangeMax: ex, stopDistPct: stop });
    assert.ok(liquidationDist(cap, ex) >= (LIQ_BUFFER * stop) / 100, `${ex}x, стоп ${stop}%`);
  }
});

test("stopSafeLeverage: стоп неизвестен — 10x, но не выше биржевого", () => {
  assert.deepEqual(stopSafeLeverage({ exchangeMax: 40, stopDistPct: null }), { cap: 10, basis: "unknown-stop" });
  assert.deepEqual(stopSafeLeverage({ exchangeMax: 3, stopDistPct: null }), { cap: 3, basis: "unknown-stop" });
  assert.equal(stopSafeLeverage({ exchangeMax: 0, stopDistPct: 2 }), null);
});

test("stopSafeLeverage: огромный стоп не опускает ниже 1x", () => {
  assert.equal(stopSafeLeverage({ exchangeMax: 5, stopDistPct: 90 }).cap, 1);
});
