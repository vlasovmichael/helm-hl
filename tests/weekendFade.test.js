// Выходные HIP-3: заморозка правила и сборка события.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { PREREG_AT, RULE, UNIVERSE, buildEvents, eventNet, stopRuleMet, weekendTimes } from "../tools/weekendFade.mjs";

const HOUR = 3_600_000;
const SAT = Date.parse("2026-10-03T00:00:00Z");

test("параметры заморожены в предзаявленных значениях", () => {
  assert.deepEqual({ ...RULE }, {
    minMoveBp: 100, minWeekends: 20, minEvents: 40, minMeanNetBp: 20,
    iters: 10_000, seed: 20260923, growthTakerBp: 0.9, standardTakerBp: 9,
  });
  assert.equal(PREREG_AT, Date.parse("2026-09-23T22:00:00Z"));
  assert.equal(Object.keys(UNIVERSE).length, 23);
});

test("открытие и закрытие считаются в поясе базового рынка", () => {
  const us = weekendTimes(SAT, "us");
  assert.equal(new Date(us.close).toISOString(), "2026-10-02T20:00:00.000Z");
  assert.equal(new Date(us.open).toISOString(), "2026-10-05T13:30:00.000Z");
  const fut = weekendTimes(Date.parse("2026-11-07T00:00:00Z"), "futures");
  assert.equal(new Date(fut.open).toISOString(), "2026-11-08T23:00:00.000Z");
});

test("событие собирается из трёх часовых снимков и только при ходе от 100 бп", () => {
  const { close, open } = weekendTimes(SAT, "us");
  const snap = (ts, mid) => ({ ts, dex: "xyz", coin: "xyz:NVDA", mid, spread_bp: 2 });
  const fri = Math.ceil(close / HOUR) * HOUR;
  const pre = Math.floor(open / HOUR) * HOUR - HOUR;
  const exit = Math.ceil(open / HOUR) * HOUR + HOUR;
  const now = exit + 2 * HOUR;
  const big = buildEvents([snap(fri, 100), snap(pre, 102), snap(exit, 101)], now);
  assert.equal(big.length, 1);
  assert.equal(big[0].weekend, "2026-10-03");
  assert.ok(Math.abs(eventNet(big[0], 0.9) - (Math.log(102 / 101) * 1e4 - 2 - 1.8)) < 1e-9, "фейд роста — шорт");
  assert.equal(buildEvents([snap(fri, 100), snap(pre, 100.5), snap(exit, 101)], now).length, 0);
});

test("стоп-правило требует и выходных, и событий", () => {
  const late = PREREG_AT + 21 * 7 * 86_400_000;
  assert.equal(stopRuleMet(Array(40).fill({ weekend: "w" }), late).met, true);
  assert.equal(stopRuleMet(Array(39).fill({ weekend: "w" }), late).met, false);
  assert.equal(stopRuleMet(Array(40).fill({ weekend: "w" }), PREREG_AT + 86_400_000).met, false);
});
