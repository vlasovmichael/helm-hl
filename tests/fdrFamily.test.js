import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  EDGE_DISCOVERY_FAMILY,
  auditLegacyFdrCoverage,
} from "../tools/fdrFamily.mjs";
import { fdr, report } from "../tools/harness.mjs";

// Реестр живёт в приватной лаборатории: без её рабочей копии проверка на нём пропускается.
const NO_REGISTRY = !existsSync("data/hypotheses/registry.json") && "нет реестра лаборатории";

function run(id, window, regime, p) {
  return { id, window, regime, results: p === undefined ? {} : { time: { p } } };
}

test("единица FDR отделена от исполнения run", () => {
  const audit = auditLegacyFdrCoverage({
    hypotheses: [{ id: "h" }],
    runs: [
      run("h", "w", "r", 0.01),
      run("h", "w", "r", 0.01),
      run("h", "w", "r", 0.03),
    ],
  });

  assert.equal(audit.familyId, EDGE_DISCOVERY_FAMILY.id);
  assert.equal(audit.legacy.finiteTimeP, 3);
  assert.equal(audit.legacy.uniqueCoordinates, 1);
  assert.equal(audit.legacy.extraExecutions, 2);
  assert.equal(audit.legacy.conflictingCoordinates, 1);
  assert.equal(audit.complete, false);
});

test("аудит явно считает записи вне legacy results.time.p", () => {
  const audit = auditLegacyFdrCoverage({
    hypotheses: [{ id: "battery" }],
    runs: [
      run("battery", "w", "summary"),
      run("battery", "w", "cell", 0.2),
      run("battery", "w", "bad", Number.NaN),
    ],
  });

  assert.equal(audit.legacy.finiteTimeP, 1);
  assert.equal(audit.legacy.runsWithoutFiniteTimeP, 2);
});

test("харнесс не выдаёт legacy results.time.p за полное семейство", { skip: NO_REGISTRY }, () => {
  const result = fdr();

  assert.equal(result.familyId, EDGE_DISCOVERY_FAMILY.id);
  assert.equal(result.coverage.complete, false);
  assert.match(report(), /FDR legacy results\.time\.p/);
  assert.match(report(), /не полное семейство edge-discovery-v1/);
});
