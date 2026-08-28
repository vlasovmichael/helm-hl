// ─────────────────────────────────────────────────────────────────────────────
//  Форвард-коллектор гипотезы fvg-wide-retest-4h (предзаявлена 28.08.2026).
//
//  Догружает свежие 15m свечи, прогоняет ПРАВИЛО ИЗ tools/fvgRule.mjs и
//  дописывает завершённые сделки со входом ПОСЛЕ предзаявления в журнал.
//
//  🚨 ПОДГЛЯДЫВАТЬ ЗАПРЕЩЕНО. Скрипт печатает только накопленное n и дату.
//  Метрики считаются РОВНО ОДИН РАЗ при n=1500 (stopRule в реестре).
//  Смотреть E[R] раньше = optional stopping = ложное срабатывание почти даром.
//
//  Запуск: node scripts/fvgForward.mjs [--days 15] [--no-fetch]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { findTrades, PARAMS } from '../tools/fvgRule.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const DAYS = parseInt(arg('days', '15'), 10);   // 52 бара 4h истории ≈ 9 дней, берём с запасом
const JOURNAL = 'data/fvg-forward/trades.jsonl';
// Граница форварда — 29.08, а не 28.08: данные за 28-е уже были в бэктесте,
// который породил гипотезу, и «свежими» для неё быть не могут.
const PREREG_TS = Date.parse('2026-08-29T00:00:00Z');
const API = 'https://api.hyperliquid.xyz/info';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(b, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error('HTTP 429 (исчерпаны ретраи)');
}

const db = new Database('candles.db');
db.pragma('journal_mode = WAL');
// самодостаточность: скрипт должен подниматься на чистой машине (Oracle) без
// предварительного бэкфилла — иначе форвард молча не стартует после деплоя
db.exec(`CREATE TABLE IF NOT EXISTS candles (
   coin TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
   PRIMARY KEY (coin, t)
 )`);

if (!process.argv.includes('--no-fetch')) {
  const ins = db.prepare('INSERT OR REPLACE INTO candles (coin,t,o,h,l,c,v) VALUES (?,?,?,?,?,?,?)');
  const many = db.transaction((c, rs) => { for (const k of rs) ins.run(c, k.t, +k.o, +k.h, +k.l, +k.c, +k.v); });
  const meta = await post({ type: 'metaAndAssetCtxs' });
  const coins = meta[0].universe.filter((u) => !u.isDelisted).map((u) => u.name);
  const start = Date.now() - DAYS * 86400_000;
  let done = 0, got = 0;
  const chunks = Array.from({ length: 4 }, () => []);
  coins.forEach((c, i) => chunks[i % 4].push(c));
  await Promise.all(chunks.map(async (list) => {
    for (const coin of list) {
      try {
        const cs = await post({ type: 'candleSnapshot', req: { coin, interval: '15m', startTime: start, endTime: Date.now() } });
        if (Array.isArray(cs) && cs.length) { many(coin, cs); got += cs.length; }
      } catch (e) { /* пропуск монеты не ломает прогон */ }
      done++; await sleep(40);
    }
  }));
  console.log(`[fetch] ${coins.length} монет · +${got} свечей`);
}

// ── уже записанные сделки: дедуп по coin+entryT ──
const seen = new Set();
if (existsSync(JOURNAL)) {
  for (const l of readFileSync(JOURNAL, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const t = JSON.parse(l);
    seen.add(`${t.coin}|${t.entryT}`);
  }
}

const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles WHERE t >= ? ORDER BY coin,t')
  .all(Date.now() - (DAYS + 1) * 86400_000);
db.close();
const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }

// режим BTC на момент входа — нужен для критерия 4 (эдж или бета), пишем сразу:
// задним числом его не восстановить, если монета делистнется
const btcAt = new Map((byCoin.get('BTC') || []).map((b) => [b.t, b.c]));
const btcRegime = (t) => {
  const now = btcAt.get(t), then = btcAt.get(t - 24 * 3600_000);
  return now == null || then == null ? null : now > then ? 'btc_up' : 'btc_down';
};

let added = 0;
for (const [coin, bars] of byCoin) {
  for (const t of findTrades(coin, bars)) {
    if (t.entryT < PREREG_TS) continue;                    // до предзаявления не считается
    const key = `${coin}|${t.entryT}`;
    if (seen.has(key)) continue;
    seen.add(key);
    appendFileSync(JOURNAL, JSON.stringify({ ...t, btcRegime: btcRegime(t.entryT), loggedAt: new Date().toISOString() }) + '\n');
    added++;
  }
}

console.log(`[forward] +${added} новых · всего ${seen.size} из 1500 · ` +
  `${(seen.size / 1500 * 100).toFixed(1)}% · параметры: ${JSON.stringify(PARAMS)}`);
if (seen.size >= 1500) {
  console.log('\n🔔 ПОРОГ ДОСТИГНУТ. Пора оценивать — ровно один раз, по критериям из реестра:');
  console.log('   node scripts/fvgEvaluate.mjs');
} else {
  console.log('   метрики НЕ показываются до порога — это защита от optional stopping');
}
