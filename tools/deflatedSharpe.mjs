const EULER_MASCHERONI = 0.5772156649015329;

function finite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} должен быть конечным числом`);
}

function positive(name, value) {
  finite(name, value);
  if (value <= 0) throw new RangeError(`${name} должен быть больше нуля`);
}

// Аппроксимация обратной функции стандартного нормального распределения.
// Раздельные хвосты не теряют точность на больших семействах испытаний.
function inverseStandardNormal(probability) {
  if (!(probability > 0 && probability < 1)) {
    throw new RangeError("вероятность для нормальной квантили должна быть между 0 и 1");
  }

  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function standardNormalCdf(value) {
  if (value === Infinity) return 1;
  if (value === -Infinity) return 0;
  finite("z-score", value);

  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return 0.5 * (1 + Math.sign(value) * erf);
}

/** Ожидаемый максимум Sharpe для независимых испытаний по формуле EVT. */
export function expectedMaximumSharpe({ sharpeVariance, independentTrials }) {
  finite("sharpeVariance", sharpeVariance);
  if (sharpeVariance < 0) throw new RangeError("sharpeVariance не может быть отрицательной");
  if (!Number.isSafeInteger(independentTrials) || independentTrials < 2) {
    throw new RangeError("independentTrials должен быть целым числом не меньше 2");
  }
  if (sharpeVariance === 0) return 0;

  const ordinary = 1 - 1 / independentTrials;
  const extreme = 1 - 1 / (independentTrials * Math.E);
  const expectedMaximumZ = (1 - EULER_MASCHERONI) * inverseStandardNormal(ordinary)
    + EULER_MASCHERONI * inverseStandardNormal(extreme);
  return Math.sqrt(sharpeVariance) * expectedMaximumZ;
}

/**
 * DSR принимает Sharpe и его дисперсию в одном годовом масштабе.
 * periodsPerYear явно переводит обе величины к частоте наблюдений формулы.
 */
export function deflatedSharpeRatio({
  observedSharpe,
  sharpeVariance,
  periodsPerYear,
  independentTrials,
  sampleLength,
  skewness,
  kurtosis,
}) {
  finite("observedSharpe", observedSharpe);
  finite("skewness", skewness);
  finite("kurtosis", kurtosis);
  positive("periodsPerYear", periodsPerYear);
  if (!Number.isSafeInteger(sampleLength) || sampleLength < 2) {
    throw new RangeError("sampleLength должен быть целым числом не меньше 2");
  }

  const periodSharpe = observedSharpe / Math.sqrt(periodsPerYear);
  const periodSharpeVariance = sharpeVariance / periodsPerYear;
  const expectedMaximumPeriodSharpe = expectedMaximumSharpe({
    sharpeVariance: periodSharpeVariance,
    independentTrials,
  });
  const varianceAdjustment = 1 - skewness * periodSharpe
    + ((kurtosis - 1) / 4) * periodSharpe ** 2;
  if (!(varianceAdjustment > 0) || !Number.isFinite(varianceAdjustment)) {
    throw new RangeError("моменты доходности дают неположительную дисперсию Sharpe");
  }

  const zScore = (periodSharpe - expectedMaximumPeriodSharpe) * Math.sqrt(sampleLength - 1)
    / Math.sqrt(varianceAdjustment);
  return {
    probability: standardNormalCdf(zScore),
    zScore,
    periodSharpe,
    expectedMaximumPeriodSharpe,
    expectedMaximumSharpe: expectedMaximumPeriodSharpe * Math.sqrt(periodsPerYear),
  };
}
