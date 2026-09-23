#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  closeHypothesis — закрыть одну OPEN-гипотезу вердиктом по предзаявке
//
//  Правит текст реестра точечно: статус гипотезы и одна run-запись в конец runs.
//  Всё остальное сверяется побайтно по JSON, иначе запись не пишется.
//
//    node tools/closeHypothesis.mjs --id <id> --result REJECTED|INCONCLUSIVE|PASSED_STAT|PASSED_ECONOMICS \
//      --window "<окно и источник>" --n <наблюдений> --reasoning "<почему такой исход>" [--note "..."]
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertRegistry } from "./hypothesisRegistrySchema.mjs";
import { isResultStatus } from "./hypothesisStatus.mjs";

const REGISTRY = "data/hypotheses/registry.json";

function indentRun(run) {
  return JSON.stringify(run, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
}

/** Чистая функция: текст реестра → текст с закрытой гипотезой. */
export function closeHypothesisText(source, { id, result, window, n, reasoning, note, ranAt }) {
  if (!isResultStatus(result)) throw new Error(`неизвестный исход ${result}`);
  if (!window || !reasoning) throw new Error("нужны --window и --reasoning");
  const before = JSON.parse(source);
  const h = before.hypotheses.find((x) => x.id === id);
  if (!h) throw new Error(`в реестре нет гипотезы ${id}`);
  if (h.status !== "OPEN" || h.resultStatus !== null) throw new Error(`${id} уже не OPEN: ${h.status}/${h.resultStatus}`);

  const idMarker = `      "id": "${id}",`;
  const start = source.indexOf(idMarker);
  const end = source.indexOf("\n    },", start);
  if (start < 0 || end < 0) throw new Error(`не найден текст гипотезы ${id}`);
  const block = source.slice(start, end);
  const closed = block
    .replace('      "status": "OPEN",', '      "status": "CLOSED",')
    .replace('      "resultStatus": null,', `      "resultStatus": "${result}",`);
  if (closed === block || closed.includes('"status": "OPEN"') || closed.includes('"resultStatus": null')) {
    throw new Error(`не удалось точечно закрыть ${id}`);
  }
  let text = source.slice(0, start) + closed + source.slice(end);

  const run = { id, window, regime: "форвард, режим не применяется", nEvents: n, ranAt, verdict: result, reasoning };
  if (note) run.note = note;
  const nextKey = text.indexOf('\n  "stageLinks": [');
  const runsEnd = text.lastIndexOf("\n  ]", nextKey);
  if (nextKey < 0 || runsEnd < 0) throw new Error("не найден конец массива runs");
  text = `${text.slice(0, runsEnd)},\n${indentRun(run)}${text.slice(runsEnd)}`;

  const after = assertRegistry(JSON.parse(text));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const expected = before.hypotheses.map((x) => (x.id === id ? { ...x, status: "CLOSED", resultStatus: result } : x));
  if (!same(after.hypotheses, expected)) throw new Error("правка задела другие гипотезы");
  if (!same(after.runs, [...before.runs, run])) throw new Error("правка задела прежние прогоны");
  for (const key of ["stageLinks", "cells", "cellRuns"]) {
    if (!same(after[key], before[key])) throw new Error(`правка задела ${key}`);
  }
  return text;
}

const runDirectly = process.argv[1] && process.argv[1].endsWith("closeHypothesis.mjs");
if (runDirectly) {
  const { values } = parseArgs({
    options: {
      id: { type: "string" }, result: { type: "string" }, window: { type: "string" },
      n: { type: "string" }, reasoning: { type: "string" }, note: { type: "string" },
      registry: { type: "string", default: REGISTRY },
    },
  });
  const source = readFileSync(values.registry, "utf8");
  const text = closeHypothesisText(source, {
    id: values.id, result: values.result, window: values.window,
    n: Number(values.n) || 0, reasoning: values.reasoning, note: values.note,
    ranAt: new Date().toISOString(),
  });
  writeFileSync(values.registry, text);
  console.log(`✅ ${values.id} → CLOSED / ${values.result}`);
}
