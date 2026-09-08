// ─────────────────────────────────────────────────────────────────────────────
//  carryProbe — замер направленного carry на часовом фандинге HL
//
//  ПРЕДЗАЯВКА (08.09.2026, до первого прогона):
//
//  ГИПОТЕЗА. Шорт монеты с самым высоким фандингом, БЕЗ хеджа, даёт
//  положительное ожидание после комиссий. Формулировка оператора: «единственный
//  риск — если цена пойдёт не в мою сторону».
//
//  ПРАВИЛО РЕШЕНИЯ. Гипотеза принимается, только если среднее net на сделку > 0
//  И нижняя граница 95% CI > 0. CI кластерный по монете (бутстрап по монетам, не
//  по сделкам): входы одной монеты в соседние дни — не независимые наблюдения,
//  и обычный CI на них врёт в разы.
//
//  ЧТО СЧИТАЕТСЯ на сделку, в долях нотионала:
//    funding = Σ часовых ставок за время держания (шорт получает при положительной)
//    price   = −(P_выход − P_вход) / P_вход
//    fees    = 2 × 4.5 бп (тейкер обеими ногами — как торгует бот сейчас)
//    net     = funding + price − fees
//
//  БЕЙЗЛАЙНЫ, без них вердикта нет:
//    1. funding-only (price ≡ 0) — потолок: сколько дал бы ИДЕАЛЬНЫЙ хедж;
//    2. price-only (funding ≡ 0) — есть ли направленный эдж в шорте таких монет;
//    3. random — та же механика, но монета выбирается случайно, не по фандингу.
//
//  СТОП-ПРАВИЛО. Смотрим ОДИН раз, на всём окне. Параметры (K=3 монеты, горизонты
//  1/3/7 суток, окно ранжирования 24ч, комиссия 4.5 бп) заморожены ДО прогона;
//  подбирать их после просмотра результата запрещено — это и есть подгонка.
//
//  Запуск: node tools/carryProbe.mjs <каталог с <COIN>.json>
//  Формат входа: { coin, funding: [[ms, rate]…], candles: [[ms, close]…] }
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs';

const DIR = process.argv[2];
if (!DIR) { console.error('нужен каталог с данными'); process.exit(1); }

const P = Object.freeze({
  TOP_K: 3,            // сколько монет берём из верха рейтинга фандинга
  RANK_HOURS: 24,      // окно, по которому считается «высокий фандинг»
  HORIZONS_D: [1, 3, 7],
  FEE_BP: 4.5,         // тейкер, одна нога
  STEP_H: 24,          // как часто входим
  BOOT: 2000,
});

const HOUR = 3_600_000;

// ── Данные ──────────────────────────────────────────────────────────────────
const coins = new Map();
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
  if (!j.candles?.length || !j.funding?.length) continue;
  const px = new Map(j.candles.map(([t, c]) => [Math.floor(t / HOUR), c]));
  const fr = new Map(j.funding.map(([t, r]) => [Math.floor(t / HOUR), r]));
  if (px.size < 2800) continue;
  coins.set(j.coin, { px, fr });
}
const hours = [...coins.values()][0].px.keys();
let hMin = Infinity, hMax = -Infinity;
for (const { px } of coins.values()) for (const h of px.keys()) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
console.log(`монет ${coins.size} | окно ${((hMax - hMin) / 24).toFixed(0)} суток\n`);
void hours;

/** Σ ставок фандинга за [h0, h1). Null, если в окне есть дыры. */
function fundingSum(c, h0, h1) {
  let s = 0;
  for (let h = h0; h < h1; h++) {
    const r = c.fr.get(h);
    if (r == null) return null;
    s += r;
  }
  return s;
}

// ── Сделки ──────────────────────────────────────────────────────────────────
// Вход раз в STEP_H часов: ранжируем монеты по среднему фандингу за прошедшие
// RANK_HOURS, шортим топ-K, держим горизонт, закрываем. Случайный бейзлайн берёт
// монету из той же выборки, но без взгляда на фандинг.
function buildTrades(horizonD, pick = 'top') {
  const hold = horizonD * 24;
  const out = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let h = hMin + P.RANK_HOURS; h + hold <= hMax; h += P.STEP_H) {
    const ranked = [];
    for (const [name, c] of coins) {
      const past = fundingSum(c, h - P.RANK_HOURS, h);
      if (past == null || c.px.get(h) == null || c.px.get(h + hold) == null) continue;
      ranked.push({ name, c, score: past / P.RANK_HOURS });
    }
    if (ranked.length < P.TOP_K) continue;
    let chosen;
    if (pick === 'top') {
      ranked.sort((a, b) => b.score - a.score);
      chosen = ranked.slice(0, P.TOP_K);
    } else {
      chosen = [];
      const pool = ranked.slice();
      for (let i = 0; i < P.TOP_K && pool.length; i++) chosen.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    for (const { name, c } of chosen) {
      const funding = fundingSum(c, h, h + hold);
      if (funding == null) continue;
      const p0 = c.px.get(h), p1 = c.px.get(h + hold);
      const price = -(p1 - p0) / p0;               // шорт
      const fees = (2 * P.FEE_BP) / 10_000;
      out.push({ coin: name, funding, price, fees, net: funding + price - fees });
    }
  }
  return out;
}

// ── Кластерный бутстрап по монетам ──────────────────────────────────────────
function clusteredCI(trades, key) {
  const byCoin = new Map();
  for (const t of trades) {
    if (!byCoin.has(t.coin)) byCoin.set(t.coin, []);
    byCoin.get(t.coin).push(t[key]);
  }
  const clusters = [...byCoin.values()];
  const means = [];
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let b = 0; b < P.BOOT; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < clusters.length; i++) {
      const cl = clusters[Math.floor(rnd() * clusters.length)];
      for (const v of cl) { sum += v; n++; }
    }
    if (n) means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(P.BOOT * 0.025)], means[Math.floor(P.BOOT * 0.975)]];
}

const bp = (x) => (x * 10_000).toFixed(1);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

for (const D of P.HORIZONS_D) {
  const top = buildTrades(D, 'top');
  const rnd = buildTrades(D, 'random');
  const rows = [];
  const add = (label, trades, key) => {
    const vals = trades.map((t) => t[key]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const [lo, hi] = clusteredCI(trades, key);
    rows.push({
      вариант: label, n: vals.length,
      'ср, бп': bp(mean), 'медиана, бп': bp(median(vals)),
      'CI95 низ': bp(lo), 'CI95 верх': bp(hi),
      'выигрышных': `${((vals.filter((v) => v > 0).length / vals.length) * 100).toFixed(0)}%`,
    });
  };
  add('carry net (гипотеза)', top, 'net');
  add('только фандинг (идеальный хедж)', top, 'funding');
  add('только цена (без фандинга)', top, 'price');
  add('случайная монета, net', rnd, 'net');
  console.log(`── горизонт ${D} сут ──`);
  console.table(rows);

  // Ради чего всё: во сколько раз ход цены больше дохода от фандинга.
  const f = top.map((t) => Math.abs(t.funding));
  const p = top.map((t) => Math.abs(t.price));
  console.log(
    `медиана |фандинг| ${bp(median(f))} бп vs медиана |ход цены| ${bp(median(p))} бп ` +
    `→ цена крупнее в ${(median(p) / median(f)).toFixed(0)}×, комиссия ${2 * P.FEE_BP} бп\n`,
  );
}
