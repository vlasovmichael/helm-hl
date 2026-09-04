// ─────────────────────────────────────────────────
//  researchStats — общий счёт для инструментов и дашборда
// ─────────────────────────────────────────────────
// Чистые функции, без побочных эффектов и без top-level await: модуль
// импортируют И CLI-инструменты, И роут дашборда. Тот же приём, что у
// spikeFadeStats.mjs — иначе витрина и инструмент разъезжаются в цифрах, и
// понять, какая из них врёт, невозможно.

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
