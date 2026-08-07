// ─────────────────────────────────────────────────
//  oiHypotheses — гипотезы на данных, которых нет в цене
// ─────────────────────────────────────────────────
// Всё, что проверялось раньше (вход, отбор монеты, сопровождение, копирование),
// было функцией цены — а цена, естественно, уже в цене. OI и funding — то
// немногое, что мы собираем и что ценой не является. Это последний
// неисследованный класс.
//
// ⚠️ Данные покрывают 12.07–07.08.2026, и весь этот период — боковик
// (BTC в диапазоне 62.8k–66.5k, все 8-дневные отрезки между −2.1% и +2.3%).
// Второго режима внутри данных НЕТ. Поэтому любой результат здесь может быть
// только ПРЕДВАРИТЕЛЬНЫМ: подтверждение возможно лишь когда рынок сменит режим
// и коллектор наберёт данные. Это и есть holdout — его физически ещё не
// существует, подсмотреть невозможно.
//
// usage: BORROWED_INTERVAL=15m node tools/oiHypotheses.mjs [--fetch-candles]

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { preregister, run, report, loadRegistry } from "./harness.mjs";
import { ensureCandles, loadCandles } from "./borrowedEntriesCandles.mjs";

const HOUR = 3600_000;

// ── загрузка рядов ──
function loadSeries() {
  const files = ["oi-2026-07.jsonl", "oi-2026-08.jsonl"]
    .map((f) => join("data", "oi-collector", f))
    .filter(existsSync);
  if (!files.length) throw new Error("нет данных OI-коллектора");

  const byCoin = new Map(); // coin -> [{t, oi, f, px, v}]
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const t = j.t;
      for (const [coin, d] of Object.entries(j.d || {})) {
        if (!(d.px > 0) || !(d.oi > 0)) continue;
        if (!byCoin.has(coin)) byCoin.set(coin, []);
        byCoin.get(coin).push({ t, oi: d.oi, f: d.f ?? 0, px: d.px, v: d.v ?? 0 });
      }
    }
  }
  for (const arr of byCoin.values()) arr.sort((a, b) => a.t - b.t);
  return byCoin;
}

/** Значение ряда за lag мс до индекса i (ближайшее не позже). */
function back(arr, i, lagMs) {
  const target = arr[i].t - lagMs;
  for (let j = i; j >= 0; j--) {
    if (arr[j].t <= target) return arr[j];
  }
  return null;
}

/** Перцентиль значения x в отсортированном массиве. */
function pct(sortedArr, x) {
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sortedArr[m] < x) lo = m + 1; else hi = m;
  }
  return lo / sortedArr.length;
}

// ── гипотезы ──
// Каждая: {id, description, condition, side, holdMin, rationale, test(ctx)}
// test получает контекст точки ряда и возвращает true/false.
const HYPOTHESES = [
  {
    id: "oi-up-px-flat",
    description: "OI вырос ≥3% за час при неподвижной цене (±0.5%) → шорт на 4ч",
    condition: "oi_chg_1h >= 3% AND |px_chg_1h| <= 0.5%",
    side: "short",
    holdMin: 240,
    rationale:
      "Набор плеча без движения цены — чаще лонговое накопление (funding на HL исторически положительный). Такая позиция уязвима к сквизу вниз.",
    test: (c) => c.oiChg1h >= 3 && Math.abs(c.pxChg1h) <= 0.5,
  },
  {
    id: "funding-extreme",
    description: "Funding в верхних 5% собственного распределения монеты → шорт на 4ч",
    condition: "funding_percentile >= 0.95",
    side: "short",
    holdMin: 240,
    rationale:
      "Перегретые лонги платят за удержание. Если в фандинге есть предсказание, экстремум должен возвращаться к среднему движением цены вниз.",
    test: (c) => c.fPct >= 0.95,
  },
  {
    id: "oi-drop-px-drop",
    description: "OI упал ≥5% за час И цена упала ≥2% (форсированный делевередж) → лонг на 4ч",
    condition: "oi_chg_1h <= -5% AND px_chg_1h <= -2%",
    side: "long",
    holdMin: 240,
    rationale:
      "Каскад ликвидаций продаёт по любой цене, а не по справедливой. Если дислокация есть, она должна откупаться.",
    test: (c) => c.oiChg1h <= -5 && c.pxChg1h <= -2,
  },
  {
    id: "oi-px-divergence",
    description: "OI вырос ≥2% за 4ч при падении цены ≥1% → шорт на 4ч",
    condition: "oi_chg_4h >= 2% AND px_chg_4h <= -1%",
    side: "short",
    holdMin: 240,
    rationale:
      "Растущий OI на падающей цене = набор шортов, а не закрытие лонгов. Если это признак продолжения тренда, шорт должен работать.",
    test: (c) => c.oiChg4h >= 2 && c.pxChg4h <= -1,
  },
];

// ── построение событий ──
function buildEvents(byCoin, hyp, { from, to }) {
  const events = [];
  for (const [coin, arr] of byCoin) {
    if (arr.length < 20) continue;
    // Распределение фандинга монеты — для перцентильных условий
    const fSorted = arr.map((x) => x.f).sort((a, b) => a - b);

    let lastEntry = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      if (cur.t < from || cur.t > to) continue;
      // Перекрывающиеся события не независимы: без остывания на длину сделки
      // одно и то же движение попадёт в выборку десяток раз и раздует n.
      if (cur.t - lastEntry < hyp.holdMin * 60_000) continue;

      const h1 = back(arr, i, HOUR);
      const h4 = back(arr, i, 4 * HOUR);
      if (!h1 || !h4) continue;

      const ctx = {
        oiChg1h: ((cur.oi - h1.oi) / h1.oi) * 100,
        pxChg1h: ((cur.px - h1.px) / h1.px) * 100,
        oiChg4h: ((cur.oi - h4.oi) / h4.oi) * 100,
        pxChg4h: ((cur.px - h4.px) / h4.px) * 100,
        fPct: pct(fSorted, cur.f),
        v: cur.v,
      };
      if (!Number.isFinite(ctx.oiChg1h) || !Number.isFinite(ctx.pxChg1h)) continue;
      // Пыль отсекаем: на монете без оборота «эдж» будет спредом, а не эджем
      if (ctx.v < 1e6) continue;

      if (hyp.test(ctx)) {
        events.push({ coin, side: hyp.side, entryTime: cur.t, holdMin: hyp.holdMin });
        lastEntry = cur.t;
      }
    }
  }
  return events;
}

// ── main ──
const doFetch = process.argv.includes("--fetch-candles");
const byCoin = loadSeries();
console.log(`OI-ряды: ${byCoin.size} монет`);

const WINDOW = { from: Date.parse("2026-07-12T10:00:00Z"), to: Date.parse("2026-08-07T19:00:00Z") };
console.log(`окно: ${new Date(WINDOW.from).toISOString().slice(0, 10)} → ${new Date(WINDOW.to).toISOString().slice(0, 10)} (боковик, BTC ±3%)\n`);

// 1. Предзаявление — до любого взгляда на результат
const reg = loadRegistry();
for (const h of HYPOTHESES) {
  if (reg.hypotheses.some((x) => x.id === h.id)) {
    console.log(`  ${h.id} — уже зарегистрирована ранее`);
    continue;
  }
  preregister({
    id: h.id,
    description: h.description,
    condition: h.condition,
    side: h.side,
    holdMin: h.holdMin,
    rationale: h.rationale,
  });
  console.log(`  ✓ предзаявлена: ${h.id}`);
}

// 2. События
const built = HYPOTHESES.map((h) => ({ h, events: buildEvents(byCoin, h, WINDOW) }));
console.log("\nсобытий по гипотезам:");
for (const { h, events } of built) console.log(`  ${h.id.padEnd(20)} ${events.length}`);

// 3. Свечи под монеты, которые реально дали события
if (doFetch) {
  const need = new Map();
  for (const { events } of built) {
    for (const e of events) {
      const from = e.entryTime - 26 * HOUR;
      const to = e.entryTime + (e.holdMin + 60) * 60_000;
      const cur = need.get(e.coin) || { from, to };
      cur.from = Math.min(cur.from, from);
      cur.to = Math.max(cur.to, to);
      need.set(e.coin, cur);
    }
  }
  console.log(`\nдогружаю свечи: ${need.size} монет`);
  let i = 0;
  for (const [coin, w] of need) {
    i++;
    try {
      const c = await ensureCandles(coin, w.from, w.to);
      process.stdout.write(`\r  [${i}/${need.size}] ${coin.padEnd(10)} ${c.rows.length} свечей     `);
    } catch (e) {
      console.log(`\n  ${coin}: ${e.message}`);
    }
  }
  console.log("\nсвечи готовы");
}

// 4. Прогон
console.log("\n─── прогон (бейзлайн обязателен) ───");
for (const { h, events } of built) {
  const usable = events.filter((e) => loadCandles(e.coin)?.rows?.length);
  const rec = run(h.id, usable, { window: "2026-07-12..08-07", regime: "боковик (BTC ±3%)", k: 200 });
  const t = rec.results?.time;
  if (!t || t.error) {
    console.log(`  ${h.id.padEnd(20)} ${rec.note || t?.error || "нет результата"}`);
    continue;
  }
  console.log(
    `  ${h.id.padEnd(20)} n=${String(t.n).padStart(4)}  реально ${t.actual.toFixed(3)}%  случайно ${t.surrogateMean.toFixed(3)}%  p=${t.p.toFixed(4)}`,
  );
}

console.log("\n═══ РЕЕСТР ═══");
console.log(report());
