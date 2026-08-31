// ─────────────────────────────────────────────────────────────────────────────
//  Форвард-коллектор трёх гипотез, предзаявленных 31.08.2026:
//    wide-stop-premium-4h · session-open-reversal · squeeze-expansion-4h
//
//  Устроен как scripts/fvgForward.mjs и делит с ним базу свечей: догружает
//  свежие 15m бары, прогоняет ПРАВИЛА ИЗ tools/forwardRules.mjs и дописывает
//  завершённые сделки со входом ПОСЛЕ предзаявления.
//
//  🚨 ПОДГЛЯДЫВАТЬ ЗАПРЕЩЕНО. Скрипт печатает только n и прогресс к порогу.
//  Метрики считаются РОВНО ОДИН РАЗ, когда выполнены ВСЕ условия stopRule.
//
//  Запуск: node scripts/forwardMulti.mjs [--days 20] [--no-fetch]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RULES } from '../tools/forwardRules.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
// 20 дней: правилам нужно ≥100 баров 4h истории (EMA50 + окно сжатия) ≈ 17 дней.
const DAYS = parseInt(arg('days', '20'), 10);
const DB_PATH = process.env.FVG_DB || 'candles.db';
// Граница форварда. Данные до неё видел замер частоты 31.08 — «свежими» они
// быть не могут, даже если исходы на них не смотрели.
const PREREG_TS = Date.parse('2026-09-01T00:00:00Z');
const API = 'https://api.hyperliquid.xyz/info';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Пороги остановки. Держатся здесь И в реестре гипотез; расходиться не должны.
const STOP = {
  'wide-stop-premium-4h': { n: 700, unit: 'пар' },
  'session-open-reversal': { n: 60, unit: 'дней', byDay: true },
  'squeeze-expansion-4h': { n: 1200, unit: 'сделок' },
};
const MIN_CALENDAR_DAYS = 45;      // выборка обязана застать разную погоду
const MIN_REGIME_SHARE = 0.20;     // и обе стороны рынка

async function post(b, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error('HTTP 429 (исчерпаны ретраи)');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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
  let got = 0;
  const chunks = Array.from({ length: 4 }, () => []);
  coins.forEach((c, i) => chunks[i % 4].push(c));
  await Promise.all(chunks.map(async (list) => {
    for (const coin of list) {
      try {
        const cs = await post({ type: 'candleSnapshot', req: { coin, interval: '15m', startTime: start, endTime: Date.now() } });
        if (Array.isArray(cs) && cs.length) { many(coin, cs); got += cs.length; }
      } catch { /* пропуск монеты не ломает прогон */ }
      await sleep(40);
    }
  }));
  console.log(`[fetch] ${coins.length} монет · +${got} свечей`);
}

const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles WHERE t >= ? ORDER BY coin,t')
  .all(Date.now() - (DAYS + 1) * 86400_000);
db.close();
const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }

// Режим BTC на момент входа — пишем сразу: задним числом его не восстановить,
// если монета делистнется, а без него не проверить «эдж или бета».
const btcAt = new Map((byCoin.get('BTC') || []).map((b) => [b.t, b.c]));
const btcRegime = (t) => {
  const now = btcAt.get(t), then = btcAt.get(t - 24 * 3600_000);
  return now == null || then == null ? null : now > then ? 'btc_up' : 'btc_down';
};

const day = (t) => new Date(t).toISOString().slice(0, 10);

for (const { id, find } of RULES) {
  const journal = `data/forward/${id}.jsonl`;
  mkdirSync(dirname(journal), { recursive: true });

  const seen = new Set();
  const days = new Set();
  const regimes = { btc_up: 0, btc_down: 0 };
  if (existsSync(journal)) {
    for (const l of readFileSync(journal, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const t = JSON.parse(l);
      seen.add(`${t.coin}|${t.entryT}`);
      days.add(day(t.entryT));
      if (t.btcRegime) regimes[t.btcRegime]++;
    }
  }

  let added = 0;
  for (const [coin, bars] of byCoin) {
    let trades;
    try { trades = find(coin, bars); } catch { continue; }
    for (const t of trades) {
      if (t.entryT < PREREG_TS) continue;
      const key = `${coin}|${t.entryT}`;
      if (seen.has(key)) continue;
      seen.add(key);
      days.add(day(t.entryT));
      const reg = btcRegime(t.entryT);
      if (reg) regimes[reg]++;
      appendFileSync(journal, JSON.stringify({ ...t, btcRegime: reg, loggedAt: new Date().toISOString() }) + '\n');
      added++;
    }
  }

  const rule = STOP[id];
  const have = rule.byDay ? days.size : seen.size;
  const total = regimes.btc_up + regimes.btc_down;
  const minShare = total ? Math.min(regimes.btc_up, regimes.btc_down) / total : 0;
  const ok = have >= rule.n && days.size >= MIN_CALENDAR_DAYS && minShare >= MIN_REGIME_SHARE;

  console.log(
    `${id}: +${added} · ${have}/${rule.n} ${rule.unit} (${(have / rule.n * 100).toFixed(1)}%) · ` +
    `${days.size}/${MIN_CALENDAR_DAYS} дней · режимы ${regimes.btc_up}/${regimes.btc_down} ` +
    `(меньшая доля ${(minShare * 100).toFixed(0)}%, нужно ${MIN_REGIME_SHARE * 100}%)`,
  );
  if (ok) console.log('   🔔 ВСЕ УСЛОВИЯ ВЫПОЛНЕНЫ — можно оценивать, ровно один раз, по критериям реестра');
}
console.log('метрики НЕ показываются до порога — это защита от optional stopping');
