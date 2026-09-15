import test from "node:test";
import assert from "node:assert/strict";

import { overfittingMeasures, report } from "../tools/harness.mjs";

const DSR_INPUTS = {
  observedSharpe: Math.sqrt(6) * Math.sqrt(252),
  sharpeVariance: 0.2,
  periodsPerYear: 252,
  independentTrials: 4,
  sampleLength: 3,
  skewness: 0,
  kurtosis: 1.5,
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("харнесс считает DSR только при наличии воспроизводимого ряда", () => {
  const result = overfittingMeasures({
    dsr: [
      {
        id: "есть-ряд",
        inputs: DSR_INPUTS,
        source: { returns: [1, 2, 3] },
      },
      { id: "нет-ряда", inputs: DSR_INPUTS },
      {
        id: "неверная-длина",
        inputs: DSR_INPUTS,
        source: { returns: [1, 2] },
      },
    ],
  });

  assert.equal(result.dsr.included.length, 1);
  assert.equal(result.dsr.included[0].id, "есть-ряд");
  assert.deepEqual(result.dsr.included[0].seriesStatistics, {
    periodSharpe: Math.sqrt(6),
    sampleLength: 3,
    skewness: 0,
    kurtosis: 1.5,
  });
  assert.ok(Number.isFinite(result.dsr.included[0].result.probability));
  assert.deepEqual(
    result.dsr.excluded.map(({ id }) => id),
    ["нет-ряда", "неверная-длина"],
  );
  assert.match(result.dsr.excluded[0].reason, /нет ряда доходностей/);
  assert.match(result.dsr.excluded[1].reason, /sampleLength.*не совпадает/);
  const mismatches = overfittingMeasures({
    dsr: [
      {
        id: "битый-period-sharpe",
        inputs: { ...DSR_INPUTS, periodSharpe: 1 },
        source: { returns: [1, 2, 3] },
      },
      {
        id: "битый-observed-sharpe",
        inputs: { ...DSR_INPUTS, observedSharpe: 1 },
        source: { returns: [1, 2, 3] },
      },
      {
        id: "битая-асимметрия",
        inputs: { ...DSR_INPUTS, skewness: 1 },
        source: { returns: [1, 2, 3] },
      },
      {
        id: "битый-эксцесс",
        inputs: { ...DSR_INPUTS, kurtosis: 3 },
        source: { returns: [1, 2, 3] },
      },
    ],
  });
  assert.equal(mismatches.dsr.included.length, 0);
  assert.deepEqual(
    mismatches.dsr.excluded.map(({ id }) => id),
    ["битый-period-sharpe", "битый-observed-sharpe", "битая-асимметрия", "битый-эксцесс"],
  );
  assert.match(mismatches.dsr.excluded[0].reason, /periodSharpe.*допуск 1e-12/);
  assert.match(mismatches.dsr.excluded[1].reason, /observedSharpe.*допуск 1e-12/);
  assert.match(mismatches.dsr.excluded[2].reason, /skewness.*допуск 1e-12/);
  assert.match(mismatches.dsr.excluded[3].reason, /kurtosis.*допуск 1e-12/);
});

test("DSR вычисляет отсутствующие моменты из встроенного ряда", () => {
  const result = overfittingMeasures({
    dsr: [{
      id: "без-переданных-моментов",
      inputs: {
        sharpeVariance: 0.2,
        periodsPerYear: 252,
        independentTrials: 4,
      },
      source: { returns: [1, 2, 3] },
    }],
  });

  assert.equal(result.dsr.included.length, 1);
  assert.deepEqual(result.dsr.included[0].seriesStatistics, {
    periodSharpe: Math.sqrt(6),
    sampleLength: 3,
    skewness: 0,
    kurtosis: 1.5,
  });
});

test("DSR без inputs исключается, а не роняет весь отчёт", () => {
  const result = overfittingMeasures({
    dsr: [{ id: "без-inputs", source: { returns: [1, 2, 3] } }],
  });

  assert.equal(result.dsr.included.length, 0);
  assert.equal(result.dsr.excluded[0].status, "EXCLUDED");
  assert.match(result.dsr.excluded[0].reason, /нет inputs/);
});

test("DSR оставляет точную команду восстановления непроверенной", () => {
  const result = overfittingMeasures({
    dsr: [{
      id: "команда",
      inputs: DSR_INPUTS,
      source: {
        reproduceCommand: "node tools/example.mjs",
        data: {
          url: "https://example.test/returns.json",
          bytes: 42,
          sha256: "a".repeat(64),
        },
      },
    }],
  });

  assert.equal(result.dsr.included.length, 0);
  assert.equal(result.dsr.excluded.length, 0);
  assert.deepEqual(result.dsr.unverified, [{
    id: "команда",
    status: "UNVERIFIED",
    reason: "команда воспроизведения не выполнена харнессом",
  }]);
});

test("PBO с аналитической матрицей попадает в структурный результат", () => {
  const result = overfittingMeasures({
    pbo: [{
      id: "батарея",
      returns: [
        [8, -7, 3],
        [3, 4, -2],
        [2, 3, -8],
        [8, -4, 5],
      ],
      variantIds: ["a", "b", "c"],
      blockCount: 4,
      metric: mean,
      metricName: "mean",
    }],
  });

  assert.equal(result.pbo.excluded.length, 0);
  assert.equal(result.pbo.included[0].result.pbo, 1 / 3);
  assert.equal(result.pbo.included[0].result.splitCount, 6);
  assert.deepEqual(result.pbo.included[0].variantIds, ["a", "b", "c"]);
  assert.throws(
    () => overfittingMeasures({
      pbo: [{
        id: "нечётные-блоки",
        returns: [[1, 0], [0, 1]],
        variantIds: ["a", "b"],
        blockCount: 3,
        metric: mean,
        metricName: "mean",
      }],
    }),
    /blockCount должен быть чётным/,
  );
});

test("харнесс исключает PBO при более чем 20% IS-разбиений с ничьёй за первое место", () => {
  const result = overfittingMeasures({
    dsr: [{
      id: "dsr-продолжает-работать",
      inputs: DSR_INPUTS,
      source: { returns: [1, 2, 3] },
    }],
    pbo: [{
      id: "нулевой-блок",
      returns: [[1, 1], [2, 0]],
      variantIds: ["a", "b"],
      blockCount: 2,
      metric: mean,
      metricName: "mean",
    }],
  });

  assert.equal(result.dsr.included.length, 1);
  assert.equal(result.pbo.included.length, 0);
  assert.equal(result.pbo.excluded[0].id, "нулевой-блок");
  assert.equal(result.pbo.excluded[0].status, "EXCLUDED");
  assert.match(result.pbo.excluded[0].reason, /1\/2 разбиений \(50\.00%\), порог 20%/);
  assert.equal(result.pbo.excluded[0].result.excludedSplitRate, 0.5);
});

test("текстовый отчёт показывает DSR/PBO рядом с явными исключениями", () => {
  const text = report({
    overfitting: {
      dsr: [{ id: "без-ряда", inputs: DSR_INPUTS }],
      pbo: [{
        id: "аналитика",
        returns: [
          [8, -7, 3],
          [3, 4, -2],
          [2, 3, -8],
          [8, -4, 5],
        ],
        variantIds: ["a", "b", "c"],
        blockCount: 4,
        metric: mean,
        metricName: "mean",
      }],
    },
  });

  assert.match(text, /Защита от переобучения \(только воспроизводимые ряды\)/);
  assert.match(text, /DSR без-ряда: EXCLUDED — нет ряда доходностей/);
  assert.match(text, /PBO аналитика: 0\.3333, S=4, разбиений 6\/6, исключено 0\.00%, метрика mean/);
});

test("текстовый отчёт не называет непроверенную команду включённой", () => {
  const text = report({
    overfitting: {
      dsr: [{
        id: "команда",
        inputs: DSR_INPUTS,
        source: {
          reproduceCommand: "node tools/example.mjs",
          data: {
            url: "https://example.test/returns.json",
            bytes: 42,
            sha256: "a".repeat(64),
          },
        },
      }],
    },
  });

  assert.match(text, /DSR команда: UNVERIFIED — команда воспроизведения не выполнена/);
  assert.doesNotMatch(text, /DSR команда: вероятность/);
});

test("отчёт без входов не изображает отсутствующие DSR и PBO как числа", () => {
  const text = report();

  assert.match(text, /DSR: входы не переданы; результата нет/);
  assert.match(text, /PBO: матрицы не переданы; результата нет/);
});
