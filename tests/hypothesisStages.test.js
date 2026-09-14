import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStageBranch } from "../tools/hypothesisStages.mjs";

test("итог ветки берётся у последней связанной стадии", () => {
  const registry = {
    hypotheses: [
      { id: "development", status: "CLOSED", resultStatus: "PASSED_ECONOMICS" },
      { id: "holdout", status: "CLOSED", resultStatus: "REJECTED" },
    ],
    stageLinks: [{ fromHypothesisId: "development", toHypothesisId: "holdout" }],
  };
  const result = resolveStageBranch(registry, "development");
  assert.equal(result.terminalHypothesisId, "holdout");
  assert.equal(result.terminalHypothesis.resultStatus, "REJECTED");
  assert.deepEqual(result.chain, ["development", "holdout"]);
});

test("цикл стадий отклоняется даже при обходе schema", () => {
  const registry = {
    hypotheses: [{ id: "a" }, { id: "b" }],
    stageLinks: [
      { fromHypothesisId: "a", toHypothesisId: "b" },
      { fromHypothesisId: "b", toHypothesisId: "a" },
    ],
  };
  assert.throws(() => resolveStageBranch(registry, "a"), /цикл стадий/);
});
