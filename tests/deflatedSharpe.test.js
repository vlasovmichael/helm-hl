import test from "node:test";
import assert from "node:assert/strict";

import {
  deflatedSharpeRatio,
  expectedMaximumSharpe,
} from "../tools/deflatedSharpe.mjs";

const PAPER_EXAMPLE = Object.freeze({
  observedSharpe: 2.5,
  sharpeVariance: 0.5,
  periodsPerYear: 250,
  independentTrials: 100,
  sampleLength: 1250,
  skewness: -3,
  kurtosis: 10,
});

test("DSR воспроизводит численный пример Bailey — López de Prado", () => {
  const result = deflatedSharpeRatio(PAPER_EXAMPLE);

  assert.ok(Math.abs(result.expectedMaximumPeriodSharpe - 0.1132) < 5e-5);
  assert.ok(Math.abs(result.probability - 0.9004) < 5e-5);
});

test("пример статьи пересекает 95% только при N не больше 46", () => {
  const result = deflatedSharpeRatio({ ...PAPER_EXAMPLE, independentTrials: 46 });

  assert.ok(Math.abs(result.probability - 0.9505) < 5e-5);
});

test("нормальный вариант статьи допускает N равное 88", () => {
  const result = deflatedSharpeRatio({
    ...PAPER_EXAMPLE,
    independentTrials: 88,
    skewness: 0,
    kurtosis: 3,
  });

  assert.ok(Math.abs(result.probability - 0.9505) < 5e-5);
});

test("явное приведение частоты не меняет DSR", () => {
  const annualized = deflatedSharpeRatio(PAPER_EXAMPLE);
  const perObservation = deflatedSharpeRatio({
    ...PAPER_EXAMPLE,
    observedSharpe: PAPER_EXAMPLE.observedSharpe / Math.sqrt(PAPER_EXAMPLE.periodsPerYear),
    sharpeVariance: PAPER_EXAMPLE.sharpeVariance / PAPER_EXAMPLE.periodsPerYear,
    periodsPerYear: 1,
  });

  assert.ok(Math.abs(annualized.probability - perObservation.probability) < 1e-12);
  assert.ok(Math.abs(annualized.expectedMaximumPeriodSharpe
    - perObservation.expectedMaximumPeriodSharpe) < 1e-12);
});

test("ожидаемый максимум растёт с числом испытаний", () => {
  const few = expectedMaximumSharpe({ sharpeVariance: 0.5, independentTrials: 10 });
  const many = expectedMaximumSharpe({ sharpeVariance: 0.5, independentTrials: 100 });

  assert.ok(many > few);
});

test("DSR отклоняет неявную частоту и невозможные входы", () => {
  assert.throws(
    () => deflatedSharpeRatio({ ...PAPER_EXAMPLE, periodsPerYear: undefined }),
    /periodsPerYear должен быть конечным числом/,
  );
  assert.throws(
    () => deflatedSharpeRatio({ ...PAPER_EXAMPLE, independentTrials: 1 }),
    /independentTrials должен быть целым числом не меньше 2/,
  );
  assert.throws(
    () => deflatedSharpeRatio({ ...PAPER_EXAMPLE, sampleLength: 1 }),
    /sampleLength должен быть целым числом не меньше 2/,
  );
  assert.throws(
    () => deflatedSharpeRatio({ ...PAPER_EXAMPLE, sharpeVariance: -0.1 }),
    /sharpeVariance не может быть отрицательной/,
  );
});
