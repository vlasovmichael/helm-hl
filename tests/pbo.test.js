import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PBO_COMBINATIONS,
  probabilityOfBacktestOverfitting,
} from "../tools/pbo.mjs";

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("PBO равен нулю для варианта, лучшего в каждом блоке", () => {
  const result = probabilityOfBacktestOverfitting({
    returns: [
      [3, 2, 1],
      [3, 2, 1],
      [3, 2, 1],
      [3, 2, 1],
    ],
    blockCount: 4,
    metric: mean,
  });

  assert.equal(result.pbo, 0);
  assert.equal(result.splitCount, 6);
  assert.deepEqual(result.selectedVariants, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.oosRanks, [3, 3, 3, 3, 3, 3]);
  assert.ok(result.lambdas.every((lambda) => lambda > 0));
});

test("PBO равен единице, когда IS-победитель всегда худший OOS", () => {
  const result = probabilityOfBacktestOverfitting({
    returns: [
      [1, -1],
      [-1, 1],
    ],
    blockCount: 2,
    metric: mean,
  });

  assert.equal(result.pbo, 1);
  assert.equal(result.splitCount, 2);
  assert.deepEqual(result.selectedVariants, [0, 1]);
  assert.deepEqual(result.oosRanks, [1, 1]);
  assert.ok(result.lambdas.every((lambda) => lambda < 0));
});

test("PBO считает промежуточную долю вручную и включает lambda = 0", () => {
  const result = probabilityOfBacktestOverfitting({
    returns: [
      [8, -7, 3],
      [3, 4, -2],
      [2, 3, -8],
      [8, -4, 5],
    ],
    blockCount: 4,
    metric: mean,
  });

  // Для IS-блоков 01, 02, 03, 12, 13, 23 OOS-ранги равны 3, 3, 2, 1, 3, 3.
  // Ранги 2 и 1 дают lambda <= 0, поэтому ручной ответ — 2 / 6.
  assert.deepEqual(result.oosRanks, [3, 3, 2, 1, 3, 3]);
  assert.equal(result.lambdas.filter((lambda) => lambda <= 0).length, 2);
  assert.equal(result.lambdas[2], 0);
  assert.equal(result.pbo, 1 / 3);
});

test("перестановка столбцов не меняет PBO и логиты", () => {
  const returns = [
    [8, -7, 3],
    [3, 4, -2],
    [2, 3, -8],
    [8, -4, 5],
  ];
  const permutation = [2, 0, 1];
  const original = probabilityOfBacktestOverfitting({ returns, blockCount: 4, metric: mean });
  const permuted = probabilityOfBacktestOverfitting({
    returns: returns.map((row) => permutation.map((index) => row[index])),
    blockCount: 4,
    metric: mean,
  });

  assert.equal(permuted.pbo, original.pbo);
  assert.deepEqual(permuted.lambdas, original.lambdas);
  assert.deepEqual(permuted.oosRanks, original.oosRanks);
});

test("PBO отклоняет нечётные блоки, остаток строк, один вариант и битые значения", () => {
  assert.throws(
    () => probabilityOfBacktestOverfitting({ returns: [[1, 2], [2, 1]], blockCount: 3, metric: mean }),
    /blockCount должен быть чётным/,
  );
  assert.throws(
    () => probabilityOfBacktestOverfitting({
      returns: [[1, 2], [2, 1], [3, 1]],
      blockCount: 2,
      metric: mean,
    }),
    /T должно делиться на blockCount/,
  );
  assert.throws(
    () => probabilityOfBacktestOverfitting({ returns: [[1], [2]], blockCount: 2, metric: mean }),
    /не меньше двух вариантов/,
  );
  assert.throws(
    () => probabilityOfBacktestOverfitting({ returns: [[1, "2"], [2, 1]], blockCount: 2, metric: mean }),
    /только конечные числа/,
  );
});

test("PBO отклоняет ничьи и не вводит tie-break по номеру столбца", () => {
  assert.throws(
    () => probabilityOfBacktestOverfitting({
      returns: [[1, 1], [2, 0]],
      blockCount: 2,
      metric: mean,
    }),
    /ничью на IS/,
  );
  assert.throws(
    () => probabilityOfBacktestOverfitting({
      returns: [[2, 1], [1, 1]],
      blockCount: 2,
      metric: mean,
    }),
    /ничью на OOS/,
  );
});

test("PBO проверяет метрику и её результат", () => {
  assert.throws(
    () => probabilityOfBacktestOverfitting({ returns: [[2, 1], [2, 1]], blockCount: 2 }),
    /metric должна быть функцией/,
  );
  assert.throws(
    () => probabilityOfBacktestOverfitting({
      returns: [[2, 1], [2, 1]],
      blockCount: 2,
      metric: () => Number.NaN,
    }),
    /метрика должна вернуть конечное число/,
  );
});

test("PBO останавливает комбинаторный взрыв до вызова метрики", () => {
  let metricCalls = 0;
  assert.equal(MAX_PBO_COMBINATIONS, 100_000);
  assert.throws(
    () => probabilityOfBacktestOverfitting({
      returns: Array.from({ length: 20 }, () => [2, 1]),
      blockCount: 20,
      metric: (values) => {
        metricCalls++;
        return mean(values);
      },
    }),
    /184756 превышает предел 100000/,
  );
  assert.equal(metricCalls, 0);
});
