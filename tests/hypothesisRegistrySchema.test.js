import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  assertRegistry,
  validateRegistry,
  validateRegistryFile,
} from "../tools/hypothesisRegistrySchema.mjs";

const NO_REGISTRY = !existsSync("data/hypotheses/registry.json") && "нет реестра лаборатории";

function registryFixture() {
  return {
    hypotheses: [{
      id: "battery",
      status: "OPEN",
      resultStatus: null,
      description: "Тестовая батарея",
      condition: "Фиктивное условие",
      side: "both",
      rationale: "Проверка schema",
      preregisteredAt: "2026-09-14T10:00:00.000Z",
      holdMin: null,
      postHoc: false,
    }],
    runs: [{
      id: "battery",
      window: "synthetic",
      regime: "нулевой",
      nEvents: 10,
      ranAt: "2026-09-14T11:00:00.000Z",
      results: { time: { p: 0.4 } },
    }],
    stageLinks: [],
    cells: [{
      hypothesisId: "battery",
      cellId: "long-1h",
      stageId: "development-1",
      familyId: "edge-discovery-v1",
      definition: { side: "LONG", hold: "1h" },
      requiredPValues: ["time", "coin"],
      registeredAt: "2026-09-14T10:30:00.000Z",
    }],
    cellRuns: [{
      hypothesisId: "battery",
      cellId: "long-1h",
      stageId: "development-1",
      familyId: "edge-discovery-v1",
      executionId: "run-1",
      pValues: { time: 0.01, coin: 0.2 },
      primaryPValue: 0.2,
      ranAt: "2026-09-14T11:00:00.000Z",
    }],
  };
}

test("schema принимает полный согласованный реестр", () => {
  assert.equal(validateRegistry(registryFixture()).ok, true);
});

test("schema принимает настоящий legacy-реестр лаборатории", { skip: NO_REGISTRY }, () => {
  const registry = validateRegistryFile();
  assert.equal(registry.hypotheses.length, 54);
  assert.equal(registry.runs.length, 128);
});

test("schema ловит повтор id и неверную пару жизненного статуса с исходом", () => {
  const registry = registryFixture();
  registry.hypotheses.push({ ...registry.hypotheses[0], resultStatus: "REJECTED" });
  const result = validateRegistry(registry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("повтор гипотезы")));
  assert.ok(result.errors.some((message) => message.includes("у OPEN-гипотезы")));
});

test("schema ловит прогон незарегистрированной гипотезы и p-value вне диапазона", () => {
  const registry = registryFixture();
  registry.runs[0].id = "missing";
  registry.runs[0].results.time.p = 1.1;
  assert.throws(() => assertRegistry(registry), /не зарегистрирована[\s\S]*вероятность от 0 до 1/);
});

test("schema сверяет состав обязательных p-value", () => {
  const registry = registryFixture();
  registry.cellRuns[0].pValues = { time: 0.01, side: 0.03 };
  registry.cellRuns[0].primaryPValue = 0.03;
  const result = validateRegistry(registry);
  assert.ok(result.errors.some((message) => message.includes("отсутствуют [coin]")));
  assert.ok(result.errors.some((message) => message.includes("лишние [side]")));
});

test("schema сверяет primary p-value с худшей обязательной моделью", () => {
  const registry = registryFixture();
  registry.cellRuns[0].primaryPValue = 0.01;
  const result = validateRegistry(registry);
  assert.ok(result.errors.some((message) => message.includes("должно быть")));
});

test("schema требует, чтобы исправление ссылалось на более раннее исполнение", () => {
  const registry = registryFixture();
  registry.cellRuns[0].replacesExecutionId = "run-0";
  assert.throws(() => assertRegistry(registry), /заменяемое исполнение не найдено раньше/);
});

test("schema запрещает неизвестные поля в новом append-only формате ячеек", () => {
  const registry = registryFixture();
  registry.cells[0].primaryPValue = 0.01;
  assert.throws(() => assertRegistry(registry), /cells\[0\]\.primaryPValue: неизвестное поле/);
});

test("schema проверяет направление и однозначность связей стадий", () => {
  const registry = registryFixture();
  registry.hypotheses.push({ ...registry.hypotheses[0], id: "holdout" });
  registry.stageLinks.push({
    fromHypothesisId: "battery",
    toHypothesisId: "holdout",
    fromStage: "holdout",
    toStage: "development",
    scope: "ячейка",
    registeredAt: "2026-09-14T12:00:00.000Z",
  });
  assert.throws(() => assertRegistry(registry), /следующая стадия должна быть позже/);
});
