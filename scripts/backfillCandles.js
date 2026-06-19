// ─────────────────────────────────────────────────────────────────────────────
//  Бэкфилл 15m-свечей всех HL-перпов из бесплатного candleSnapshot → candles.db.
//  ~5000 свечей/запрос ≈ 52 дня на 15m. Один запрос на монету. Настоящие OHLC.
//
//  Запуск: node scripts/backfillCandles.js [--interval 15m] [--days 52] [--conc 4]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const INTERVAL = arg('interval', '15m');
const DAYS = parseInt(arg('days', '52'), 10);
const CONC = parseInt(arg('conc', '4'), 10);
const API = 'https://api.hyperliquid.xyz/info';
const NOW = Date.now();
const START = NOW - DAYS * 86400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(body, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    if (r.status === 429) {
      await sleep(2000 * (i + 1)); // backoff: 2s,4s,6s…
      continue;
    }
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error('HTTP 429 (исчерпаны ретраи)');
}

const db = new Database('candles.db');
db.pragma('journal_mode = WAL');
db.exec(
  `CREATE TABLE IF NOT EXISTS candles (
     coin TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
     PRIMARY KEY (coin, t)
   )`,
);
const ins = db.prepare(
  'INSERT OR REPLACE INTO candles (coin,t,o,h,l,c,v) VALUES (?,?,?,?,?,?,?)',
);
const insMany = db.transaction((coin, rows) => {
  for (const k of rows) ins.run(coin, k.t, +k.o, +k.h, +k.l, +k.c, +k.v);
});

console.log(`[universe] …`);
const meta = await post({ type: 'metaAndAssetCtxs' });
const have = new Set(
  db.prepare('SELECT DISTINCT coin FROM candles').all().map((r) => r.coin),
);
const coins = meta[0].universe
  .filter((u) => !u.isDelisted)
  .map((u) => u.name)
  .filter((c) => !have.has(c)); // skip-existing: до-качиваем только недостающие
console.log(
  `[universe] ${coins.length} монет к загрузке (уже есть ${have.size}) · ${INTERVAL} · ${DAYS} дней`,
);

let done = 0;
let totalRows = 0;
async function worker(list) {
  for (const coin of list) {
    try {
      const cs = await post({
        type: 'candleSnapshot',
        req: { coin, interval: INTERVAL, startTime: START, endTime: NOW },
      });
      if (Array.isArray(cs) && cs.length) {
        insMany(coin, cs);
        totalRows += cs.length;
      }
    } catch (e) {
      console.log(`  ! ${coin}: ${e.message}`);
    }
    done++;
    if (done % 30 === 0) console.log(`  … ${done}/${coins.length}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

// раздаём монеты по CONC воркерам
const chunks = Array.from({ length: CONC }, () => []);
coins.forEach((c, i) => chunks[i % CONC].push(c));
await Promise.all(chunks.map(worker));

const span = db.prepare('SELECT min(t) a, max(t) b, count(*) n FROM candles').get();
console.log(
  `\n[done] ${totalRows} свечей · ${coins.length} монет · ` +
    `${new Date(span.a).toISOString().slice(0, 10)} → ${new Date(span.b).toISOString().slice(0, 10)} ` +
    `(${((span.b - span.a) / 86400_000).toFixed(1)}d)`,
);
db.close();
