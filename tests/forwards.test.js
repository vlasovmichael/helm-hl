// Витрина форвардов и сторож: что считается живым, готовым и завершённым.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_WALLET_ADDRESS = "0x0000000000000000000000000000000000000000";

const { VERDICT_SHOWN_DAYS, classifyHypotheses, forwardProgress } = await import("../src/modules/forwards.js");
const { decideWatch } = await import("../src/app/forwardWatch.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-23T12:00:00Z");

const fwd = (over = {}) => ({
  id: "t", label: "T", target: 3, unit: "events", tField: "t",
  startedISO: "2026-09-01", maxSilentHours: 2, ...over,
});

test("прогресс: счётчик, молчание и готовность", () => {
  const rows = [{ t: NOW - 5 * HOUR }, { t: NOW - 4 * HOUR }, { t: NOW - 3 * HOUR }];
  const p = forwardProgress(fwd(), rows, NOW);
  assert.equal(p.n, 3);
  assert.equal(p.ready, true);
  assert.equal(p.silent, true, "3 часа тишины при ритме 2 часа");
  assert.equal(forwardProgress(fwd({ maxSilentHours: 4 }), rows, NOW).silent, false);
});

test("прогресс по дням считает календарные дни, а не строки", () => {
  const rows = [{ t: NOW }, { t: NOW - HOUR }, { t: NOW - DAY }];
  const p = forwardProgress(fwd({ byDay: true, target: 45 }), rows, NOW);
  assert.equal(p.n, 2);
  assert.equal(p.ready, false);
});

test("сборщик без единой строки после суток работы — молчит", () => {
  assert.equal(forwardProgress(fwd(), [], NOW).silent, true);
  assert.equal(forwardProgress(fwd({ startedISO: "2026-09-23" }), [], NOW).silent, false);
});

test("гейты режима и когорт держат готовность при набранном n", () => {
  const rows = [
    { t: NOW, btcRegime: "btc_up", cohort: "a" },
    { t: NOW, btcRegime: "btc_up", cohort: "a" },
    { t: NOW, btcRegime: "btc_up", cohort: "b" },
  ];
  assert.equal(forwardProgress(fwd({ minRegimeShare: 0.2 }), rows, NOW).ready, false);
  assert.equal(forwardProgress(fwd({ groupField: "cohort", minPerGroup: 2 }), rows, NOW).ready, false);
  assert.equal(forwardProgress(fwd({ groupField: "cohort", minPerGroup: 1 }), rows, NOW).ready, true);
});

test("реестр: закрытое уходит из «идут», провал висит неделю, прошедшее остаётся", () => {
  const registry = {
    hypotheses: [
      { id: "open-a", status: "OPEN" },
      { id: "closed-b", status: "CLOSED", resultStatus: "REJECTED" },
      { id: "old-c", status: "CLOSED", resultStatus: "INCONCLUSIVE" },
      { id: "pass-d", status: "CLOSED", resultStatus: "PASSED_ECONOMICS" },
      { id: "idle-e", status: "OPEN" },
    ],
    runs: [
      { id: "closed-b", ranAt: new Date(NOW - 2 * DAY).toISOString() },
      { id: "old-c", ranAt: new Date(NOW - (VERDICT_SHOWN_DAYS + 1) * DAY).toISOString() },
      { id: "pass-d", ranAt: "2026-01-01T00:00:00Z" },
    ],
  };
  const forwards = [fwd({ id: "open-a" }), fwd({ id: "closed-b" })];
  const { running, finished, idle } = classifyHypotheses(registry, forwards, NOW);
  assert.deepEqual(running.map((f) => f.id), ["open-a"]);
  assert.deepEqual(finished.map((h) => h.id), ["closed-b", "pass-d"]);
  assert.equal(finished[0].hidesAt, NOW - 2 * DAY + VERDICT_SHOWN_DAYS * DAY);
  assert.equal(finished[1].hidesAt, null);
  assert.deepEqual(idle, ["idle-e"]);
});

test("успех разработки, проваленный на holdout, не висит как прошедший", () => {
  const registry = {
    hypotheses: [
      { id: "dev", status: "CLOSED", resultStatus: "PASSED_ECONOMICS" },
      { id: "hold", status: "CLOSED", resultStatus: "REJECTED" },
    ],
    runs: [
      { id: "dev", ranAt: "2026-01-01T00:00:00Z" },
      { id: "hold", ranAt: "2026-01-02T00:00:00Z" },
    ],
    stageLinks: [{ fromHypothesisId: "dev", toHypothesisId: "hold" }],
  };
  assert.deepEqual(classifyHypotheses(registry, [], NOW).finished, []);
});

test("без реестра показываются все форварды", () => {
  const { running } = classifyHypotheses(null, [fwd({ id: "x" })], NOW);
  assert.equal(running.length, 1);
});

test("сторож: один пуш на эпизод молчания, один на порог", () => {
  const item = (silent, ready) => ({ id: "t", label: "T", hasEval: true, progress: { silent, ready, staleHours: 5 } });
  let r = decideWatch([item(true, false)], {}, NOW);
  assert.deepEqual(r.actions.map((a) => a.kind), ["silent"]);
  r = decideWatch([item(true, false)], r.state, NOW + HOUR);
  assert.equal(r.actions.length, 0, "повторный час молчания без пуша");
  r = decideWatch([item(false, true)], r.state, NOW + 2 * HOUR);
  assert.deepEqual(r.actions.map((a) => a.kind), ["recovered", "ready"]);
  r = decideWatch([item(false, true)], r.state, NOW + 3 * HOUR);
  assert.equal(r.actions.length, 0, "оценка запускается один раз");
});
