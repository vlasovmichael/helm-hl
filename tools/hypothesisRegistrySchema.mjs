#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EDGE_DISCOVERY_FAMILY } from "./fdrFamily.mjs";
import { isLifecycleStatus, isResultStatus, LIFECYCLE_STATUS } from "./hypothesisStatus.mjs";
import { STAGE_ORDER } from "./hypothesisStages.mjs";

const ROOT_FIELDS = new Set(["hypotheses", "runs", "stageLinks", "cells", "cellRuns"]);
const STAGE_LINK_FIELDS = new Set([
  "fromHypothesisId", "toHypothesisId", "fromStage", "toStage", "scope", "registeredAt",
]);
const CELL_FIELDS = new Set([
  "hypothesisId", "cellId", "stageId", "familyId", "definition", "requiredPValues", "registeredAt",
]);
const CELL_RUN_FIELDS = new Set([
  "hypothesisId", "cellId", "stageId", "familyId", "executionId", "pValues",
  "primaryPValue", "diagnosticPValues", "result", "ranAt", "replacesExecutionId",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coordinate(hypothesisId, cellId, stageId) {
  return JSON.stringify([hypothesisId, cellId, stageId]);
}

function executionCoordinate(hypothesisId, cellId, stageId, executionId) {
  return JSON.stringify([hypothesisId, cellId, stageId, executionId]);
}

function validateText(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: нужна непустая строка`);
    return false;
  }
  return true;
}

function validateDate(value, path, errors) {
  if (!validateText(value, path, errors)) return false;
  if (Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: дата не распознана`);
    return false;
  }
  return true;
}

function validateProbability(value, path, errors) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path}: нужна конечная вероятность от 0 до 1`);
    return false;
  }
  return true;
}

function validateKnownFields(value, allowed, path, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${path}.${field}: неизвестное поле`);
  }
}

function validateHypotheses(rows, errors) {
  const ids = new Set();
  rows.forEach((row, index) => {
    const path = `hypotheses[${index}]`;
    if (!isObject(row)) {
      errors.push(`${path}: нужна запись-объект`);
      return;
    }

    const idValid = validateText(row.id, `${path}.id`, errors);
    for (const field of ["description", "condition", "side", "rationale"]) {
      validateText(row[field], `${path}.${field}`, errors);
    }
    if (idValid && ids.has(row.id)) errors.push(`${path}.id: повтор гипотезы «${row.id}»`);
    if (idValid) ids.add(row.id);

    if (!isLifecycleStatus(row.status)) {
      errors.push(`${path}.status: допустимы OPEN или CLOSED`);
    } else if (row.status === LIFECYCLE_STATUS.OPEN && row.resultStatus !== null) {
      errors.push(`${path}.resultStatus: у OPEN-гипотезы исход должен быть null`);
    } else if (row.status === LIFECYCLE_STATUS.CLOSED && !isResultStatus(row.resultStatus)) {
      errors.push(`${path}.resultStatus: у CLOSED-гипотезы нужен машинный исход`);
    }

    const registrationField = Object.hasOwn(row, "preregisteredAt") ? "preregisteredAt" : "registeredAt";
    validateDate(row[registrationField], `${path}.${registrationField}`, errors);
    if (Object.hasOwn(row, "holdMin") && row.holdMin !== null &&
        (!Number.isInteger(row.holdMin) || row.holdMin < 0)) {
      errors.push(`${path}.holdMin: нужно неотрицательное целое число или null`);
    }
    if (Object.hasOwn(row, "postHoc") && typeof row.postHoc !== "boolean") {
      errors.push(`${path}.postHoc: нужен boolean`);
    }
  });
  return ids;
}

function validateRuns(rows, hypothesisIds, errors) {
  rows.forEach((row, index) => {
    const path = `runs[${index}]`;
    if (!isObject(row)) {
      errors.push(`${path}: нужна запись-объект`);
      return;
    }
    const idValid = validateText(row.id, `${path}.id`, errors);
    if (idValid && !hypothesisIds.has(row.id)) {
      errors.push(`${path}.id: гипотеза «${row.id}» не зарегистрирована`);
    }
    validateText(row.window, `${path}.window`, errors);
    validateDate(row.ranAt, `${path}.ranAt`, errors);
    if (Object.hasOwn(row, "regime")) validateText(row.regime, `${path}.regime`, errors);
    if (Object.hasOwn(row, "nEvents") && (!Number.isInteger(row.nEvents) || row.nEvents < 0)) {
      errors.push(`${path}.nEvents: нужно неотрицательное целое число`);
    }
    if (Object.hasOwn(row, "results")) {
      if (!isObject(row.results)) {
        errors.push(`${path}.results: нужен объект`);
      } else {
        for (const [name, result] of Object.entries(row.results)) {
          // Legacy-прогоны хранят null, когда нулевая модель не дала p-value.
          if (isObject(result) && Object.hasOwn(result, "p") && result.p !== null) {
            validateProbability(result.p, `${path}.results.${name}.p`, errors);
          }
        }
      }
    }
  });
}

function validateStageLinks(rows, hypothesisIds, errors) {
  const outgoing = new Map();
  const incoming = new Map();
  rows.forEach((row, index) => {
    const path = `stageLinks[${index}]`;
    if (!isObject(row)) {
      errors.push(`${path}: нужна запись-объект`);
      return;
    }
    validateKnownFields(row, STAGE_LINK_FIELDS, path, errors);
    for (const field of ["fromHypothesisId", "toHypothesisId", "fromStage", "toStage", "scope"]) {
      validateText(row[field], `${path}.${field}`, errors);
    }
    validateDate(row.registeredAt, `${path}.registeredAt`, errors);
    if (!hypothesisIds.has(row.fromHypothesisId)) {
      errors.push(`${path}.fromHypothesisId: гипотеза «${row.fromHypothesisId}» не зарегистрирована`);
    }
    if (!hypothesisIds.has(row.toHypothesisId)) {
      errors.push(`${path}.toHypothesisId: гипотеза «${row.toHypothesisId}» не зарегистрирована`);
    }
    if (row.fromHypothesisId === row.toHypothesisId) errors.push(`${path}: стадия не может ссылаться на себя`);
    const fromOrder = STAGE_ORDER.indexOf(row.fromStage);
    const toOrder = STAGE_ORDER.indexOf(row.toStage);
    if (fromOrder < 0) errors.push(`${path}.fromStage: неизвестная стадия`);
    if (toOrder < 0) errors.push(`${path}.toStage: неизвестная стадия`);
    if (fromOrder >= 0 && toOrder >= 0 && toOrder <= fromOrder) {
      errors.push(`${path}: следующая стадия должна быть позже предыдущей`);
    }
    if (outgoing.has(row.fromHypothesisId)) errors.push(`${path}: у исходной стадии уже есть продолжение`);
    else outgoing.set(row.fromHypothesisId, row.toHypothesisId);
    if (incoming.has(row.toHypothesisId)) errors.push(`${path}: у следующей стадии уже есть предшественник`);
    else incoming.set(row.toHypothesisId, row.fromHypothesisId);
  });

  for (const start of outgoing.keys()) {
    const seen = new Set();
    let current = start;
    while (outgoing.has(current)) {
      if (seen.has(current)) {
        errors.push(`stageLinks: цикл стадий от «${start}»`);
        break;
      }
      seen.add(current);
      current = outgoing.get(current);
    }
  }
}

function validateCells(rows, hypothesisIds, errors) {
  const registrations = new Map();
  rows.forEach((row, index) => {
    const path = `cells[${index}]`;
    if (!isObject(row)) {
      errors.push(`${path}: нужна запись-объект`);
      return;
    }
    validateKnownFields(row, CELL_FIELDS, path, errors);
    const hypothesisValid = validateText(row.hypothesisId, `${path}.hypothesisId`, errors);
    const cellValid = validateText(row.cellId, `${path}.cellId`, errors);
    const stageValid = validateText(row.stageId, `${path}.stageId`, errors);
    if (hypothesisValid && !hypothesisIds.has(row.hypothesisId)) {
      errors.push(`${path}.hypothesisId: гипотеза «${row.hypothesisId}» не зарегистрирована`);
    }
    if (row.familyId !== EDGE_DISCOVERY_FAMILY.id) {
      errors.push(`${path}.familyId: нужен ${EDGE_DISCOVERY_FAMILY.id}`);
    }
    if (!isObject(row.definition)) errors.push(`${path}.definition: нужен объект`);
    validateDate(row.registeredAt, `${path}.registeredAt`, errors);

    if (!Array.isArray(row.requiredPValues) || row.requiredPValues.length === 0) {
      errors.push(`${path}.requiredPValues: нужен непустой массив`);
    } else {
      const names = new Set();
      row.requiredPValues.forEach((name, pIndex) => {
        if (validateText(name, `${path}.requiredPValues[${pIndex}]`, errors)) {
          if (names.has(name)) errors.push(`${path}.requiredPValues[${pIndex}]: повтор «${name}»`);
          names.add(name);
        }
      });
    }

    if (hypothesisValid && cellValid && stageValid) {
      const key = coordinate(row.hypothesisId, row.cellId, row.stageId);
      if (registrations.has(key)) errors.push(`${path}: повтор координаты ячейки`);
      else registrations.set(key, row);
    }
  });
  return registrations;
}

function validateCellRuns(rows, hypothesisIds, registrations, errors) {
  const executions = new Set();
  rows.forEach((row, index) => {
    const path = `cellRuns[${index}]`;
    if (!isObject(row)) {
      errors.push(`${path}: нужна запись-объект`);
      return;
    }
    validateKnownFields(row, CELL_RUN_FIELDS, path, errors);
    const hypothesisValid = validateText(row.hypothesisId, `${path}.hypothesisId`, errors);
    const cellValid = validateText(row.cellId, `${path}.cellId`, errors);
    const stageValid = validateText(row.stageId, `${path}.stageId`, errors);
    const executionValid = validateText(row.executionId, `${path}.executionId`, errors);
    if (hypothesisValid && !hypothesisIds.has(row.hypothesisId)) {
      errors.push(`${path}.hypothesisId: гипотеза «${row.hypothesisId}» не зарегистрирована`);
    }
    validateDate(row.ranAt, `${path}.ranAt`, errors);

    const cellKey = coordinate(row.hypothesisId, row.cellId, row.stageId);
    const registration = registrations.get(cellKey);
    if (hypothesisValid && cellValid && stageValid && !registration) {
      errors.push(`${path}: ячейка не зарегистрирована`);
    }
    if (registration && row.familyId !== registration.familyId) {
      errors.push(`${path}.familyId: не совпадает с регистрацией ячейки`);
    }

    const expected = registration?.requiredPValues ?? [];
    if (!isObject(row.pValues)) {
      errors.push(`${path}.pValues: нужен объект`);
    } else {
      const actual = Object.keys(row.pValues);
      const missing = expected.filter((name) => !Object.hasOwn(row.pValues, name));
      const extra = actual.filter((name) => !expected.includes(name));
      if (missing.length) errors.push(`${path}.pValues: отсутствуют [${missing.join(", ")}]`);
      if (extra.length) errors.push(`${path}.pValues: лишние [${extra.join(", ")}]`);
      actual.forEach((name) => validateProbability(row.pValues[name], `${path}.pValues.${name}`, errors));
      if (expected.length && expected.every((name) => Number.isFinite(row.pValues[name]))) {
        const primary = Math.max(...expected.map((name) => row.pValues[name]));
        if (!Object.is(row.primaryPValue, primary)) {
          errors.push(`${path}.primaryPValue: должно быть ${primary}`);
        }
      } else {
        validateProbability(row.primaryPValue, `${path}.primaryPValue`, errors);
      }
    }

    if (Object.hasOwn(row, "diagnosticPValues")) {
      if (!isObject(row.diagnosticPValues)) {
        errors.push(`${path}.diagnosticPValues: нужен объект`);
      } else {
        for (const [name, value] of Object.entries(row.diagnosticPValues)) {
          validateText(name, `${path}.diagnosticPValues: имя`, errors);
          validateProbability(value, `${path}.diagnosticPValues.${name}`, errors);
        }
      }
    }

    if (hypothesisValid && cellValid && stageValid && executionValid) {
      const key = executionCoordinate(row.hypothesisId, row.cellId, row.stageId, row.executionId);
      if (executions.has(key)) errors.push(`${path}: повтор исполнения ячейки`);
      if (Object.hasOwn(row, "replacesExecutionId")) {
        validateText(row.replacesExecutionId, `${path}.replacesExecutionId`, errors);
        const replaced = executionCoordinate(
          row.hypothesisId, row.cellId, row.stageId, row.replacesExecutionId,
        );
        if (!executions.has(replaced)) errors.push(`${path}.replacesExecutionId: заменяемое исполнение не найдено раньше`);
      }
      executions.add(key);
    }
  });
}

export function validateRegistry(registry) {
  const errors = [];
  if (!isObject(registry)) return { ok: false, errors: ["registry: нужен корневой объект"] };
  validateKnownFields(registry, ROOT_FIELDS, "registry", errors);
  for (const field of ROOT_FIELDS) {
    if (!Array.isArray(registry[field])) errors.push(`registry.${field}: нужен массив`);
  }
  if (errors.length) return { ok: false, errors };

  const hypothesisIds = validateHypotheses(registry.hypotheses, errors);
  validateRuns(registry.runs, hypothesisIds, errors);
  validateStageLinks(registry.stageLinks, hypothesisIds, errors);
  const registrations = validateCells(registry.cells, hypothesisIds, errors);
  validateCellRuns(registry.cellRuns, hypothesisIds, registrations, errors);
  return { ok: errors.length === 0, errors };
}

export function assertRegistry(registry) {
  const result = validateRegistry(registry);
  if (!result.ok) {
    const error = new Error(`реестр не прошёл schema-проверку:\n- ${result.errors.join("\n- ")}`);
    error.validationErrors = result.errors;
    throw error;
  }
  return registry;
}

export function validateRegistryFile(path = "data/hypotheses/registry.json") {
  return assertRegistry(JSON.parse(readFileSync(path, "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2] ?? "data/hypotheses/registry.json";
  if (!existsSync(path)) throw new Error(`реестр не найден: ${path}`);
  const registry = validateRegistryFile(path);
  console.log(
    `✅ schema реестра: ${registry.hypotheses.length} гипотез, ${registry.runs.length} прогонов, ` +
    `${registry.stageLinks.length} связей стадий, ${registry.cells.length} ячеек, ` +
    `${registry.cellRuns.length} исполнений ячеек`,
  );
}
