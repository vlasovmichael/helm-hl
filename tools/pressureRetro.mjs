// ─────────────────────────────────────────────────────────────────────────────
//  Ретро-проверка flow-pressure-exhaustion на потоке, записанном ДО форварда.
//
//  Это инженерный sanity-check частоты и механики, а не результат holdout:
//  выборка короткая, а цены догружаются отдельно через candleSnapshot. Правило
//  сигнала импортируется из pressureForward.mjs, поэтому ретро и живой сборщик
//  не могут незаметно разойтись в формулах.
//
//  🚨 Расходятся ВХОДЫ, и цифры отсюда не сравнимы с форвардом почленно: цены
//  здесь — свечи биржи, у форварда — собственная агрегация трейдов; объём здесь
//  собран из flow, отфильтрованного FLOW_MIN_USD.
//
//  Запуск: node tools/pressureRetro.mjs [--db data/flow/flow.db] [--conc 6]
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { BAR_MS, PRESSURE_FORWARD, buildPressureSignal, fadeReturnBp } from './pressureForward.mjs';
import { clusterCi, stats } from './researchStats.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DB_PATH = arg('db', 'data/flow/flow.db');
const CONCURRENCY = Math.max(1, Number.parseInt(arg('conc', '6'), 10) || 6);
const API = 'https://api.hyperliquid.xyz/info';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function candles(coin, startTime, endTime) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval: '5m', startTime, endTime },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const rows = await response.json();
        if (Array.isArray(rows) && rows.length) return rows;
        lastError = new Error('пустой candleSnapshot');
      } else if (response.status !== 429) throw new Error(`HTTP ${response.status}`);
      else lastError = new Error('HTTP 429');
    } catch (error) {
      lastError = error;
    }
    await sleep(750 * (attempt + 1));
  }
  process.stderr.write(`\nнет свечей ${coin}: ${lastError?.message || 'unknown'}\n`);
  return [];
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

const mean = (rows) => rows.length
  ? rows.reduce((sum, row) => sum + row.fadeBp, 0) / rows.length
  : null;

function cohortSummary(rows, cohort) {
  const selected = rows.filter((row) => row.cohort === cohort);
  const values = selected.map((row) => row.fadeBp);
  const days = selected.map((row) => new Date(row.entryT).toISOString().slice(0, 10));
  return { cohort, ...stats(values), cluster: clusterCi(values, days) };
}

function comparison(rows) {
  const exhausted = rows.filter((row) => row.cohort === 'exhausted');
  const persistent = rows.filter((row) => row.cohort === 'persistent');
  const exhaustedMean = mean(exhausted);
  const persistentMean = mean(persistent);
  return {
    n: rows.length,
    exhausted: cohortSummary(rows, 'exhausted'),
    persistent: cohortSummary(rows, 'persistent'),
    deltaBp: exhaustedMean != null && persistentMean != null
      ? exhaustedMean - persistentMean
      : null,
  };
}

function groupComparisons(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([key, selected]) => [key, comparison(selected)]));
}

function withoutTopContributors(rows) {
  const baseDelta = comparison(rows).deltaBp;
  const coins = [...new Set(rows.map((row) => row.coin))];
  const impacts = coins.map((coin) => {
    const deltaWithout = comparison(rows.filter((row) => row.coin !== coin)).deltaBp;
    return {
      coin,
      contributionBp: baseDelta != null && deltaWithout != null ? baseDelta - deltaWithout : null,
    };
  }).filter((row) => Number.isFinite(row.contributionBp) && row.contributionBp > 0)
    .sort((a, b) => b.contributionBp - a.contributionBp);
  const removed = impacts.slice(0, 5).map((row) => row.coin);
  return {
    removed,
    impacts: impacts.slice(0, 5),
    result: comparison(rows.filter((row) => !removed.includes(row.coin))),
  };
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const range = db.prepare(`
  SELECT MIN(bar) AS firstBar, MAX(bar) AS lastBar,
         COUNT(DISTINCT bar) AS bars, COUNT(DISTINCT coin) AS coins
    FROM flow`).get();
if (!Number.isFinite(range.firstBar) || !Number.isFinite(range.lastBar)) {
  throw new Error('flow.db не содержит баров');
}

const flow = db.prepare(`
  SELECT f.bar, c.name AS coin,
         SUM(f.tbuy) AS tbuy, SUM(f.tsell) AS tsell
    FROM flow f JOIN coins c ON c.id = f.coin
   WHERE f.bar BETWEEN ? AND ?
   GROUP BY f.bar, f.coin
   ORDER BY c.name, f.bar`).all(range.firstBar, range.lastBar);
db.close();

const rawByCoin = new Map();
for (const row of flow) {
  if (!rawByCoin.has(row.coin)) rawByCoin.set(row.coin, []);
  rawByCoin.get(row.coin).push(row);
}
const canContainShock = (rows) => {
  for (let i = PRESSURE_FORWARD.shockBars - 1; i < rows.length; i++) {
    const window = rows.slice(i - PRESSURE_FORWARD.shockBars + 1, i + 1);
    if (window.some((row, j) => j && row.bar !== window[j - 1].bar + 1)) continue;
    const buy = window.reduce((sum, row) => sum + Number(row.tbuy), 0);
    const sell = window.reduce((sum, row) => sum + Number(row.tsell), 0);
    if (buy + sell >= PRESSURE_FORWARD.minShockUsd &&
        Math.abs((buy - sell) / (buy + sell)) >= PRESSURE_FORWARD.minShockImbalance) return true;
  }
  return false;
};
const eligibleCoins = [...rawByCoin]
  .filter(([, rows]) => canContainShock(rows))
  .map(([coin]) => coin);
const coins = [...new Set([...eligibleCoins, 'BTC'])];
const candleStart = range.firstBar * BAR_MS;
const candleEnd = (range.lastBar + PRESSURE_FORWARD.outcomeBars + 2) * BAR_MS;
const fetched = await mapLimit(coins, CONCURRENCY, async (coin, index) => {
  process.stderr.write(`\rHL 5m: ${index + 1}/${coins.length}   `);
  const start = coin === 'BTC' ? candleStart - 288 * BAR_MS : candleStart;
  return [coin, await candles(coin, start, candleEnd)];
});
process.stderr.write('\n');

const candleByCoin = new Map();
for (const [coin, rows] of fetched) {
  candleByCoin.set(coin, new Map(rows.map((row) => [Math.floor(Number(row.t) / BAR_MS), {
    bar: Math.floor(Number(row.t) / BAR_MS),
    o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c),
  }])));
}
const coinsWithoutCandles = [...candleByCoin]
  .filter(([, rows]) => rows.size === 0)
  .map(([coin]) => coin);

const flowByCoin = new Map();
for (const row of flow) {
  const price = candleByCoin.get(row.coin)?.get(row.bar);
  if (!price) continue;
  if (!flowByCoin.has(row.coin)) flowByCoin.set(row.coin, []);
  const tbuy = Number(row.tbuy);
  const tsell = Number(row.tsell);
  flowByCoin.get(row.coin).push({
    ...price, tbuy, tsell, volume: tbuy + tsell, fills: null,
  });
}

const events = [];
let signals = 0;
let missingOutcome = 0;
const params = { ...PRESSURE_FORWARD, startsAt: Number.NEGATIVE_INFINITY };
const need = params.shockBars + params.confirmBars;
const btc = candleByCoin.get('BTC') || new Map();

for (const [coin, rows] of flowByCoin) {
  rows.sort((a, b) => a.bar - b.bar);
  let previousSignal = Number.NEGATIVE_INFINITY;
  for (let i = need - 1; i < rows.length; i++) {
    const window = rows.slice(i - need + 1, i + 1);
    const signal = buildPressureSignal(window, params);
    if (!signal || signal.signalBar - previousSignal <= params.cooldownBars) continue;
    previousSignal = signal.signalBar;
    signals++;

    const entryBar = signal.signalBar + 1;
    const exitBar = entryBar + params.outcomeBars;
    const entry = candleByCoin.get(coin)?.get(entryBar);
    const exit = candleByCoin.get(coin)?.get(exitBar);
    if (!entry || !exit) { missingOutcome++; continue; }

    const btcNow = btc.get(signal.signalBar)?.c;
    const btcPrior = btc.get(signal.signalBar - 288)?.c;
    const btcRegime = btcNow > 0 && btcPrior > 0
      ? btcNow >= btcPrior ? 'btc_up' : 'btc_down'
      : null;
    events.push({
      coin, side: signal.side, cohort: signal.cohort,
      signalT: signal.signalBar * BAR_MS,
      entryT: entryBar * BAR_MS,
      fadeBp: fadeReturnBp(signal.side, entry.o, exit.c),
      btcRegime,
    });
  }
}

const byRegime = {};
for (const regime of ['btc_up', 'btc_down']) {
  byRegime[regime] = comparison(events.filter((row) => row.btcRegime === regime));
}
const coinCounts = new Map();
for (const event of events) coinCounts.set(event.coin, (coinCounts.get(event.coin) || 0) + 1);

console.log(JSON.stringify({
  exploratory: true,
  source: DB_PATH,
  flowRange: {
    first: new Date(range.firstBar * BAR_MS).toISOString(),
    last: new Date(range.lastBar * BAR_MS).toISOString(),
    bars: range.bars,
    coins: range.coins,
  },
  flowCoinBars: flow.length,
  eligibleCoins: eligibleCoins.length,
  matchedFlowBars: [...flowByCoin.values()].reduce((sum, rows) => sum + rows.length, 0),
  coinsWithoutCandles,
  signals,
  missingOutcome,
  result: comparison(events),
  byRegime,
  bySide: groupComparisons(events, 'side'),
  byDay: groupComparisons(events.map((row) => ({
    ...row, day: new Date(row.entryT).toISOString().slice(0, 10),
  })), 'day'),
  withoutTopContributors: withoutTopContributors(events),
  topCoins: [...coinCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([coin, n]) => ({ coin, n })),
}, null, 2));
