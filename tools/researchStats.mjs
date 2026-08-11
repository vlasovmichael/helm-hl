// ─────────────────────────────────────────────────
//  researchStats — общий счёт для инструментов и дашборда
// ─────────────────────────────────────────────────
// Чистые функции, без побочных эффектов и без top-level await: модуль
// импортируют И CLI-инструменты (feeAudit / disciplineAudit / bookCollector),
// И роут дашборда. Тот же приём, что у spikeFadeStats.mjs — иначе витрина и
// инструмент разъезжаются в цифрах, и понять, какая из них врёт, невозможно.

import { readFileSync, existsSync } from "node:fs";

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* оборванный хвост jsonl */ }
  }
  return out;
}

/** Среднее, разброс и 95% CI. Всё, что показывается пользователю, обязано
 *  идти через это: среднее без CI на таких n систематически вводит в заблуждение. */
export function stats(values) {
  const x = values.filter(Number.isFinite);
  const n = x.length;
  if (n < 2) return { n, weak: true };
  const m = x.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return {
    n, mean: m, sd, sum: m * n,
    lo: m - 1.96 * se, hi: m + 1.96 * se,
    // Ноль внутри CI = отличить от нуля нельзя. Витрина обязана это показывать,
    // иначе знак среднего читается как результат.
    zeroInside: m - 1.96 * se <= 0 && m + 1.96 * se >= 0,
    weak: false,
  };
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

/**
 * Профиль стакана по монетам: спред и глубина.
 * Медиана, а не среднее: спред изредка разъезжается в разы, и среднее уезжает
 * за одним выбросом, рисуя рынок хуже, чем он есть большую часть времени.
 */
export function bookSummary(rows) {
  const byCoin = new Map();
  for (const r of rows) {
    if (!byCoin.has(r.coin)) byCoin.set(r.coin, []);
    byCoin.get(r.coin).push(r);
  }
  const coins = [...byCoin.entries()].map(([coin, list]) => {
    const spreads = list.map((r) => r.spreadBp).filter(Number.isFinite);
    return {
      coin,
      n: list.length,
      medSpreadBp: median(spreads),
      p90SpreadBp: spreads.length ? [...spreads].sort((a, b) => a - b)[Math.floor(spreads.length * 0.9)] : null,
      medBidDepth: median(list.map((r) => r.bidDepth).filter(Number.isFinite)),
      medAskDepth: median(list.map((r) => r.askDepth).filter(Number.isFinite)),
    };
  });
  coins.sort((a, b) => (b.medSpreadBp ?? 0) - (a.medSpreadBp ?? 0));
  return {
    coins,
    samples: rows.length,
    from: rows.length ? Math.min(...rows.map((r) => r.t)) : null,
    to: rows.length ? Math.max(...rows.map((r) => r.t)) : null,
  };
}

/**
 * Сравнение спреда с тейкерской ставкой — то, ради чего стакан вообще пишется.
 * Половина спреда это цена «взять сейчас» относительно середины; если она сильно
 * меньше комиссии, ждать в очереди выгодно, если больше — бессмысленно.
 */
export const TAKER_BP = 4.32;   // фактическая ставка из feeAudit, не табличная
export const MAKER_BP = 1.5;

export function makerVerdict(medSpreadBp) {
  if (medSpreadBp == null) return { verdict: "нет данных", worth: null };
  const halfSpread = medSpreadBp / 2;
  const saving = TAKER_BP - MAKER_BP;      // ~2.8 бп потенциальной экономии
  if (halfSpread > saving * 2) return { verdict: "спред съедает выгоду", worth: false, halfSpread };
  if (halfSpread < saving / 2) return { verdict: "мейкер напрашивается", worth: true, halfSpread };
  return { verdict: "спорно", worth: null, halfSpread };
}

/** Корзины по задержке постановки стопа. Границы фиксированы заранее. */
export const STOP_BUCKETS = [
  { key: "сразу (<1 мин)", test: (m) => m != null && m < 1 },
  { key: "1-10 мин", test: (m) => m != null && m >= 1 && m < 10 },
  { key: "10+ мин", test: (m) => m != null && m >= 10 },
  { key: "стопа не было", test: (m) => m == null },
];

export function disciplineBuckets(trips) {
  return STOP_BUCKETS.map((b) => {
    const group = trips.filter((t) => b.test(t.minsToStop));
    return { key: b.key, ...stats(group.map((t) => t.net)) };
  });
}
