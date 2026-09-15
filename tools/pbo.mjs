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

function scoreColumns(columns, metric, sampleName) {
  return columns.map((values, variant) => {
    const score = metric(values);
    if (!Number.isFinite(score)) {
      throw new TypeError(`метрика должна вернуть конечное число для ${sampleName}, вариант ${variant}`);
    }
    return score;
  });
}

function isWinner(scores) {
  const maximum = Math.max(...scores);
  const variants = scores.reduce((out, score, variant) => {
    if (score === maximum) out.push(variant);
    return out;
  }, []);
  return variants.length === 1 ? { variant: variants[0] } : { tiedVariants: variants };
}

function selectedMidrank(scores, selectedVariant) {
  const selectedScore = scores[selectedVariant];
  const below = scores.filter((score) => score < selectedScore).length;
  const equal = scores.filter((score) => score === selectedScore).length;
  return below + (equal + 1) / 2;
}

/**
 * PBO по CSCV. Ранги возрастают от худшего (1) к лучшему (N).
 * Ничья IS-победителей исключает split; OOS-ничья выбранного получает midrank.
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
  const excludedSplits = [];

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
    const winner = isWinner(inSampleScores);
    if (winner.tiedVariants) {
      excludedSplits.push({
        inSampleBlocks: [...inSampleBlocks],
        reason: "ничья за первое место на IS",
        tiedVariants: winner.tiedVariants,
      });
      continue;
    }
    const outOfSampleScores = scoreColumns(outOfSample, metric, "OOS");
    const selectedVariant = winner.variant;
    const oosRank = selectedMidrank(outOfSampleScores, selectedVariant);
    const omega = oosRank / (variantCount + 1);
    const lambda = Math.log(omega / (1 - omega));

    selectedVariants.push(selectedVariant);
    oosRanks.push(oosRank);
    lambdas.push(lambda);
  }

  const overfitCount = lambdas.filter((lambda) => lambda <= 0).length;
  const splitCount = Number(count);
  const evaluatedSplitCount = lambdas.length;
  const excludedSplitCount = excludedSplits.length;
  return {
    pbo: evaluatedSplitCount ? overfitCount / evaluatedSplitCount : null,
    lambdas,
    splitCount,
    evaluatedSplitCount,
    excludedSplitCount,
    excludedSplitRate: excludedSplitCount / splitCount,
    excludedSplits,
    selectedVariants,
    oosRanks,
  };
}
