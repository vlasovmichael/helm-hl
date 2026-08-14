// ─────────────────────────────────────────────────
//  borrowedEntriesReplay — чужие входы через МОИ выходы
// ─────────────────────────────────────────────────
// Проверяемое утверждение: «неважно как ты зайдёшь, эдж в няньке». Берём чужие
// входы (borrowedEntriesFetch) и прогоняем по ценовому пути правила adopt из
// strategistAdopt.js / adoptReconcile.js, сравнивая с тем, как вышли они сами.
//
// Правила взяты из кода, не придуманы (значения по умолчанию config.js):
//   жёсткий стоп  ATR(1h,14) × 1.5 / цена, зажат в [2%, 8%], фолбэк фикс 5%
//   BE-храповик   пик ≥ 1.5% → взвод; unrealized ≤ 0% → закрыть в ноль
//   трейл         пик ≥ 2% → откат ≥ 30% от пика → закрыть
//
// ⚠️ Внутрибарный порядок неизвестен: свеча знает свой max и min, но не что
// было раньше. Для стратегии, чей эдж якобы в тайминге выхода, это не мелочь.
// Поэтому считаем ОБА крайних сценария и показываем вилку:
//   pessimistic — сначала ход ПРОТИВ позы (стоп/храповик срабатывают раньше пика)
//   optimistic  — сначала ход В пользу позы (пик успевает вырасти)
// Правда лежит между. Если вывод меняет знак внутри вилки — вывода нет.
//
// ATR считаем агрегацией 5m→1h из тех же свечей: отдельный забор часовых ничего
// не уточнил бы, а сеть дёргает лишний раз.

import { readFileSync } from "node:fs";
import { loadCandles, INTERVAL } from "./borrowedEntriesCandles.mjs";
import { rng } from "./baseline.mjs";

// ── параметры adopt (config.js defaults) ──
const STOP_ATR_MULT = 1.5;
const STOP_MIN_PCT = 2;
const STOP_MAX_PCT = 8;
const STOP_FALLBACK_PCT = 5;
const ATR_PERIOD = 14;
const BE_ARM_PCT = 1.5;
const BE_FLOOR_PCT = 0;
const TRAIL_ARM_PCT = 2;
const TRAIL_GIVEBACK_PCT = 30;

const FEE_BP = 4.5; // тейкерская комиссия HL, на сторону
const HORIZON_H = 72;

const IV_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
const BAR_MS = IV_MS[INTERVAL] || 300_000;

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** ATR(14) по часовым барам, собранным из свечей до момента entryIdx. */
function atrPctAtEntry(rows, entryIdx) {
  const perHour = Math.max(1, 3_600_000 / BAR_MS);
  const hourly = [];
  for (let i = entryIdx - perHour * (ATR_PERIOD + 2); i < entryIdx; i += perHour) {
    if (i < 0) continue;
    const slice = rows.slice(i, i + perHour);
    if (!slice.length) continue;
    hourly.push({
      high: Math.max(...slice.map((r) => r[2])),
      low: Math.min(...slice.map((r) => r[3])),
      close: slice[slice.length - 1][4],
    });
  }
  if (hourly.length < ATR_PERIOD + 1) return null;
  let sum = 0;
  for (let i = 1; i < hourly.length; i++) {
    const tr = Math.max(
      hourly[i].high - hourly[i].low,
      Math.abs(hourly[i].high - hourly[i - 1].close),
      Math.abs(hourly[i].low - hourly[i - 1].close),
    );
    sum += tr;
  }
  const atr = sum / (hourly.length - 1);
  const last = hourly[hourly.length - 1].close;
  if (!(atr > 0) || !(last > 0)) return null;
  return (atr * STOP_ATR_MULT / last) * 100;
}

/** unrealized% для цены при данной стороне. */
const pnlPct = (side, entry, px) =>
  side === "short" ? ((entry - px) / entry) * 100 : ((px - entry) / entry) * 100;

/** Цена, при которой unrealized% равен заданному. */
const priceAtPct = (side, entry, pct) =>
  side === "short" ? entry * (1 - pct / 100) : entry * (1 + pct / 100);

/**
 * Прогон правил adopt по свечам.
 * @param mode 'pessimistic' | 'optimistic' — порядок экстремумов внутри бара
 */
function replayAdopt(trip, rows, entryIdx, stopPct, mode, { beEnabled = true } = {}) {
  const { side, entryPrice: entry } = trip;
  const stopPrice = priceAtPct(side, entry, -stopPct);
  const horizonEnd = trip.entryTime + HORIZON_H * 3600_000;

  let peak = 0;
  let beArmed = false;

  for (let i = entryIdx; i < rows.length; i++) {
    const [t, , h, l] = rows[i];
    if (t > horizonEnd) break;

    // Экстремум в пользу позы и против неё
    const favPx = side === "short" ? l : h;
    const advPx = side === "short" ? h : l;
    const favPct = pnlPct(side, entry, favPx);
    const advPct = pnlPct(side, entry, advPx);

    const applyFavourable = () => {
      if (favPct > peak) peak = favPct;
      if (peak >= BE_ARM_PCT) beArmed = true;
    };

    // Все сработавшие условия со СВОИМИ уровнями в unrealized%. Двигаясь против
    // позы, цена пересекает их сверху вниз — значит первым исполнится тот, чей
    // уровень ВЫШЕ. Порядок проверок в коде тут ни при чём: при падении с пика
    // +3% трейл (уровень +2.1%) срабатывает раньше стопа (−2%), и считать
    // наоборот — значит записать няньке чужой убыток.
    const firstTriggered = () => {
      const cands = [];
      if (advPct <= -stopPct) cands.push({ level: -stopPct, price: stopPrice, reason: "sl_trigger", t });
      if (beEnabled && beArmed && advPct <= BE_FLOOR_PCT) {
        cands.push({
          level: BE_FLOOR_PCT,
          price: priceAtPct(side, entry, BE_FLOOR_PCT),
          reason: "adopt_breakeven_ratchet",
          t,
        });
      }
      if (peak >= TRAIL_ARM_PCT) {
        const gb = peak * (1 - TRAIL_GIVEBACK_PCT / 100);
        if (gb > 0 && advPct <= gb) {
          cands.push({ level: gb, price: priceAtPct(side, entry, gb), reason: "adopt_trail_tp", t });
        }
      }
      if (!cands.length) return null;
      return cands.reduce((a, b) => (b.level > a.level ? b : a));
    };

    let exit;
    if (mode === "pessimistic") {
      // Ход против позы первым: условия считаются по СТАРОМУ пику, и только
      // потом пик обновляется — трейл не успевает подрасти на этом баре.
      exit = firstTriggered();
      if (!exit) applyFavourable();
    } else {
      // Ход в пользу позы первым: пик успевает вырасти, затем откат.
      applyFavourable();
      exit = firstTriggered();
    }
    if (exit) return exit;
  }

  // Ничего не сработало за горизонт — выходим по последней доступной цене.
  let last = null;
  for (let i = rows.length - 1; i >= entryIdx; i--) {
    if (rows[i][0] <= horizonEnd) {
      last = rows[i];
      break;
    }
  }
  if (!last) return null;
  return { price: last[4], reason: "horizon_cap", t: last[0] };
}

/** Цена на момент времени ts (последний бар не позже ts). */
function priceAt(rows, ts) {
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m][0] <= ts) {
      best = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return best >= 0 ? rows[best][4] : null;
}

const netPct = (gross) => gross - (2 * FEE_BP) / 100;

export function runReplay(tripsFile, { seed = 7 } = {}) {
  const { trips } = JSON.parse(readFileSync(tripsFile));
  const candleCache = new Map();
  // ГПСЧ общий с бейзлайном: свой LCG здесь терял младшие биты за 2⁵³ и повторял
  // значения (разбор в шапке rng() в baseline.mjs). Тут он выбирает случайный бар
  // выхода, то есть это выборка, а не косметика.
  const rnd = rng(seed);

  const out = [];
  const skips = { noCandles: 0, noEntryBar: 0, noReplay: 0 };

  for (const trip of trips) {
    if (!candleCache.has(trip.coin)) candleCache.set(trip.coin, loadCandles(trip.coin));
    const c = candleCache.get(trip.coin);
    if (!c || !c.rows?.length) {
      skips.noCandles++;
      continue;
    }
    const rows = c.rows;

    let entryIdx = rows.findIndex((r) => r[0] >= trip.entryTime);
    if (entryIdx < 0) {
      skips.noEntryBar++;
      continue;
    }
    // ATR нужен ДО входа; без истории — фолбэк на фикс-%, как в проде
    const atrPct = atrPctAtEntry(rows, entryIdx);
    const stopPct =
      atrPct == null ? STOP_FALLBACK_PCT : Math.min(STOP_MAX_PCT, Math.max(STOP_MIN_PCT, atrPct));

    const pess = replayAdopt(trip, rows, entryIdx, stopPct, "pessimistic");
    const opti = replayAdopt(trip, rows, entryIdx, stopPct, "optimistic");
    // Вариант без BE-храповика — предзаявленный вопрос «добавляет он или отнимает».
    // Считается в том же проходе, чтобы выборки совпадали побайтово.
    const pessNoBe = replayAdopt(trip, rows, entryIdx, stopPct, "pessimistic", { beEnabled: false });
    const optiNoBe = replayAdopt(trip, rows, entryIdx, stopPct, "optimistic", { beEnabled: false });
    if (!pess || !opti || !pessNoBe || !optiNoBe) {
      skips.noReplay++;
      continue;
    }

    // Их собственный выход — по цене на их метке времени (не по их filled px:
    // сравнивать надо на одном источнике цены, иначе разница поедет от спреда)
    const theirPx = priceAt(rows, trip.exitTime) ?? trip.exitPrice;

    // Бейзлайн «случайный выход»: равномерно между входом и их выходом
    const endIdx = Math.max(
      entryIdx,
      rows.findIndex((r) => r[0] >= Math.min(trip.exitTime, trip.entryTime + HORIZON_H * 3600_000)),
    );
    const rIdx = endIdx > entryIdx ? entryIdx + Math.floor(rnd() * (endIdx - entryIdx)) : entryIdx;
    const randomPx = rows[rIdx]?.[4] ?? theirPx;

    out.push({
      coin: trip.coin,
      side: trip.side,
      stopPct,
      theirPct: netPct(pnlPct(trip.side, trip.entryPrice, theirPx)),
      randomPct: netPct(pnlPct(trip.side, trip.entryPrice, randomPx)),
      minePessPct: netPct(pnlPct(trip.side, trip.entryPrice, pess.price)),
      mineOptiPct: netPct(pnlPct(trip.side, trip.entryPrice, opti.price)),
      noBePessPct: netPct(pnlPct(trip.side, trip.entryPrice, pessNoBe.price)),
      noBeOptiPct: netPct(pnlPct(trip.side, trip.entryPrice, optiNoBe.price)),
      reasonPess: pess.reason,
      reasonOpti: opti.reason,
      reasonNoBePess: pessNoBe.reason,
      holdTheirMin: (trip.exitTime - trip.entryTime) / 6e4,
      holdMineMin: (pess.t - trip.entryTime) / 6e4,
    });
  }
  return { rows: out, skips, n: out.length };
}

/** Парная статистика: разница на ОДНИХ И ТЕХ ЖЕ входах. */
export function pairedStats(rows, mineKey) {
  const diff = rows.map((r) => r[mineKey] - r.theirPct);
  const m = mean(diff);
  const s = sd(diff);
  const se = s / Math.sqrt(diff.length);
  // n для 80% мощности при alpha .05, чтобы поймать наблюдаемую разницу
  const nNeeded = m !== 0 ? Math.ceil(7.85 * (s / Math.abs(m)) ** 2) : Infinity;
  return {
    n: diff.length,
    meanDiff: m,
    medianDiff: median(diff),
    sdDiff: s,
    ci: [m - 1.96 * se, m + 1.96 * se],
    winShare: diff.filter((x) => x > 0).length / diff.length,
    nNeeded,
  };
}

function reasonBreakdown(rows, key) {
  const by = {};
  for (const r of rows) by[r[key]] = (by[r[key]] || 0) + 1;
  return by;
}

async function main() {
  const file = process.argv[2] || "data/borrowed/trips_15a_16d.json";
  const { rows, skips, n } = runReplay(file);
  console.log(`прогнано круговых: ${n} (пропущено: ${JSON.stringify(skips)})`);
  if (!n) return;

  const arms = [
    ["их собственный выход", "theirPct"],
    ["случайный выход", "randomPct"],
    ["МОИ правила (pessimistic)", "minePessPct"],
    ["МОИ правила (optimistic)", "mineOptiPct"],
  ];
  console.log("\nnet% на сделку (после комиссий, обе стороны):");
  for (const [label, key] of arms) {
    const v = rows.map((r) => r[key]);
    console.log(
      `  ${label.padEnd(28)} среднее ${mean(v).toFixed(3).padStart(7)}%  медиана ${median(v).toFixed(3).padStart(7)}%  доля>0 ${((v.filter((x) => x > 0).length / v.length) * 100).toFixed(0)}%`,
    );
  }

  console.log("\nПАРНАЯ разница (мои − их) на одних и тех же входах:");
  for (const [label, key] of [
    ["pessimistic", "minePessPct"],
    ["optimistic", "mineOptiPct"],
  ]) {
    const p = pairedStats(rows, key);
    console.log(
      `  ${label.padEnd(12)} среднее ${p.meanDiff.toFixed(3)}%  95% CI [${p.ci[0].toFixed(3)}; ${p.ci[1].toFixed(3)}]  sd ${p.sdDiff.toFixed(3)}  лучше в ${(p.winShare * 100).toFixed(0)}% сделок`,
    );
    console.log(`               n для 80% мощности на такой эффект: ${Number.isFinite(p.nNeeded) ? p.nNeeded.toLocaleString("ru") : "∞"}`);
  }

  console.log("\nпричины выхода (pessimistic):", JSON.stringify(reasonBreakdown(rows, "reasonPess")));
  console.log("причины выхода (optimistic):  ", JSON.stringify(reasonBreakdown(rows, "reasonOpti")));
  console.log(
    `\nдержание: их медиана ${median(rows.map((r) => r.holdTheirMin)).toFixed(0)} мин, мои ${median(rows.map((r) => r.holdMineMin)).toFixed(0)} мин`,
  );
}

if (process.argv[1]?.endsWith("borrowedEntriesReplay.mjs")) await main();
