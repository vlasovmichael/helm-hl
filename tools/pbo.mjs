export const MAX_PBO_COMBINATIONS = 100_000;

function validateMatrix(returns) {
  if (!Array.isArray(returns) || returns.length === 0) {
    throw new TypeError("returns должна быть непустой матрицей T×N");
  }
  if (!Array.isArray(returns[0]) || returns[0].length < 2) {
    throw new RangeError("returns должна содержать не меньше двух вариантов");
  }

  const variantCount = returns[0].length;
  for (let rowIndex = 0; rowIndex < returns.length; rowIndex++) {
    const row = returns[rowIndex];
    if (!Array.isArray(row) || row.length !== variantCount) {
      throw new RangeError("returns должна быть прямоугольной матрицей T×N");
    }
    for (let variant = 0; variant < variantCount; variant++) {
      if (!Number.isFinite(row[variant])) {
        throw new TypeError("returns должна содержать только конечные числа");
      }
    }
  }

  return variantCount;
}

function combinationCount(n, k) {
  const shorter = Math.min(k, n - k);
  let result = 1n;
  for (let i = 1; i <= shorter; i++) {
    result = result * BigInt(n - shorter + i) / BigInt(i);
  }
  return result;
}

function* combinations(n, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }

  const missing = k - prefix.length;
  for (let value = start; value <= n - missing; value++) {
    yield* combinations(n, k, value + 1, [...prefix, value]);
  }
}

function rankScores(scores, sampleName) {
  const ranked = scores
    .map((score, variant) => ({ score, variant }))
    .sort((a, b) => {
      if (a.score < b.score) return -1;
      if (a.score > b.score) return 1;
      return a.variant - b.variant;
    });

  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i - 1].score === ranked[i].score) {
      throw new RangeError(`метрика дала ничью на ${sampleName}; статья не задаёт tie-break`);
    }
  }

  return ranked;
}

function scoreColumns(columns, metric, sampleName) {
  return columns.map((values, variant) => {
    const score = metric(values);
    if (!Number.isFinite(score)) {
      throw new TypeError(`метрика должна вернуть конечное число для ${sampleName}, вариант ${variant}`);
    }
    return score;
  });
}

/**
 * PBO по CSCV. Ранги возрастают от худшего (1) к лучшему (N).
 * Ничьи отклоняются: статья определяет ранги как перестановки 1…N.
 */
export function probabilityOfBacktestOverfitting({ returns, blockCount, metric }) {
  if (typeof metric !== "function") throw new TypeError("metric должна быть функцией");
  const variantCount = validateMatrix(returns);
  if (!Number.isSafeInteger(blockCount) || blockCount < 2 || blockCount % 2 !== 0) {
    throw new RangeError("blockCount должен быть чётным целым числом не меньше 2");
  }
  if (returns.length % blockCount !== 0) {
    throw new RangeError("число строк T должно делиться на blockCount без остатка");
  }

  const half = blockCount / 2;
  const count = combinationCount(blockCount, half);
  if (count > BigInt(MAX_PBO_COMBINATIONS)) {
    throw new RangeError(
      `число CSCV-разбиений ${count} превышает предел ${MAX_PBO_COMBINATIONS}`,
    );
  }

  const blockLength = returns.length / blockCount;
  const lambdas = [];
  const selectedVariants = [];
  const oosRanks = [];

  for (const inSampleBlocks of combinations(blockCount, half)) {
    const inSampleSet = new Set(inSampleBlocks);
    const inSample = Array.from({ length: variantCount }, () => []);
    const outOfSample = Array.from({ length: variantCount }, () => []);

    for (let row = 0; row < returns.length; row++) {
      const target = inSampleSet.has(Math.floor(row / blockLength)) ? inSample : outOfSample;
      for (let variant = 0; variant < variantCount; variant++) {
        target[variant].push(returns[row][variant]);
      }
    }

    const inSampleScores = scoreColumns(inSample, metric, "IS");
    const outOfSampleScores = scoreColumns(outOfSample, metric, "OOS");
    const inSampleRanking = rankScores(inSampleScores, "IS");
    const outOfSampleRanking = rankScores(outOfSampleScores, "OOS");
    const selectedVariant = inSampleRanking[variantCount - 1].variant;
    const oosRank = outOfSampleRanking.findIndex(({ variant }) => variant === selectedVariant) + 1;
    const omega = oosRank / (variantCount + 1);
    const lambda = Math.log(omega / (1 - omega));

    selectedVariants.push(selectedVariant);
    oosRanks.push(oosRank);
    lambdas.push(lambda);
  }

  const overfitCount = lambdas.filter((lambda) => lambda <= 0).length;
  return {
    pbo: overfitCount / lambdas.length,
    lambdas,
    splitCount: Number(count),
    selectedVariants,
    oosRanks,
  };
}
