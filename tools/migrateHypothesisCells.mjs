import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BEFORE_COMMIT = "42490befd7d1a8dc17d9acae787c53e9dd7e052b";
export const BEFORE_SHA256 = "0cd72a52a86e212c7dc56361df3eb4fcd9182b0853a763b75f57a80c731b112e";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function stripCellStorage(source) {
  const marker = source.lastIndexOf(',\n  "cells": [');
  const rootEnd = source.lastIndexOf("\n}");
  if (marker < 0 || rootEnd < marker) throw new Error("в реестре нет хвоста cells/cellRuns");
  return source.slice(0, marker) + source.slice(rootEnd);
}

export function migrateRegistryText(source) {
  const parsed = JSON.parse(source);
  const hasCells = Object.hasOwn(parsed, "cells");
  const hasCellRuns = Object.hasOwn(parsed, "cellRuns");
  if (hasCells || hasCellRuns) {
    if (!hasCells || !hasCellRuns || !Array.isArray(parsed.cells) || !Array.isArray(parsed.cellRuns)) {
      throw new Error("реестр мигрирован частично: нужны массивы cells и cellRuns");
    }
    return source;
  }

  const rootEnd = source.lastIndexOf("\n}");
  if (rootEnd < 0) throw new Error("не найден конец корневого объекта реестра");
  const migrated = `${source.slice(0, rootEnd)},\n  "cells": [],\n  "cellRuns": []${source.slice(rootEnd)}`;
  const checked = JSON.parse(migrated);
  if (!Array.isArray(checked.cells) || !Array.isArray(checked.cellRuns)) {
    throw new Error("не удалось создать хранилище ячеек");
  }
  if (stripCellStorage(migrated) !== source) {
    throw new Error("миграция изменила прежнее содержимое реестра");
  }
  return migrated;
}

export function assertPreviousRecordsPreserved(beforeText, currentText) {
  const before = JSON.parse(beforeText);
  const current = JSON.parse(currentText);
  if (!Array.isArray(current.cells) || !Array.isArray(current.cellRuns)) {
    throw new Error("в реестре нет хранилища ячеек");
  }
  if (JSON.stringify(current.hypotheses) !== JSON.stringify(before.hypotheses)) {
    throw new Error("изменены прежние гипотезы");
  }
  if (JSON.stringify(current.runs) !== JSON.stringify(before.runs)) {
    throw new Error("изменены прежние run-записи");
  }
}

function parseArgs(argv) {
  const args = { registry: "data/hypotheses/registry.json" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--registry") args.registry = argv[++i];
    else throw new Error(`неизвестный аргумент: ${argv[i]}`);
  }
  return args;
}

export function migrateFile({ registry }) {
  const source = readFileSync(registry, "utf8");
  const migrated = migrateRegistryText(source);
  const alreadyMigrated = migrated === source;

  if (!alreadyMigrated) {
    if (sha256(source) !== BEFORE_SHA256) {
      throw new Error(`вход не совпадает с ${BEFORE_COMMIT}: SHA-256 ${sha256(source)}`);
    }
    writeFileSync(registry, migrated);
  }

  const currentText = readFileSync(registry, "utf8");
  const current = JSON.parse(currentText);
  return {
    registry,
    beforeCommit: BEFORE_COMMIT,
    beforeSha256: BEFORE_SHA256,
    alreadyMigrated,
    hypotheses: current.hypotheses.length,
    runs: current.runs.length,
    cells: current.cells.length,
    cellRuns: current.cellRuns.length,
    afterBytes: Buffer.byteLength(currentText),
    afterSha256: sha256(currentText),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) console.log(JSON.stringify(migrateFile(parseArgs(process.argv.slice(2))), null, 2));
