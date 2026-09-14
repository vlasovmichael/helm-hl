// ─────────────────────────────────────────────────
//  harness — конвейер проверки гипотез с защитой от самообмана
// ─────────────────────────────────────────────────
// Зачем не просто «прогнать гипотезу»: при alpha=0.05 каждые 20 прогонов дают
// одно ложное срабатывание. Оно будет красивым, и на него уйдут недели — ровно
// как ушли на няньку. Поэтому конвейер устроен так, что забыть о защите нельзя:
//
//   1. Гипотеза регистрируется ДО прогона, с датой. Незарегистрированную
//      прогнать нельзя — run() потребует id из реестра.
//   2. Реестр append-only и хранит ВСЕ прогоны, включая пустые. Без полного
//      счёта поправку на множественность посчитать невозможно, а «помню, что
//      гоняли штук пять» — это не счёт.
//   3. Бейзлайн обязателен: результат без него в реестр не пишется.
//   4. Статус «подтверждено» недостижим на одном режиме рынка — только после
// прогона на окне с противоположным знаком тренда. 🚨 Числом наблюдений
// это не лечится: десять тысяч точек одного режима не спасают.
//   5. FDR (Benjamini-Hochberg) считается по всему реестру, а не по последнему
//      прогону.
//
// Реестр: data/hypotheses/registry.json (в git, в отличие от сырых данных —
// это протокол исследования, он должен быть в истории).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { baselineTest, mean } from "./baseline.mjs";
import {
  isLifecycleStatus,
  isResultStatus,
  LIFECYCLE_STATUS,
  RESULT_STATUS_LABEL,
} from "./hypothesisStatus.mjs";
import { EDGE_DISCOVERY_FAMILY, auditLegacyFdrCoverage } from "./fdrFamily.mjs";
import { appendCellRegistrations, appendCellRuns } from "./hypothesisCells.mjs";
import { assertRegistry } from "./hypothesisRegistrySchema.mjs";
import { resolveStageBranch } from "./hypothesisStages.mjs";
import { deflatedSharpeRatio } from "./deflatedSharpe.mjs";
import { probabilityOfBacktestOverfitting } from "./pbo.mjs";

const DIR = join("data", "hypotheses");
const REGISTRY = join(DIR, "registry.json");

export function loadRegistry(path = REGISTRY) {
  if (!existsSync(path)) return { hypotheses: [], runs: [], stageLinks: [], cells: [], cellRuns: [] };
  return assertRegistry(JSON.parse(readFileSync(path, "utf8")));
}

function saveRegistry(reg, path = REGISTRY) {
  assertRegistry(reg);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2));
}

function formatRootValue(value) {
  return JSON.stringify(value, null, 2).replaceAll("\n", "\n  ");
}

function saveCellStorage(reg, path, source) {
  assertRegistry(reg);
  const marker = source.lastIndexOf(',\n  "cells": [');
  const rootEnd = source.lastIndexOf("\n}");
  if (marker < 0 || rootEnd < marker) {
    throw new Error("реестр не мигрирован: не найден хвост cells/cellRuns");
  }
  const cellTail = (
    `,\n  "cells": ${formatRootValue(reg.cells)},` +
    `\n  "cellRuns": ${formatRootValue(reg.cellRuns)}`
  );
  writeFileSync(path, source.slice(0, marker) + cellTail + source.slice(rootEnd));
}

/** Замораживает все ячейки батареи одним действием до просмотра результатов. */
export function preregisterCells(id, { stageId, cells }, { registryPath = REGISTRY, now = () => new Date().toISOString() } = {}) {
  const source = readFileSync(registryPath, "utf8");
  const reg = assertRegistry(JSON.parse(source));
  const records = appendCellRegistrations(reg, id, {
    stageId,
    cells,
    registeredAt: now(),
  });
  saveCellStorage(reg, registryPath, source);
  return records;
}

/** Пишет отдельный результат каждой ячейки; primary p-value вычисляется внутри. */
export function recordCellRuns(id, payload, { registryPath = REGISTRY, now = () => new Date().toISOString() } = {}) {
  const source = readFileSync(registryPath, "utf8");
  const reg = assertRegistry(JSON.parse(source));
  const records = appendCellRuns(reg, id, { ...payload, ranAt: now() });
  saveCellStorage(reg, registryPath, source);
  return records;
}

/**
 * Предзаявление. Вызывается ДО того, как увидены любые результаты.
 * Повторная регистрация того же id запрещена: иначе формулировку можно было бы
 * подкрутить после первого взгляда на данные, что убивает весь смысл.
 *
 * stopRule — недостающая защита. Пункты 1-5 в шапке ловят подгонку
 * формулировки и множественность, но НЕ ловят подглядывание: если смотреть на
 * накопление каждую неделю и остановиться, когда стало красиво, то ложное
 * срабатывание почти гарантировано — это optional stopping, и он ломает p-value
 * независимо от того, насколько честно посчитан сам тест. Поэтому момент оценки
 * заявляется ЗАРАНЕЕ: {n: 277} = «оценивать ровно один раз, когда наберётся
 * 277 событий, и ни на одном промежуточном n».
 *
 * postHoc — честная пометка «гипотеза придумана ПОСЛЕ взгляда на данные».
 * Такую нельзя проверять на тех же данных, которые её породили; она обязана
 * ждать свежих. Флаг нужен, чтобы через три месяца это не забылось.
 */
export function preregister({ id, description, side, holdMin, rationale, condition, stopRule, evaluation, postHoc = false, evaluateAfter }) {
  const reg = loadRegistry();
  if (reg.hypotheses.some((h) => h.id === id)) {
    throw new Error(`гипотеза «${id}» уже зарегистрирована — переформулировка после регистрации запрещена`);
  }
  reg.hypotheses.push({
    id,
    status: LIFECYCLE_STATUS.OPEN,
    resultStatus: null,
    description,
    condition,
    side,
    holdMin,
    rationale,
    stopRule,
    evaluation,
    postHoc,
    evaluateAfter,
    preregisteredAt: new Date().toISOString(),
  });
  saveRegistry(reg);
  return reg.hypotheses[reg.hypotheses.length - 1];
}

/**
 * Прогон зарегистрированной гипотезы на одном окне.
 * events — уже построенные события {coin, side, entryTime, holdMin}.
 */
export function run(id, events, { window: win, regime, k = 300, seed = 7, modes = ["time", "coin", "side"] } = {}) {
  const reg = loadRegistry();
  const h = reg.hypotheses.find((x) => x.id === id);
  if (!h) throw new Error(`гипотеза «${id}» не зарегистрирована — сначала preregister()`);
  if (!events.length) {
    const empty = { id, window: win, regime, n: 0, ranAt: new Date().toISOString(), results: {}, note: "нет событий" };
    reg.runs.push(empty);
    saveRegistry(reg);
    return empty;
  }

  const results = {};
  for (const mode of modes) {
    try {
      const r = baselineTest(events, { mode, k, seed });
      results[mode] = {
        n: r.n,
        actual: r.actual,
        surrogateMean: r.surrogateMean,
        p: r.p,
        percentile: r.percentile,
      };
    } catch (e) {
      results[mode] = { error: e.message };
    }
  }

  const rec = {
    id,
    window: win,
    regime,
    nEvents: events.length,
    ranAt: new Date().toISOString(),
    results,
  };
  reg.runs.push(rec);
  saveRegistry(reg);
  return rec;
}

/**
 * Устаревший адаптер Benjamini-Hochberg по results.time.p.
 * 🚨 Это не полное семейство edge-discovery-v1: run не равен ячейке теста,
 * батареи пока хранятся summary-строками. Покрытие возвращается явно.
 */
export function fdr(q = 0.1) {
  const reg = loadRegistry();
  const coverage = auditLegacyFdrCoverage(reg);
  const tests = reg.runs
    .filter((r) => Number.isFinite(r.results?.time?.p))
    .map((r) => ({ id: r.id, window: r.window, regime: r.regime, p: r.results.time.p }));
  if (!tests.length) return {
    tests: [], threshold: null, survivors: [], familyId: EDGE_DISCOVERY_FAMILY.id, coverage,
  };

  const sorted = [...tests].sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let kMax = 0;
  sorted.forEach((t, i) => {
    if (t.p <= ((i + 1) / m) * q) kMax = i + 1;
  });
  const threshold = kMax ? (kMax / m) * q : 0;
  return {
    tests: sorted,
    m,
    q,
    familyId: EDGE_DISCOVERY_FAMILY.id,
    coverage,
    threshold,
    survivors: sorted.slice(0, kMax),
  };
}

/** Статус гипотезы: что про неё можно честно сказать на сегодня. */
export function status(id) {
  const reg = loadRegistry();
  const hypothesis = reg.hypotheses.find((row) => row.id === id);
  if (!hypothesis) throw new Error(`гипотеза «${id}» не зарегистрирована`);
  const runs = reg.runs.filter((row) => row.id === id);
  const regimes = [...new Set(runs.map((row) => row.regime).filter(Boolean))];
  const stageResultStatus = hypothesis.resultStatus;
  if (!isLifecycleStatus(hypothesis.status)) {
    throw new Error(`у гипотезы «${id}» неизвестный жизненный статус`);
  }
  if (hypothesis.status === LIFECYCLE_STATUS.OPEN) {
    if (stageResultStatus !== null) throw new Error(`у открытой гипотезы «${id}» появился преждевременный исход`);
  }
  if (hypothesis.status === LIFECYCLE_STATUS.CLOSED && !isResultStatus(stageResultStatus)) {
    throw new Error(`у закрытой гипотезы «${id}» нет машинного исхода`);
  }
  const branch = resolveStageBranch(reg, id);
  const terminal = branch.terminalHypothesis;
  const resultStatus = terminal.resultStatus;
  const finalLabel = terminal.status === LIFECYCLE_STATUS.OPEN
    ? "ОТКРЫТА"
    : RESULT_STATUS_LABEL[resultStatus];
  return {
    id,
    lifecycleStatus: terminal.status,
    resultStatus,
    status: finalLabel,
    stageLifecycleStatus: hypothesis.status,
    stageResultStatus,
    stageStatus: hypothesis.status === LIFECYCLE_STATUS.OPEN
      ? "ОТКРЫТА"
      : RESULT_STATUS_LABEL[stageResultStatus],
    terminalHypothesisId: branch.terminalHypothesisId,
    stageChain: branch.chain,
    runs: runs.length,
    regimes,
  };
}

function fixedOrDash(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function analysisId(value, index, kind) {
  if (typeof value === "string" && value.trim()) return value;
  return `${kind}-${index + 1}`;
}

const DSR_SERIES_TOLERANCE = 1e-12;

function completeDsrCommand(source) {
  const data = source?.data;
  const hasCommand = typeof source?.reproduceCommand === "string" && source.reproduceCommand.trim();
  const hasUrl = typeof data?.url === "string" && data.url.trim();
  const hasBytes = Number.isSafeInteger(data?.bytes) && data.bytes > 0;
  const hasSha256 = typeof data?.sha256 === "string" && /^[0-9a-f]{64}$/i.test(data.sha256);
  return Boolean(hasCommand && hasUrl && hasBytes && hasSha256);
}

function dsrSeriesStatistics(returns, periodsPerYear) {
  if (returns.length < 2) return { error: "ряд доходностей должен содержать не меньше двух значений" };
  if (!returns.every(Number.isFinite)) return { error: "ряд доходностей содержит нечисловые значения" };
  const sampleLength = returns.length;
  const mean = returns.reduce((sum, value) => sum + value, 0) / sampleLength;
  const deviations = returns.map((value) => value - mean);
  const centralMoment = (power) => deviations.reduce(
    (sum, value) => sum + value ** power,
    0,
  ) / sampleLength;
  const secondMoment = centralMoment(2);
  if (!(secondMoment > 0) || !Number.isFinite(secondMoment)) {
    return { error: "ряд доходностей должен иметь положительную конечную дисперсию" };
  }
  const periodSharpe = mean / Math.sqrt(secondMoment);
  return {
    sampleLength,
    periodSharpe,
    observedSharpe: periodSharpe * Math.sqrt(periodsPerYear),
    skewness: centralMoment(3) / secondMoment ** 1.5,
    kurtosis: centralMoment(4) / secondMoment ** 2,
  };
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual)
    && Math.abs(actual - expected) <= DSR_SERIES_TOLERANCE * Math.max(1, Math.abs(expected));
}

function dsrInputMismatch(inputs, statistics) {
  if (inputs.sampleLength !== undefined && inputs.sampleLength !== statistics.sampleLength) {
    return `sampleLength из inputs ${inputs.sampleLength} не совпадает с вычисленным из ряда ${statistics.sampleLength}`;
  }
  if (inputs.periodSharpe !== undefined && !closeEnough(inputs.periodSharpe, statistics.periodSharpe)) {
    return `periodSharpe из inputs ${inputs.periodSharpe} не совпадает с вычисленным из ряда `
      + `${statistics.periodSharpe} (допуск ${DSR_SERIES_TOLERANCE})`;
  }
  for (const field of ["observedSharpe", "skewness", "kurtosis"]) {
    if (inputs[field] !== undefined && !closeEnough(inputs[field], statistics[field])) {
      return `${field} из inputs ${inputs[field]} не совпадает с вычисленным из ряда ${statistics[field]} `
        + `(допуск ${DSR_SERIES_TOLERANCE})`;
    }
  }
  return null;
}

function evaluateDsr(items) {
  const included = [];
  const excluded = [];
  const unverified = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const id = analysisId(item?.id, index, "dsr");
    if (Array.isArray(item?.source?.returns)) {
      if (!item?.inputs || typeof item.inputs !== "object") {
        excluded.push({
          id,
          status: "EXCLUDED",
          reason: "нет inputs с числом испытаний, дисперсией Sharpe и частотой ряда",
        });
        continue;
      }
      const statistics = dsrSeriesStatistics(item.source.returns, item.inputs.periodsPerYear);
      if (statistics.error) {
        excluded.push({ id, status: "EXCLUDED", reason: statistics.error });
        continue;
      }
      const mismatch = dsrInputMismatch(item.inputs, statistics);
      if (mismatch) {
        excluded.push({ id, status: "EXCLUDED", reason: mismatch });
        continue;
      }
      const inputs = {
        ...item.inputs,
        observedSharpe: statistics.observedSharpe,
        sampleLength: statistics.sampleLength,
        skewness: statistics.skewness,
        kurtosis: statistics.kurtosis,
      };
      included.push({
        id,
        status: "INCLUDED",
        independentTrials: inputs.independentTrials,
        seriesStatistics: {
          periodSharpe: statistics.periodSharpe,
          sampleLength: statistics.sampleLength,
          skewness: statistics.skewness,
          kurtosis: statistics.kurtosis,
        },
        result: deflatedSharpeRatio(inputs),
      });
      continue;
    }
    if (completeDsrCommand(item?.source)) {
      unverified.push({
        id,
        status: "UNVERIFIED",
        reason: "команда воспроизведения не выполнена харнессом",
      });
      continue;
    }
    excluded.push({
      id,
      status: "EXCLUDED",
      reason: "нет ряда доходностей или полной команды воспроизведения с URL, размером и SHA-256",
    });
  }
  return { included, unverified, excluded };
}

function validateVariantIds(item) {
  if (!Array.isArray(item.variantIds)) return "variantIds должен быть массивом";
  const width = Array.isArray(item.returns?.[0]) ? item.returns[0].length : null;
  if (item.variantIds.length !== width) return "число variantIds не совпадает с числом столбцов матрицы";
  if (item.variantIds.some((id) => typeof id !== "string" || !id.trim())) {
    return "variantIds должен содержать непустые строки";
  }
  if (new Set(item.variantIds).size !== item.variantIds.length) return "variantIds содержит повторы";
  if (typeof item.metricName !== "string" || !item.metricName.trim()) {
    return "metricName должен быть непустой строкой";
  }
  return null;
}

function evaluatePbo(items) {
  const included = [];
  const excluded = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const id = analysisId(item?.id, index, "pbo");
    const metadataError = validateVariantIds(item ?? {});
    if (metadataError) {
      excluded.push({ id, status: "EXCLUDED", reason: metadataError });
      continue;
    }
    try {
      included.push({
        id,
        status: "INCLUDED",
        blockCount: item.blockCount,
        metricName: item.metricName,
        variantIds: [...item.variantIds],
        result: probabilityOfBacktestOverfitting({
          returns: item.returns,
          blockCount: item.blockCount,
          metric: item.metric,
        }),
      });
    } catch (error) {
      if (!/метрика дала ничью на (?:IS|OOS)/.test(error.message)) throw error;
      excluded.push({ id, status: "EXCLUDED", reason: error.message });
    }
  }
  return { included, excluded };
}

/** Считает DSR/PBO только для явно переданных воспроизводимых рядов. */
export function overfittingMeasures({ dsr = [], pbo = [] } = {}) {
  if (!Array.isArray(dsr) || !Array.isArray(pbo)) {
    throw new TypeError("overfitting.dsr и overfitting.pbo должны быть массивами");
  }
  return { dsr: evaluateDsr(dsr), pbo: evaluatePbo(pbo) };
}

function appendOverfittingReport(lines, measures) {
  lines.push("\nЗащита от переобучения (только воспроизводимые ряды):");
  if (!measures.dsr.included.length && !measures.dsr.excluded.length) {
    lines.push("  DSR: входы не переданы; результата нет");
  }
  for (const row of measures.dsr.included) {
    lines.push(
      `  DSR ${row.id}: вероятность ${fixedOrDash(row.result.probability, 4)}, ` +
      `N=${row.independentTrials}`,
    );
  }
  for (const row of measures.dsr.unverified) {
    lines.push(`  DSR ${row.id}: UNVERIFIED — ${row.reason}`);
  }
  for (const row of measures.dsr.excluded) {
    lines.push(`  DSR ${row.id}: EXCLUDED — ${row.reason}`);
  }

  if (!measures.pbo.included.length && !measures.pbo.excluded.length) {
    lines.push("  PBO: матрицы не переданы; результата нет");
  }
  for (const row of measures.pbo.included) {
    lines.push(
      `  PBO ${row.id}: ${fixedOrDash(row.result.pbo, 4)}, ` +
      `S=${row.blockCount}, разбиений ${row.result.splitCount}, метрика ${row.metricName}`,
    );
  }
  for (const row of measures.pbo.excluded) {
    lines.push(`  PBO ${row.id}: EXCLUDED — ${row.reason}`);
  }
}

export function report({ overfitting } = {}) {
  const reg = loadRegistry();
  const lines = [];
  lines.push(`гипотез зарегистрировано: ${reg.hypotheses.length}, прогонов: ${reg.runs.length}\n`);
  for (const h of reg.hypotheses) {
    const s = status(h.id);
    const branchNote = s.terminalHypothesisId === h.id
      ? ""
      : ` (итог ${s.terminalHypothesisId}; исход этапа: ${s.stageStatus})`;
    lines.push(`  ${h.id.padEnd(22)} ${s.status}${branchNote}`);
    lines.push(`    ${h.description}`);
    const runs = reg.runs.filter((r) => r.id === h.id);
    for (const r of runs) {
      const t = r.results?.time;
      if (!t) { lines.push(`      ${r.window} (${r.regime}): ${r.note || "нет данных"}`); continue; }
      if (t.error) { lines.push(`      ${r.window} (${r.regime}): ошибка ${t.error}`); continue; }
      lines.push(
        `      ${r.window} (${r.regime}): n=${t.n ?? "—"} реально ${fixedOrDash(t.actual, 3)}% ` +
        `против случайного ${fixedOrDash(t.surrogateMean, 3)}%  p=${fixedOrDash(t.p, 4)}`,
      );
    }
  }
  const f = fdr();
  if (f.m) {
    lines.push(`\nFDR legacy results.time.p (Benjamini-Hochberg, q=${f.q}): записей ${f.m}, порог p<${f.threshold.toFixed(4)}`);
    lines.push(
      `  🚨 не полное семейство ${f.familyId}: уникальных координат ${f.coverage.legacy.uniqueCoordinates}, ` +
      `без числового time.p ${f.coverage.legacy.runsWithoutFiniteTimeP}`,
    );
    const uniq = [...new Set(f.survivors.map((s) => s.id))];
    lines.push(uniq.length ? `  переживших поправку: ${uniq.join(", ")}` : "  поправку не пережил никто");
    // Прохождение только по 'time' — слабейшее свидетельство: настоящий сигнал
    // должен зависеть и от момента, и от монеты, и от стороны. Показываем это
    // явно, чтобы «выжила» не читалось сильнее, чем есть.
    for (const id of uniq) {
      const last = reg.runs.filter((r) => r.id === id && r.results?.time?.p != null).pop();
      const passed = ["time", "coin", "side"].filter((m) => last.results[m]?.p != null && last.results[m].p < 0.05);
      lines.push(`    ${id}: нулевых моделей пройдено ${passed.length}/3 (${passed.join(", ") || "—"})`);
    }
  }
  appendOverfittingReport(lines, overfittingMeasures(overfitting));
  return lines.join("\n");
}

export { mean };
