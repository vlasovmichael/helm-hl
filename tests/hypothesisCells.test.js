import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { preregisterCells, recordCellRuns } from "../tools/harness.mjs";
import { stripCellStorage } from "../tools/migrateHypothesisCells.mjs";

function withRegistry(run) {
  const dir = mkdtempSync(join(tmpdir(), "hypothesis-cells-"));
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    hypotheses: [{
      id: "battery",
      status: "OPEN",
      resultStatus: null,
      description: "Тестовая батарея",
      condition: "Фиктивное условие",
      side: "both",
      rationale: "Проверка хранения",
      preregisteredAt: "2026-09-14T11:00:00.000Z",
    }],
    runs: [],
    cells: [],
    cellRuns: [],
  }, null, 2));
  try {
    return run(registryPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cells() {
  return [
    {
      cellId: "long-1h",
      definition: { signal: "rank-top", side: "LONG", hold: "1h" },
      requiredPValues: ["time", "coin"],
    },
    {
      cellId: "short-4h",
      definition: { signal: "rank-bottom", side: "SHORT", hold: "4h" },
      requiredPValues: ["time", "coin"],
    },
  ];
}

test("ячейки батареи регистрируются отдельно и атомарно", () => withRegistry((registryPath) => {
  const original = readFileSync(registryPath, "utf8");
  const records = preregisterCells("battery", {
    stageId: "development-1",
    cells: cells(),
  }, {
    registryPath,
    now: () => "2026-09-14T12:00:00.000Z",
  });

  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.equal(records.length, 2);
  assert.equal(registry.cells.length, 2);
  assert.deepEqual(registry.cells.map((row) => row.cellId), ["long-1h", "short-4h"]);
  assert.ok(registry.cells.every((row) => row.familyId === "edge-discovery-v1"));
  assert.equal(stripCellStorage(readFileSync(registryPath, "utf8")), stripCellStorage(original));

  assert.throws(() => preregisterCells("battery", {
    stageId: "development-1",
    cells: [cells()[0]],
  }, { registryPath }), /уже зарегистрирована/);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).cells.length, 2);
}));

test("primary p-value равен худшей обязательной нулевой модели", () => withRegistry((registryPath) => {
  preregisterCells("battery", {
    stageId: "holdout-1",
    cells: cells(),
  }, { registryPath });

  const records = recordCellRuns("battery", {
    stageId: "holdout-1",
    executionId: "run-1",
    cells: [
      {
        cellId: "long-1h",
        pValues: { time: 0.01, coin: 0.2 },
        diagnosticPValues: { regimeGate: 0.03 },
        result: { netBp: 12 },
      },
      {
        cellId: "short-4h",
        pValues: { time: 0.04, coin: 0.03 },
        result: { netBp: -8 },
      },
    ],
  }, {
    registryPath,
    now: () => "2026-09-14T13:00:00.000Z",
  });

  assert.deepEqual(records.map((row) => row.primaryPValue), [0.2, 0.04]);
  const stored = JSON.parse(readFileSync(registryPath, "utf8")).cellRuns;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].result.netBp, 12);
  assert.equal(stored[0].diagnosticPValues.regimeGate, 0.03);
}));

test("неполный набор p-value не оставляет частично записанную батарею", () => withRegistry((registryPath) => {
  preregisterCells("battery", {
    stageId: "forward-1",
    cells: cells(),
  }, { registryPath });

  assert.throws(() => recordCellRuns("battery", {
    stageId: "forward-1",
    executionId: "run-bad",
    cells: [
      { cellId: "long-1h", pValues: { time: 0.01, coin: 0.02 } },
      { cellId: "short-4h", pValues: { time: 0.03 } },
    ],
  }, { registryPath }), /отсутствуют \[coin\]/);
  assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")).cellRuns, []);
}));

test("исправление исполнения записывается новой строкой со ссылкой", () => withRegistry((registryPath) => {
  preregisterCells("battery", {
    stageId: "holdout-2",
    cells: [cells()[0]],
  }, { registryPath });
  recordCellRuns("battery", {
    stageId: "holdout-2",
    executionId: "run-1",
    cells: [{ cellId: "long-1h", pValues: { time: 0.02, coin: 0.04 } }],
  }, { registryPath });
  recordCellRuns("battery", {
    stageId: "holdout-2",
    executionId: "run-2",
    replacesExecutionId: "run-1",
    cells: [{ cellId: "long-1h", pValues: { time: 0.03, coin: 0.05 } }],
  }, { registryPath });

  const stored = JSON.parse(readFileSync(registryPath, "utf8")).cellRuns;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].executionId, "run-1");
  assert.equal(stored[1].replacesExecutionId, "run-1");
  assert.equal(stored[1].primaryPValue, 0.05);
}));
