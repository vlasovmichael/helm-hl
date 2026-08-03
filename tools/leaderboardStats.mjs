// ─────────────────────────────────────────────────
//  leaderboardStats — тест персистентности: «есть ли на HL кого копировать»
// ─────────────────────────────────────────────────
// Вопрос: сохраняется ли преимущество трейдера ВНЕ выборки, на которой оно
// замечено. Наивный вариант («взять топ по PnL») отвечает всегда «да» —
// из 40k случайных блужданий верхушка выглядит гениями. Поэтому здесь:
//
//   1. Универсум задаётся МЕХАНИЧЕСКИ (порог оборота), до взгляда на результат.
//   2. Разрез строго out-of-sample: ранг на одном окне, проверка на другом,
//      окна не пересекаются.
//   3. В вывод идёт перестановочный бейзлайн и bootstrap-CI. Метрика без них
//      бессмысленна — на таком n любой градиент «выглядит» значимым.
//
// Два режима:
//   reconstructed — из ОДНОГО снимка: ранг по (allTime − month) = результат до
//     последних 30 дней, проверка по month. Доступен сразу, но окно теста = 1 мес.
//   forward — из ДВУХ снимков: ранг по allTime первого, проверка по приросту
//     между снимками. Честнее (мы сами зафиксировали момент ранжирования), но
//     требует накопленного архива.
//
// Метрика эджа — PnL / оборот (эдж на доллар оборота, в базисных пунктах), а не
// ROI: поле roi у HL ненадёжно (~7% нулей при ненулевом PnL) и не сравнимо между
// счетами разного размера.

const MIN_VLM = 1000; // порог «активен», механический — не по результату
const DECILES = 10;

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function decileSlice(sorted, i) {
  return sorted.slice(
    Math.floor((sorted.length * i) / DECILES),
    Math.floor((sorted.length * (i + 1)) / DECILES),
  );
}

/**
 * Перестановочный бейзлайн: если связи между прошлым и будущим нет, какой спред
 * D10−D1 даёт чистый шум? Возвращает 95%-полосу шума и p-value наблюдаемого.
 */
function permutationBaseline(edges, observed, iters) {
  const n = edges.length;
  const k = Math.floor(n / DECILES);
  const nulls = [];
  let extreme = 0;
  const buf = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    buf.set(edges);
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = buf[i];
      buf[i] = buf[j];
      buf[j] = t;
    }
    const lo = median(Array.from(buf.slice(0, k)));
    const hi = median(Array.from(buf.slice(n - k)));
    const d = hi - lo;
    nulls.push(d);
    if (Math.abs(d) >= Math.abs(observed)) extreme++;
  }
  nulls.sort((a, b) => a - b);
  return {
    noiseLo: nulls[Math.floor(iters * 0.025)],
    noiseHi: nulls[Math.floor(iters * 0.975)],
    pValue: extreme / iters,
    iters,
  };
}

/** Bootstrap-CI медианы. */
function bootstrapCi(sample, iters = 2000) {
  if (sample.length < 20) return { lo: NaN, hi: NaN };
  const meds = [];
  for (let it = 0; it < iters; it++) {
    const a = new Array(sample.length);
    for (let i = 0; i < sample.length; i++) a[i] = sample[(Math.random() * sample.length) | 0];
    meds.push(median(a));
  }
  meds.sort((a, b) => a - b);
  return { lo: meds[Math.floor(iters * 0.025)], hi: meds[Math.floor(iters * 0.975)] };
}

/**
 * Ядро теста. На вход — записи {priorPnl, priorVlm, testPnl, testVlm, accountValue}.
 * Фильтрация, дециляция, бейзлайн, CI.
 */
function runTest(records, { permIters = 500 } = {}) {
  const active = records.filter((r) => r.priorVlm > MIN_VLM && r.testVlm > MIN_VLM);

  // Масса «PnL ровно 0» — счета с оборотом, но без закрытых позиций (открылись и
  // держат). Они не проиграли и не выиграли, а медиану верхних децилей тянут
  // ровно в ноль и маскируют картину. Считаем их отдельно и исключаем.
  const flat = active.filter((r) => r.testPnl === 0).length;
  const universe = active.filter((r) => r.testPnl !== 0);
  if (universe.length < 200) {
    return { ok: false, reason: "too-few", universe: universe.length };
  }

  for (const r of universe) r.edge = r.testPnl / r.testVlm;
  const sorted = [...universe].sort((a, b) => a.priorPnl - b.priorPnl);

  const deciles = [];
  for (let i = 0; i < DECILES; i++) {
    const g = decileSlice(sorted, i);
    const e = g.map((x) => x.edge);
    deciles.push({
      decile: i + 1,
      n: g.length,
      medianEdgeBp: median(e) * 1e4,
      shareProfitable: e.filter((x) => x > 0).length / e.length,
      medianAccountUsd: median(g.map((x) => x.accountValue)),
    });
  }

  const bot = decileSlice(sorted, 0).map((x) => x.edge);
  const top = decileSlice(sorted, DECILES - 1).map((x) => x.edge);
  const observed = median(top) - median(bot);
  const base = permutationBaseline(
    sorted.map((x) => x.edge),
    observed,
    permIters,
  );
  const topCi = bootstrapCi(top);

  return {
    ok: true,
    universe: universe.length,
    excludedFlat: flat,
    minVlmUsd: MIN_VLM,
    deciles,
    spread: {
      observedBp: observed * 1e4,
      noiseLoBp: base.noiseLo * 1e4,
      noiseHiBp: base.noiseHi * 1e4,
      pValue: base.pValue,
      permIters: base.iters,
    },
    topDecile: {
      medianEdgeBp: median(top) * 1e4,
      ciLoBp: topCi.lo * 1e4,
      ciHiBp: topCi.hi * 1e4,
      shareProfitable: top.filter((x) => x > 0).length / top.length,
    },
    // Ключевой вывод в одну строку: существует ли когорта с положительным
    // медианным эджем. Если нет — копировать некого, и это не «плохо поискали».
    anyPositiveCohort: deciles.some((d) => d.medianEdgeBp > 0),
  };
}

/** Режим reconstructed: один снимок, ранг по (allTime − month) → тест по month. */
export function buildReconstructed(snapshot, opts) {
  const records = snapshot.rows.map((r) => ({
    accountValue: r.accountValue,
    priorPnl: r.allTime.pnl - r.month.pnl,
    priorVlm: r.allTime.vlm - r.month.vlm,
    testPnl: r.month.pnl,
    testVlm: r.month.vlm,
  }));
  const res = runTest(records, opts);
  return {
    ...res,
    mode: "reconstructed",
    rankWindow: "всё до последних 30 дней (allTime − month)",
    testWindow: "последние 30 дней (month)",
    capturedAt: snapshot.capturedAt,
  };
}

/** Режим forward: два снимка, ранг по allTime первого → тест по приросту. */
export function buildForward(first, second, opts) {
  const idx = new Map(first.rows.map((r) => [r.addr, r]));
  const records = [];
  for (const b of second.rows) {
    const a = idx.get(b.addr);
    if (!a) continue; // появился между снимками — ранга нет
    records.push({
      accountValue: b.accountValue,
      priorPnl: a.allTime.pnl,
      priorVlm: a.allTime.vlm,
      testPnl: b.allTime.pnl - a.allTime.pnl,
      testVlm: b.allTime.vlm - a.allTime.vlm,
    });
  }
  const res = runTest(records, opts);
  const days = Math.round((second.capturedAt - first.capturedAt) / 864e5);
  return {
    ...res,
    mode: "forward",
    rankWindow: `allTime на ${new Date(first.capturedAt).toISOString().slice(0, 10)}`,
    testWindow: `прирост за ${days} дн. до ${new Date(second.capturedAt).toISOString().slice(0, 10)}`,
    spanDays: days,
    matched: records.length,
    capturedAt: second.capturedAt,
  };
}
