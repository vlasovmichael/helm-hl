// Закрытие гипотезы: меняется ровно статус и добавляется одна run-запись.
//
// Запуск: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { closeHypothesisText } from "../tools/closeHypothesis.mjs";

// Реестр живёт в приватной лаборатории: без её рабочей копии проверка пропускается.
const REGISTRY = "data/hypotheses/registry.json";
const source = existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : null;
const openId = source && JSON.parse(source).hypotheses.find((h) => h.status === "OPEN")?.id;

const args = (over = {}) => ({
  id: openId, result: "REJECTED", window: "тест", n: 1,
  reasoning: "тест", ranAt: "2026-09-23T00:00:00.000Z", ...over,
});

test("закрывает одну гипотезу и дописывает один прогон", { skip: !openId }, () => {
  const before = JSON.parse(source);
  const after = JSON.parse(closeHypothesisText(source, args()));
  const h = after.hypotheses.find((x) => x.id === openId);
  assert.equal(h.status, "CLOSED");
  assert.equal(h.resultStatus, "REJECTED");
  assert.equal(after.runs.length, before.runs.length + 1);
  assert.equal(after.runs.at(-1).id, openId);
  assert.deepEqual(after.stageLinks, before.stageLinks);
});

test("не закрывает дважды и не принимает чужой исход", { skip: !openId }, () => {
  const once = closeHypothesisText(source, args());
  assert.throws(() => closeHypothesisText(once, args()), /уже не OPEN/);
  assert.throws(() => closeHypothesisText(source, args({ result: "GOOD" })), /неизвестный исход/);
  assert.throws(() => closeHypothesisText(source, args({ reasoning: "" })), /--reasoning/);
});
