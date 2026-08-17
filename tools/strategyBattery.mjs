// ─────────────────────────────────────────────────
//  strategyBattery — 15 публичных стратегий на наших данных
// ─────────────────────────────────────────────────
// Предзаявлено как public-strategy-battery-2026-08 (17.08.2026).
//
// ── Зачем чужие стратегии, а не свои ───────────────────────────────────────
// Главным источником ложных находок 17.08 были НАШИ степени свободы, а не рынок:
// три нулевые модели подряд оказались бракованными, дециль/горизонты/фильтры
// выбирал я, и каждый выбор был возможностью себя обмануть (сетка дала 42
// «значимых» ячейки из 48; post-hoc фильтр по обороту выдал +648бп на n=282).
// У публичной стратегии пороги 20/55, RSI 30/70, MACD 12/26/9 зафиксированы
// литературой десятилетия назад и к нашим данным не подгонялись. Это
// единственное известное преимущество чужой спецификации над своей.
//
// ⚠️ Ожидание ОТРИЦАТЕЛЬНОЕ и записано в реестр ДО прогона: публичные стратегии —
// самый переторгованный класс идей. Ценность здесь в чистоте результата, не в
// надежде.
//
// ── Дырка в предзаявлении, названная вслух ─────────────────────────────────
// 🚨 В условии гипотезы НЕ зафиксирован горизонт оценки — только «оценка на
// баре, без стопов и трейлов». Это моя недоработка. Горизонт зафиксирован
// здесь как 30 баров (5 дней на 4h) по единственной причине: он УЖЕ стоит в
// реестре с прогона grid-scan-4h. Несколько горизонтов не пробуются — это
// размножило бы тесты и обнулило поправку на множественность.
//
// ── Нулевая модель ─────────────────────────────────────────────────────────
// Случайный выбор монет В ТОТ ЖЕ МОМЕНТ, с сохранением ЧИСЛА срабатываний на
// каждую метку времени. Так вычитается всё общее — движение рынка, время суток,
// кучность сигналов, режим — и остаётся один вопрос: выбрала ли стратегия
// монеты лучше жребия.
// Почему не «случайный момент»: 17.08 доказано, что перенос событий во времени
// независимо друг от друга разрушает кросс-секционную связку и завышает
// значимость (17 «значимых» ячеек из 48 на пустых данных).
//
// Перекрытие окон НЕ подавляется: оно устроено одинаково у реальности и у
// суррогата (число срабатываний на метку совпадает), поэтому в сравнении
// сокращается.
//
// Запуск: node tools/strategyBattery.mjs [--k 500]

import { loadGridCandles, gridCoins } from "./gridData.mjs";
import { loadRegistry } from "./harness.mjs";

const INTERVAL = "4h";
const BAR_MS = 14_400_000;
const HORIZON = 30;          // баров, см. оговорку про дырку в предзаявлении
const WARMUP = 210;          // SMA200 + запас
const MIN_COINS_PER_TS = 30;
const DECILE = 0.1;
const HYP_ID = "public-strategy-battery-2026-08";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const K = Number(argVal("--k", 500));

// ── Индикаторы ──────────────────────────────────────────────────────────────
// rows: [t, o, h, l, c, v, n]

const C = (r) => r[4], H = (r) => r[2], L = (r) => r[3], O = (r) => r[1];

function sma(rows, i, n, pick = C) {
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += pick(rows[j]);
  return s / n;
}
function emaSeries(rows, n, pick = C) {
  const k = 2 / (n + 1);
  const out = new Array(rows.length).fill(NaN);
  let e = pick(rows[0]);
  out[0] = e;
  for (let i = 1; i < rows.length; i++) { e = pick(rows[i]) * k + e * (1 - k); out[i] = e; }
  return out;
}
function trSeries(rows) {
  const tr = new Array(rows.length).fill(NaN);
  for (let i = 1; i < rows.length; i++) {
    const pc = C(rows[i - 1]);
    tr[i] = Math.max(H(rows[i]) - L(rows[i]), Math.abs(H(rows[i]) - pc), Math.abs(L(rows[i]) - pc));
  }
  return tr;
}
function atrAt(tr, i, n) {
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += tr[j];
  return s / n;
}
/** RSI по Уайлдеру (сглаженный), полный ряд. */
function rsiSeries(rows, n) {
  const out = new Array(rows.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = C(rows[i]) - C(rows[i - 1]);
    if (d > 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < rows.length; i++) {
    const d = C(rows[i]) - C(rows[i - 1]);
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function stdev(rows, i, n) {
  const m = sma(rows, i, n);
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += (C(rows[j]) - m) ** 2;
  return Math.sqrt(s / n);
}
function highest(rows, i, n, from = 1) {
  let m = -Infinity;
  for (let j = i - n - from + 1; j <= i - from; j++) if (H(rows[j]) > m) m = H(rows[j]);
  return m;
}
function lowestLow(rows, i, n) {
  let m = Infinity;
  for (let j = i - n + 1; j <= i; j++) if (L(rows[j]) < m) m = L(rows[j]);
  return m;
}
function highestHigh(rows, i, n) {
  let m = -Infinity;
  for (let j = i - n + 1; j <= i; j++) if (H(rows[j]) > m) m = H(rows[j]);
  return m;
}
/** Баров назад до максимума/минимума за n — для Aroon. */
function barsSinceExtreme(rows, i, n, isHigh) {
  let best = isHigh ? -Infinity : Infinity, at = i;
  for (let j = i - n + 1; j <= i; j++) {
    const v = isHigh ? H(rows[j]) : L(rows[j]);
    if (isHigh ? v > best : v < best) { best = v; at = j; }
  }
  return i - at;
}

/**
 * Булев ряд срабатывания для каждой стратегии. Кросс-секционные (mom-12-1,
 * rev-1-1) считаются отдельно — им нужен срез рынка, а не одна монета.
 */
function perCoinSignals(rows) {
  const N = rows.length;
  const tr = trSeries(rows);
  const rsi2 = rsiSeries(rows, 2);
  const rsi14 = rsiSeries(rows, 14);
  const ema12 = emaSeries(rows, 12);
  const ema26 = emaSeries(rows, 26);
  const ema20 = emaSeries(rows, 20);
  const macd = ema12.map((v, i) => v - ema26[i]);
  // сигнальная линия = EMA9 от macd
  const sig = (() => {
    const k = 2 / 10, out = new Array(N).fill(NaN);
    let e = macd[26] || 0;
    for (let i = 26; i < N; i++) { e = macd[i] * k + e * (1 - k); out[i] = e; }
    return out;
  })();

  const out = {};
  const names = ["donchian-20", "donchian-55", "sma-50-200", "bb-2-20", "rsi2-10-60",
    "rsi14-30-70", "macd-12-26-9", "keltner-20-2", "atr-chan-20", "aroon-25",
    "cci-20-100", "willr-14", "stoch-14-3"];
  for (const n of names) out[n] = new Array(N).fill(false);

  for (let i = WARMUP; i < N; i++) {
    const c = C(rows[i]);
    if (!(c > 0)) continue;

    out["donchian-20"][i] = c > highest(rows, i, 20);
    out["donchian-55"][i] = c > highest(rows, i, 55);
    out["sma-50-200"][i] = sma(rows, i, 50) > sma(rows, i, 200);

    const m20 = sma(rows, i, 20), sd20 = stdev(rows, i, 20);
    out["bb-2-20"][i] = c < m20 - 2 * sd20;

    out["rsi2-10-60"][i] = rsi2[i] < 10;
    out["rsi14-30-70"][i] = rsi14[i] < 30;
    out["macd-12-26-9"][i] = macd[i] > sig[i] && macd[i - 1] <= sig[i - 1];

    const atr20 = atrAt(tr, i, 20);
    out["keltner-20-2"][i] = c > ema20[i] + 2 * atr20;
    out["atr-chan-20"][i] = c > m20 + 2 * atrAt(tr, i, 14);

    const upNow = 100 * (25 - barsSinceExtreme(rows, i, 25, true)) / 25;
    const dnNow = 100 * (25 - barsSinceExtreme(rows, i, 25, false)) / 25;
    const upPrev = 100 * (25 - barsSinceExtreme(rows, i - 1, 25, true)) / 25;
    const dnPrev = 100 * (25 - barsSinceExtreme(rows, i - 1, 25, false)) / 25;
    out["aroon-25"][i] = upNow > dnNow && upPrev <= dnPrev;

    // CCI(20) на типичной цене
    const tp = (j) => (H(rows[j]) + L(rows[j]) + C(rows[j])) / 3;
    let tpm = 0;
    for (let j = i - 19; j <= i; j++) tpm += tp(j);
    tpm /= 20;
    let md = 0;
    for (let j = i - 19; j <= i; j++) md += Math.abs(tp(j) - tpm);
    md /= 20;
    out["cci-20-100"][i] = md > 0 && (tp(i) - tpm) / (0.015 * md) > 100;

    const hh14 = highestHigh(rows, i, 14), ll14 = lowestLow(rows, i, 14);
    const wr = hh14 > ll14 ? -100 * (hh14 - c) / (hh14 - ll14) : NaN;
    out["willr-14"][i] = wr < -80;

    // Стохастик %K(14) со сглаживанием 3, условие «<20 и растёт»
    const kRaw = (j) => {
      const hh = highestHigh(rows, j, 14), ll = lowestLow(rows, j, 14);
      return hh > ll ? 100 * (C(rows[j]) - ll) / (hh - ll) : NaN;
    };
    const k3 = (kRaw(i) + kRaw(i - 1) + kRaw(i - 2)) / 3;
    const k3p = (kRaw(i - 1) + kRaw(i - 2) + kRaw(i - 3)) / 3;
    out["stoch-14-3"][i] = k3 < 20 && k3 > k3p;
  }
  return out;
}

// ── Загрузка ────────────────────────────────────────────────────────────────

const reg = loadRegistry();
if (!reg.hypotheses.some((h) => h.id === HYP_ID)) {
  console.error(`гипотеза «${HYP_ID}» не зарегистрирована`);
  process.exit(1);
}

console.log(`загружаю свечи ${INTERVAL}…`);
const panel = new Map();
for (const coin of gridCoins(INTERVAL)) {
  const d = loadGridCandles(coin, INTERVAL);
  if (!d?.rows?.length || d.rows.length < WARMUP + 200) continue;
  const idxByTs = new Map();
  d.rows.forEach((r, i) => idxByTs.set(r[0], i));
  panel.set(coin, { rows: d.rows, idxByTs, sig: perCoinSignals(d.rows) });
}
console.log(`монет: ${panel.size}`);

const allTs = [...new Set([...panel.values()].flatMap((p) => p.rows.map((r) => r[0])))].sort((a, b) => a - b);

// Ось режимов: BTC выше/ниже 200-дневной SMA. Механическая, объявлена заранее.
const regimeLabels = (() => {
  const btc = panel.get("BTC");
  if (!btc) return null;
  const per200 = Math.round((200 * 864e5) / BAR_MS);
  if (btc.rows.length < per200 + 50) return null;
  const m = new Map();
  let s = 0;
  for (let i = 0; i < btc.rows.length; i++) {
    s += C(btc.rows[i]);
    if (i >= per200) s -= C(btc.rows[i - per200]);
    if (i < per200) continue;
    m.set(btc.rows[i][0], C(btc.rows[i]) >= s / per200 ? "рост" : "падение");
  }
  return m;
})();

// ── Срезы: доступные монеты и их форвардная доходность на каждую метку ──────

const slices = [];
for (const ts of allTs) {
  const items = [];
  for (const [coin, p] of panel) {
    const i = p.idxByTs.get(ts);
    if (i === undefined || i < WARMUP || i + HORIZON >= p.rows.length) continue;
    const a = C(p.rows[i]), b = C(p.rows[i + HORIZON]);
    if (!(a > 0) || !(b > 0)) continue;
    items.push({ coin, i, fwd: (b - a) / a, p });
  }
  if (items.length < MIN_COINS_PER_TS) continue;
  slices.push({ ts, items });
}
console.log(`срезов: ${slices.length}, горизонт ${HORIZON} баров (${(HORIZON * BAR_MS / 864e5).toFixed(0)} дней)\n`);

// ── Отбор ───────────────────────────────────────────────────────────────────

const PER_COIN = ["donchian-20", "donchian-55", "sma-50-200", "bb-2-20", "rsi2-10-60",
  "rsi14-30-70", "macd-12-26-9", "keltner-20-2", "atr-chan-20", "aroon-25",
  "cci-20-100", "willr-14", "stoch-14-3"];
const CROSS = ["mom-12-1", "rev-1-1"];
const ALL = [...PER_COIN, ...CROSS];

/** Отобранные (по стратегии) элементы среза. */
function pick(items, strat) {
  if (strat === "mom-12-1" || strat === "rev-1-1") {
    const vals = [];
    for (const it of items) {
      const lag = strat === "mom-12-1" ? 12 : 1;
      const prev = C(it.p.rows[it.i - lag]);
      if (prev > 0) vals.push({ ...it, v: (C(it.p.rows[it.i]) - prev) / prev });
    }
    if (vals.length < MIN_COINS_PER_TS) return [];
    vals.sort((a, b) => a.v - b.v);
    const cut = Math.max(1, Math.floor(vals.length * DECILE));
    return strat === "mom-12-1" ? vals.slice(-cut) : vals.slice(0, cut);
  }
  return items.filter((it) => it.p.sig[strat][it.i]);
}

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Реальное среднее и распределение при случайном отборе с ТЕМ ЖЕ числом монет
 * на каждую метку времени.
 */
function test(subset, strat, k, seed) {
  const counts = [];
  let sum = 0, n = 0;
  for (const { items } of subset) {
    const sel = pick(items, strat);
    if (!sel.length) { counts.push(0); continue; }
    counts.push(sel.length);
    for (const x of sel) { sum += x.fwd; n++; }
  }
  if (n < 100) return null;
  const actual = sum / n;

  const rnd = makeRng(seed);
  const surr = [];
  for (let j = 0; j < k; j++) {
    let s2 = 0, n2 = 0;
    for (let si = 0; si < subset.length; si++) {
      const cnt = counts[si];
      if (!cnt) continue;
      const items = subset[si].items;
      const used = new Set();
      let got = 0;
      while (got < cnt && used.size < items.length) {
        const r = Math.floor(rnd() * items.length);
        if (used.has(r)) continue;
        used.add(r); s2 += items[r].fwd; n2++; got++;
      }
    }
    if (n2) surr.push(s2 / n2);
  }
  if (surr.length < 30) return null;
  const sMean = surr.reduce((a, b) => a + b, 0) / surr.length;
  const dev = Math.abs(actual - sMean);
  const extreme = surr.filter((x) => Math.abs(x - sMean) >= dev).length;
  return { n, edgeBp: (actual - sMean) * 10_000, p: (1 + extreme) / (surr.length + 1) };
}

// ── Прогон ──────────────────────────────────────────────────────────────────

const mid = Math.floor(slices.length / 2);
const halves = [slices.slice(0, mid), slices.slice(mid)];
const byRegime = {};
if (regimeLabels) {
  for (const rg of ["рост", "падение"]) {
    byRegime[rg] = slices.filter((s) => regimeLabels.get(s.ts) === rg);
  }
}

const results = [];
for (let i = 0; i < ALL.length; i++) {
  const strat = ALL[i];
  process.stdout.write(`\r[${i + 1}/${ALL.length}] ${strat.padEnd(16)} считаю…      `);
  const full = test(slices, strat, K, 11 + i);
  if (!full) { results.push({ strat, note: "мало срабатываний" }); continue; }
  const r = { strat, ...full, regimes: {}, halves: [] };
  for (const rg of Object.keys(byRegime)) {
    if (byRegime[rg].length < 50) continue;
    const t = test(byRegime[rg], strat, Math.min(K, 300), 31 + i);
    if (t) r.regimes[rg] = t;
  }
  for (let hh = 0; hh < 2; hh++) {
    const t = test(halves[hh], strat, Math.min(K, 300), 51 + i + hh);
    r.halves.push(t);
  }
  results.push(r);
}
console.log("\n");

// ── Вывод ───────────────────────────────────────────────────────────────────

const scored = results.filter((r) => r.p != null).sort((a, b) => a.p - b.p);
const m = results.length, q = 0.1;
let kMax = 0;
scored.forEach((r, i) => { if (r.p <= ((i + 1) / m) * q) kMax = i + 1; });
const thr = kMax ? (kMax / m) * q : null;

const sgn = (x) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`);

console.log(`  БАТАРЕЯ ПУБЛИЧНЫХ СТРАТЕГИЙ — ${panel.size} монет, ${INTERVAL}, ${slices.length} срезов`);
console.log(`  горизонт ${HORIZON} баров, нулевая модель: случайные монеты в тот же момент ×${K}\n`);
console.log(`  ${"стратегия".padEnd(16)} ${"n".padStart(7)} ${"эдж,бп".padStart(9)} ${"p".padStart(7)}  ${"рост".padStart(8)} ${"падение".padStart(9)}  ${"1-я пол".padStart(8)} ${"2-я пол".padStart(8)}`);
console.log(`  ${"─".repeat(88)}`);
for (const r of scored) {
  const up = r.regimes["рост"], dn = r.regimes["падение"];
  console.log(
    `  ${r.strat.padEnd(16)} ${String(r.n).padStart(7)} ${sgn(r.edgeBp).padStart(9)} ${r.p.toFixed(4).padStart(7)}` +
    `  ${(up ? sgn(up.edgeBp) : "—").padStart(8)} ${(dn ? sgn(dn.edgeBp) : "—").padStart(9)}` +
    `  ${(r.halves[0] ? sgn(r.halves[0].edgeBp) : "—").padStart(8)} ${(r.halves[1] ? sgn(r.halves[1].edgeBp) : "—").padStart(8)}`,
  );
}
const skipped = results.filter((r) => r.p == null);
if (skipped.length) console.log(`\n  без результата: ${skipped.map((s) => s.strat).join(", ")}`);

console.log(`\n  ── ПРЕДЗАЯВЛЕННЫЙ ПОРОГ: FDR q=0.1 И |эдж| ≥ 20бп И знак совпадает в обоих режимах и обеих половинах ──`);
console.log(`  порог FDR: p ≤ ${thr != null ? thr.toFixed(5) : "ни одна не прошла"}`);
const winners = (thr == null ? [] : scored.filter((r) => r.p <= thr))
  .filter((r) => Math.abs(r.edgeBp) >= 20)
  .filter((r) => {
    const up = r.regimes["рост"], dn = r.regimes["падение"];
    if (!up || !dn || !r.halves[0] || !r.halves[1]) return false;
    const s = Math.sign(r.edgeBp);
    return Math.sign(up.edgeBp) === s && Math.sign(dn.edgeBp) === s
      && Math.sign(r.halves[0].edgeBp) === s && Math.sign(r.halves[1].edgeBp) === s;
  });

if (!winners.length) {
  console.log(`\n  Ни одна стратегия не прошла все три условия. Ожидание, записанное ДО прогона, подтвердилось.`);
} else {
  console.log(`\n  🔬 ПРОШЛИ ВСЁ: ${winners.map((w) => `${w.strat} ${sgn(w.edgeBp)}бп`).join(", ")}`);
  console.log(`  Это право на форвардный holdout, НЕ статус «работает».`);
}
console.log("");
