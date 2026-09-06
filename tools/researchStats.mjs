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

/**
 * Кластерный бутстрап-CI: ресемплим ЦЕЛЫЕ дни. Сделки одного дня не независимы,
 * и обычный CI на них занижен. Сид фиксирован — ответ повторяем.
 */
export function clusterCi(values, dayKeys, iters = 2000, seed = 12345) {
  const byDay = new Map();
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    const k = dayKeys[i] ?? "?";
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(values[i]);
  }
  const days = [...byDay.values()];
  if (days.length < 5) return null;
  let s = (seed >>> 0) || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0, n = 0;
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(rand() * days.length)];
      for (const v of d) { sum += v; n++; }
    }
    if (n) out.push(sum / n);
  }
  if (out.length < iters / 2) return null;
  out.sort((a, b) => a - b);
  const lo = out[Math.floor(out.length * 0.025)];
  const hi = out[Math.floor(out.length * 0.975)];
  return { lo, hi, days: days.length, zeroInside: lo <= 0 && hi >= 0 };
}

/** Разбор «выиграло/проиграло». Winrate без payoff не решает ничего. */
export function winLose(values) {
  const x = values.filter(Number.isFinite);
  const wins = x.filter((v) => v > 0);
  const losses = x.filter((v) => v < 0);
  const avg = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : null);
  const meanWin = avg(wins);
  const meanLoss = avg(losses);
  return {
    n: x.length,
    wins: wins.length,
    losses: losses.length,
    flats: x.length - wins.length - losses.length,
    winRate: x.length ? wins.length / x.length : null,
    meanWin,
    meanLoss,
    sumWin: wins.reduce((p, c) => p + c, 0),
    sumLoss: losses.reduce((p, c) => p + c, 0),
    payoff: meanWin != null && meanLoss ? Math.abs(meanWin / meanLoss) : null,
  };
}
