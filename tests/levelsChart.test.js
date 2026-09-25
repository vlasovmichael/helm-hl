// Чистые помощники графика уровней: прозрачность токена и подписи оси времени.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

const { withAlpha, tickLabel } = await import("../src/modules/dashboard/web/src/charts/levelsChart.js");

test("withAlpha: hex и rgba токены получают заданную прозрачность", () => {
  assert.equal(withAlpha("#0ecb81", 0.2), "rgba(14, 203, 129, 0.2)");
  assert.equal(withAlpha("#fff", 0.5), "rgba(255, 255, 255, 0.5)");
  assert.equal(withAlpha("rgba(46, 160, 67, 0.15)", 0.4), "rgba(46, 160, 67, 0.4)");
  assert.equal(withAlpha("red", 0.3), "red");
});

test("tickLabel: год, месяц, число и часы по местному времени", () => {
  const t = new Date(2026, 8, 25, 14, 5).getTime() / 1000;
  assert.equal(tickLabel(t, 0), "2026");
  assert.equal(tickLabel(t, 1), "Sep");
  assert.equal(tickLabel(t, 2), "25");
  assert.equal(tickLabel(t, 3), "14:05");
});
