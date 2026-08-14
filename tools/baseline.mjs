// ─────────────────────────────────────────────────
//  baseline — «а монетка бы так смогла?»
// ─────────────────────────────────────────────────
// Зачем: метрика без бейзлайна не значит ничего. «+0.15% на сделку» — это много
// или столько же даст случайный вход на тех же монетах в те же часы? До этого
// модуля ответа не было: единственная попытка бейзлайна была на n=8.
//
// Что делает: берёт набор событий (сделок/сигналов) и строит K суррогатных
// выборок, в которых сломано РОВНО ОДНО свойство. Разные поломки отвечают на
// разные вопросы — поэтому это три отдельные нулевые модели, а не одна:
//
//   time — то же что и было, но вход в случайный момент (час суток сохранён).
//          Ломает ТАЙМИНГ. Отвечает: «а важно ли, КОГДА мы вошли?»
//   coin — то же время и сторона, но случайная монета из торгуемых тогда же.
//          Ломает ОТБОР. Отвечает: «а важно ли, ЧТО мы выбрали?»
//   side — всё то же, но сторона подброшена монеткой.
//          Ломает НАПРАВЛЕНИЕ. Отвечает: «а важно ли, КУДА мы встали?»
//
// Час суток сохраняется намеренно: у крипты сильный внутридневной профиль
// волатильности, и суррогат в случайный час сравнивал бы азиатскую сессию с
// американской. Тогда «эдж» оказался бы просто разницей режимов часа.
//
// ⚠️ Читает свечи из кэша data/borrowed/candles (tools/borrowedEntriesCandles.mjs).
// Сеть не дёргает: бейзлайн гоняется тысячами реплик, сетевой поход тут смерть.

import { loadCandles, INTERVAL } from "./borrowedEntriesCandles.mjs";

const IV_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
const BAR_MS = IV_MS[INTERVAL] || 300_000;
const DAY_MS = 864e5;
const FEE_BP = 4.5; // тейкер HL, на сторону

// ── статистика ──
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// ── ГПСЧ: детерминированный, тот же seed — та же выборка ────────────────────
//
// 🚨 ИСПРАВЛЕНО 14.08.2026. Здесь стоял LCG:
//     s = (s * 1103515245 + 12345) & 0x7fffffff
// Он сломан на JS-числах: произведение доходит до 2⁶¹, а float64 держит 2⁵³,
// поэтому младшие биты теряются ДО маскирования. Замер: 20 000 бросков дают
// ~15 000 различных значений вместо ~20 000 — эффективное пространство состояний
// около 2¹⁶, а не 2³¹.
//
// Чем это било по бейзлайну. Суррогаты — это выборка с повторами из пула монет,
// времён и сторон; когда генератор повторяется, реплики становятся
// СКОРРЕЛИРОВАННЫМИ. Разброс нулевого распределения занижается, доверительный
// интервал сужается, и машина начинает легче объявлять «отличается от
// случайного». То есть баг работал в сторону ЛОЖНЫХ НАХОДОК, а не пропусков:
// прежние выводы вида «эджа нет» (p 0.21…0.99) от него не пострадали, под
// подозрением были только те, кто нулевую модель ПРОШЁЛ.
//
// Обнаружено косвенно, в tools/retestBaseRate.mjs: артефакт, измеренный на
// 98 000 синтетических событий, гулял на 1.8 пп при смене сида, хотя его
// собственный ДИ был 0.4 пп. Так может вести себя только сломанный генератор.
//
// mulberry32 считает в 32-битных целых через Math.imul и этой ямы не имеет.
//
// ⚠️ Прогоны ДО 14.08.2026 этим генератором не воспроизводятся: при том же seed
// последовательность другая. Это не регрессия, это цена исправления.
export function rng(seed = 12345) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── работа со свечами ──
const cache = new Map();
function candles(coin) {
  if (!cache.has(coin)) cache.set(coin, loadCandles(coin));
  return cache.get(coin);
}

/** Индекс первого бара не раньше ts. −1 если такого нет. */
function idxAt(rows, ts) {
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m][0] >= ts) {
      best = m;
      hi = m - 1;
    } else lo = m + 1;
  }
  return best;
}

const netPct = (gross) => gross - (2 * FEE_BP) / 100;

/**
 * Оценка по умолчанию: вошли и вышли через holdMin, без всяких правил.
 * Намеренно тупая — бейзлайн должен мерить сам ВХОД, а не качество выхода.
 * Свои правила выхода передавайте через evalFn.
 */
export function holdAndExit(ev) {
  const c = candles(ev.coin);
  if (!c?.rows?.length) return null;
  const rows = c.rows;
  const i = idxAt(rows, ev.entryTime);
  if (i < 0) return null;
  const j = idxAt(rows, ev.entryTime + ev.holdMin * 60_000);
  if (j < 0 || j <= i) return null;
  const entry = rows[i][4];
  const exit = rows[j][4];
  if (!(entry > 0) || !(exit > 0)) return null;
  const gross = ev.side === "short" ? ((entry - exit) / entry) * 100 : ((exit - entry) / entry) * 100;
  return netPct(gross);
}

/**
 * Суррогат одного события. Возвращает null, если подобрать не удалось —
 * вызывающий тогда просто пропускает реплику, а не подставляет реальное
 * событие (иначе бейзлайн потихоньку сползал бы к реальным данным).
 */
function surrogate(ev, mode, rnd, ctx) {
  if (mode === "side") {
    return { ...ev, side: rnd() < 0.5 ? "long" : "short" };
  }

  if (mode === "coin") {
    // Монета из тех, что торговались в ТО ЖЕ время — иначе подставим монету,
    // которой тогда ещё не было на бирже, и получим пустые свечи.
    const pool = ctx.coins;
    for (let t = 0; t < 12; t++) {
      const coin = pool[Math.floor(rnd() * pool.length)];
      if (coin === ev.coin) continue;
      const c = candles(coin);
      if (!c?.rows?.length) continue;
      if (c.rows[0][0] > ev.entryTime || c.rows[c.rows.length - 1][0] < ev.entryTime + ev.holdMin * 60_000) continue;
      return { ...ev, coin };
    }
    return null;
  }

  // mode === 'time': случайный день, ТОТ ЖЕ час суток и та же длина холда.
  const c = candles(ev.coin);
  if (!c?.rows?.length) return null;
  const rows = c.rows;
  const first = rows[0][0];
  const last = rows[rows.length - 1][0];
  const span = last - first - ev.holdMin * 60_000;
  if (span <= DAY_MS) return null;

  const tod = ev.entryTime % DAY_MS; // время суток в UTC
  const dayFirst = Math.ceil(first / DAY_MS);
  const dayLast = Math.floor((first + span) / DAY_MS);
  if (dayLast <= dayFirst) return null;

  for (let t = 0; t < 12; t++) {
    const day = dayFirst + Math.floor(rnd() * (dayLast - dayFirst));
    const ts = day * DAY_MS + tod;
    if (ts < first || ts + ev.holdMin * 60_000 > last) continue;
    // Не даём суррогату совпасть с настоящим входом (±1 бар)
    if (Math.abs(ts - ev.entryTime) <= BAR_MS) continue;
    return { ...ev, entryTime: ts };
  }
  return null;
}

/**
 * Главная функция. events: [{coin, side, entryTime, holdMin}].
 * Возвращает реальную статистику и распределение K суррогатных.
 */
export function baselineTest(events, { mode = "time", k = 500, seed = 12345, evalFn = holdAndExit, stat = mean } = {}) {
  const rnd = rng(seed);
  const coins = [...new Set(events.map((e) => e.coin))].filter((c) => candles(c)?.rows?.length);
  const ctx = { coins };

  // Реальная выборка: считаем ТОЛЬКО по событиям, которые оценились, и дальше
  // сравниваем с суррогатами на том же наборе — иначе разница в покрытии
  // свечами сама по себе создала бы «эффект».
  const real = [];
  const usable = [];
  for (const ev of events) {
    const v = evalFn(ev);
    if (v == null || !Number.isFinite(v)) continue;
    real.push(v);
    usable.push(ev);
  }
  if (!real.length) throw new Error("ни одно событие не оценилось — нет свечей?");

  const actual = stat(real);

  const surStats = [];
  let failed = 0;
  for (let rep = 0; rep < k; rep++) {
    const vals = [];
    for (const ev of usable) {
      const s = surrogate(ev, mode, rnd, ctx);
      if (!s) { failed++; continue; }
      const v = evalFn(s);
      if (v == null || !Number.isFinite(v)) { failed++; continue; }
      vals.push(v);
    }
    if (vals.length >= usable.length * 0.5) surStats.push(stat(vals));
  }
  if (surStats.length < k * 0.5) throw new Error(`суррогатов вышло мало (${surStats.length}/${k}) — проверьте покрытие свечами`);

  const sorted = [...surStats].sort((a, b) => a - b);
  const below = sorted.filter((x) => x < actual).length;
  const pct = (below / sorted.length) * 100;
  // Двусторонний эмпирический p: доля суррогатов, чьё отклонение от их среднего
  // не меньше отклонения реального значения.
  const sm = mean(surStats);
  const extreme = surStats.filter((x) => Math.abs(x - sm) >= Math.abs(actual - sm)).length;
  const p = (extreme + 1) / (surStats.length + 1);

  return {
    mode,
    n: real.length,
    nEvents: events.length,
    actual,
    surrogateMean: sm,
    surrogateSd: sd(surStats),
    ci95: [sorted[Math.floor(sorted.length * 0.025)], sorted[Math.floor(sorted.length * 0.975)]],
    percentile: pct,
    p,
    reps: surStats.length,
    dropped: failed,
  };
}

export function formatResult(r) {
  const verdict =
    r.p >= 0.05
      ? "НЕ отличается от случайного"
      : r.actual > r.surrogateMean
        ? "ЛУЧШЕ случайного"
        : "ХУЖЕ случайного";
  return [
    `  режим «${r.mode}»  n=${r.n}  реплик=${r.reps}`,
    `    реально      ${r.actual.toFixed(4)}%`,
    `    случайно     ${r.surrogateMean.toFixed(4)}%  (sd ${r.surrogateSd.toFixed(4)}, 95% [${r.ci95[0].toFixed(4)}; ${r.ci95[1].toFixed(4)}])`,
    `    перцентиль   ${r.percentile.toFixed(1)}   p=${r.p.toFixed(4)}  → ${verdict}`,
  ].join("\n");
}

export { mean, median, sd };
