// ─────────────────────────────────────────────────
//  Spike-Fade Stats — общая агрегация (CLI --tally + dashboard route)
// ─────────────────────────────────────────────────
// Один источник правды для подсчёта expectancy по событиям, которые пишет
// tools/spikeFadeMeasure.mjs. Используется и в CLI-tally, и в /api/spike-fade,
// чтобы цифры на странице и в терминале не разъезжались.

import fs from 'fs';

/** Читает JSONL событий. Отсутствие файла — не ошибка (просто пусто). */
export function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Агрегат по массиву событий или null, если пусто. net_pct уже с комиссией. */
export function aggregate(arr) {
  const n = arr.length;
  if (!n) return null;
  const w = arr.filter((r) => r.net_pct > 0).length;
  const sum = arr.reduce((a, r) => a + r.net_pct, 0);
  return {
    n,
    winRate: w / n * 100,
    exp: sum / n,          // expectancy % на сделку
    sum,                   // суммарный % (сумма фейдов по 1 юниту)
    avgMfe: arr.reduce((a, r) => a + r.mfe_pct, 0) / n,
    avgMae: arr.reduce((a, r) => a + r.mae_pct, 0) / n,
  };
}

/** Полный обзор для дашборда: all/short/long + выходы + топ-монеты + окно. */
export function buildOverview(rows) {
  if (!rows.length) {
    return { count: 0, all: null, short: null, long: null, byReason: {}, coins: [], spanHours: 0, firstT: null, lastT: null };
  }
  const byReason = {};
  for (const r of rows) byReason[r.exit_reason] = (byReason[r.exit_reason] || 0) + 1;

  const byCoin = {};
  for (const r of rows) (byCoin[r.coin] = byCoin[r.coin] || []).push(r);
  const coins = Object.entries(byCoin)
    .map(([coin, arr]) => ({ coin, ...aggregate(arr) }))
    .sort((a, b) => b.n - a.n);

  const firstT = rows[0].entry_ts;
  const lastT  = rows[rows.length - 1].exit_ts;

  return {
    count: rows.length,
    all:   aggregate(rows),
    short: aggregate(rows.filter((r) => r.side === 'short')),
    long:  aggregate(rows.filter((r) => r.side === 'long')),
    byReason,
    coins,
    spanHours: (lastT - firstT) / 3_600_000,
    firstT,
    lastT,
  };
}
