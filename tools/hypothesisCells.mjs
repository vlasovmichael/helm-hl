import { EDGE_DISCOVERY_FAMILY } from "./fdrFamily.mjs";

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} должен быть непустой строкой`);
  }
  return value;
}

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} должен быть объектом`);
  }
  return value;
}

function requireProbability(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} должен быть числом от 0 до 1`);
  }
  return value;
}

function cloneJson(value, name) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("значение не сериализуется");
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} должен быть JSON-совместимым: ${error.message}`, { cause: error });
  }
}

function coordinate(hypothesisId, cellId, stageId) {
  return JSON.stringify([hypothesisId, cellId, stageId]);
}

function requireStorage(registry) {
  if (!Array.isArray(registry.hypotheses)) throw new Error("в реестре нет массива hypotheses");
  if (!Array.isArray(registry.cells) || !Array.isArray(registry.cellRuns)) {
    throw new Error("реестр не мигрирован: нужны массивы cells и cellRuns");
  }
}

function requireHypothesis(registry, hypothesisId) {
  requireText(hypothesisId, "hypothesisId");
  if (!registry.hypotheses.some((row) => row.id === hypothesisId)) {
    throw new Error(`гипотеза «${hypothesisId}» не зарегистрирована`);
  }
}

function requiredPValueNames(value, cellId) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`у ячейки «${cellId}» requiredPValues должен быть непустым массивом`);
  }
  const names = value.map((name) => requireText(name, `requiredPValues у ячейки «${cellId}»`));
  if (new Set(names).size !== names.length) {
    throw new Error(`у ячейки «${cellId}» requiredPValues содержит повторы`);
  }
  return names;
}

/** Регистрирует всю батарею одним append-only действием до просмотра результатов. */
export function appendCellRegistrations(registry, hypothesisId, {
  stageId,
  cells,
  registeredAt,
}) {
  requireStorage(registry);
  requireHypothesis(registry, hypothesisId);
  requireText(stageId, "stageId");
  requireText(registeredAt, "registeredAt");
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error("cells должен быть непустым массивом");
  }

  const occupied = new Set(registry.cells.map((row) => (
    coordinate(row.hypothesisId, row.cellId, row.stageId)
  )));
  const batch = new Set();
  const records = cells.map((cell) => {
    requireObject(cell, "ячейка");
    const cellId = requireText(cell.cellId, "cellId");
    const key = coordinate(hypothesisId, cellId, stageId);
    if (occupied.has(key) || batch.has(key)) {
      throw new Error(`ячейка «${hypothesisId}/${cellId}/${stageId}» уже зарегистрирована`);
    }
    batch.add(key);
    const requiredPValues = requiredPValueNames(cell.requiredPValues, cellId);
    const definition = cloneJson(requireObject(cell.definition, `definition ячейки «${cellId}»`), "definition");
    return {
      hypothesisId,
      cellId,
      stageId,
      familyId: EDGE_DISCOVERY_FAMILY.id,
      definition,
      requiredPValues,
      registeredAt,
    };
  });

  registry.cells.push(...records);
  return records;
}

function findRegistration(registry, hypothesisId, cellId, stageId) {
  return registry.cells.find((row) => (
    row.hypothesisId === hypothesisId && row.cellId === cellId && row.stageId === stageId
  ));
}

function normalizePValues(value, registration) {
  const pValues = requireObject(value, `pValues ячейки «${registration.cellId}»`);
  const expected = new Set(registration.requiredPValues);
  const actual = Object.keys(pValues);
  const missing = registration.requiredPValues.filter((name) => !Object.hasOwn(pValues, name));
  const unexpected = actual.filter((name) => !expected.has(name));
  if (missing.length || unexpected.length) {
    throw new Error(
      `у ячейки «${registration.cellId}» неверные pValues: отсутствуют [${missing.join(", ")}], ` +
      `лишние [${unexpected.join(", ")}]`,
    );
  }
  return Object.fromEntries(actual.map((name) => [
    name,
    requireProbability(pValues[name], `pValues.${name} ячейки «${registration.cellId}»`),
  ]));
}

function normalizeDiagnosticPValues(value, cellId) {
  if (value === undefined) return undefined;
  const diagnostics = requireObject(value, `diagnosticPValues ячейки «${cellId}»`);
  return Object.fromEntries(Object.entries(diagnostics).map(([name, p]) => [
    requireText(name, `имя diagnosticPValues ячейки «${cellId}»`),
    requireProbability(p, `diagnosticPValues.${name} ячейки «${cellId}»`),
  ]));
}

/** Сохраняет по одной записи на ячейку; primary p-value нельзя передать вручную. */
export function appendCellRuns(registry, hypothesisId, {
  stageId,
  executionId,
  cells,
  ranAt,
  replacesExecutionId,
}) {
  requireStorage(registry);
  requireHypothesis(registry, hypothesisId);
  requireText(stageId, "stageId");
  requireText(executionId, "executionId");
  requireText(ranAt, "ranAt");
  if (replacesExecutionId !== undefined) requireText(replacesExecutionId, "replacesExecutionId");
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error("cells должен быть непустым массивом");
  }

  const batch = new Set();
  const records = cells.map((cell) => {
    requireObject(cell, "результат ячейки");
    const cellId = requireText(cell.cellId, "cellId");
    const key = coordinate(hypothesisId, cellId, stageId);
    if (batch.has(key)) throw new Error(`ячейка «${cellId}» повторена в одном исполнении`);
    batch.add(key);

    const registration = findRegistration(registry, hypothesisId, cellId, stageId);
    if (!registration) {
      throw new Error(`ячейка «${hypothesisId}/${cellId}/${stageId}» не зарегистрирована`);
    }
    if (registry.cellRuns.some((row) => (
      row.hypothesisId === hypothesisId && row.cellId === cellId && row.stageId === stageId &&
      row.executionId === executionId
    ))) {
      throw new Error(`исполнение «${executionId}» ячейки «${cellId}» уже записано`);
    }
    if (replacesExecutionId !== undefined && !registry.cellRuns.some((row) => (
      row.hypothesisId === hypothesisId && row.cellId === cellId && row.stageId === stageId &&
      row.executionId === replacesExecutionId
    ))) {
      throw new Error(`заменяемое исполнение «${replacesExecutionId}» ячейки «${cellId}» не найдено`);
    }

    const pValues = normalizePValues(cell.pValues, registration);
    const diagnosticPValues = normalizeDiagnosticPValues(cell.diagnosticPValues, cellId);
    const record = {
      hypothesisId,
      cellId,
      stageId,
      familyId: registration.familyId,
      executionId,
      pValues,
      primaryPValue: Math.max(...registration.requiredPValues.map((name) => pValues[name])),
      ranAt,
    };
    if (diagnosticPValues !== undefined) record.diagnosticPValues = diagnosticPValues;
    if (cell.result !== undefined) record.result = cloneJson(cell.result, `result ячейки «${cellId}»`);
    if (replacesExecutionId !== undefined) record.replacesExecutionId = replacesExecutionId;
    return record;
  });

  registry.cellRuns.push(...records);
  return records;
}
