import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EDGE_DISCOVERY_FAMILY = Object.freeze({
  id: "edge-discovery-v1",
  q: 0.1,
  unit: "hypothesis-cell-stage",
});

function legacyCoordinate(run) {
  return JSON.stringify([run.id ?? null, run.window ?? null, run.regime ?? null]);
}

/**
 * Показывает, почему старые results.time.p нельзя считать реестром единиц теста.
 * Это аудит покрытия, а не попытка угадать отсутствующие ячейки по прозе.
 */
export function auditLegacyFdrCoverage(registry) {
  const finite = registry.runs.filter((run) => Number.isFinite(run.results?.time?.p));
  const grouped = Map.groupBy(finite, legacyCoordinate);
  const duplicates = [...grouped.values()].filter((runs) => runs.length > 1);
  const conflicts = duplicates.filter((runs) => (
    new Set(runs.map((run) => run.results.time.p)).size > 1
  ));

  return {
    familyId: EDGE_DISCOVERY_FAMILY.id,
    targetUnit: EDGE_DISCOVERY_FAMILY.unit,
    complete: false,
    registry: {
      hypotheses: registry.hypotheses.length,
      runs: registry.runs.length,
    },
    legacy: {
      finiteTimeP: finite.length,
      uniqueCoordinates: grouped.size,
      duplicateCoordinates: duplicates.length,
      extraExecutions: duplicates.reduce((total, runs) => total + runs.length - 1, 0),
      conflictingCoordinates: conflicts.length,
      runsWithoutFiniteTimeP: registry.runs.length - finite.length,
    },
    blockers: [
      "run не равен единице теста: одна координата могла исполняться несколько раз",
      "id/window/regime не задают cellId, стадию оценки и канонический результат",
      "summary батарей не содержит всех ячеек и их primary p-value в машинном виде",
    ],
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function auditRegistryFile(path = "data/hypotheses/registry.json") {
  const source = readFileSync(path);
  const registry = JSON.parse(source);
  return {
    data: {
      path,
      bytes: statSync(path).size,
      sha256: sha256(source),
      seed: null,
    },
    ...auditLegacyFdrCoverage(registry),
  };
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  console.log(JSON.stringify(auditRegistryFile(), null, 2));
}
