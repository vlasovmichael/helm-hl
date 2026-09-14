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

const DIR = join("data", "hypotheses");
const REGISTRY = join(DIR, "registry.json");

export function loadRegistry(path = REGISTRY) {
  if (!existsSync(path)) return { hypotheses: [], runs: [], cells: [], cellRuns: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRegistry(reg, path = REGISTRY) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2));
}

function formatRootValue(value) {
  return JSON.stringify(value, null, 2).replaceAll("\n", "\n  ");
}

function saveCellStorage(reg, path, source) {
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
  const reg = JSON.parse(source);
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
  const reg = JSON.parse(source);
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
  const resultStatus = hypothesis.resultStatus;
  if (!isLifecycleStatus(hypothesis.status)) {
    throw new Error(`у гипотезы «${id}» неизвестный жизненный статус`);
  }
  if (hypothesis.status === LIFECYCLE_STATUS.OPEN) {
    if (resultStatus !== null) throw new Error(`у открытой гипотезы «${id}» появился преждевременный исход`);
    return { id, lifecycleStatus: hypothesis.status, resultStatus: null, status: "ОТКРЫТА", runs: runs.length, regimes };
  }
  if (!isResultStatus(resultStatus)) {
    throw new Error(`у закрытой гипотезы «${id}» нет машинного исхода`);
  }
  return {
    id,
    lifecycleStatus: hypothesis.status,
    resultStatus,
    status: RESULT_STATUS_LABEL[resultStatus],
    runs: runs.length,
    regimes,
  };
}

function fixedOrDash(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function report() {
  const reg = loadRegistry();
  const lines = [];
  lines.push(`гипотез зарегистрировано: ${reg.hypotheses.length}, прогонов: ${reg.runs.length}\n`);
  for (const h of reg.hypotheses) {
    const s = status(h.id);
    lines.push(`  ${h.id.padEnd(22)} ${s.status}`);
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
  return lines.join("\n");
}

export { mean };
