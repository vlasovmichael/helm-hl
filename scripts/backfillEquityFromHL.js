// ─────────────────────────────────────────────────────────────────────────────
//  Бэкфилл equity-снапшотов из портфельного API Hyperliquid → equity_snapshots.
//
//  ЗАЧЕМ: Performance-график («All» на /statistics.html) рисуется по таблице
//  equity_snapshots, которая раньше держала лишь 35 дней (retention). Старые пики
//  (напр. ~$115) обрезались. HL хранит accountValueHistory за всю жизнь счёта —
//  дотягиваем недостающую предысторию отсюда, чтобы кривая показывала ВСЁ депо.
//
//  Берём период "allTime" (полный account value: spot+perp). По умолчанию вставляем
//  только точки СТАРШЕ самого раннего имеющегося снапшота (заполняем провал, не
//  трогаем плотные свежие 5-мин точки). --all — вставить/заменить все.
//
//  Запуск (на Oracle, где trades.db + env):
//    node scripts/backfillEquityFromHL.js [--db data/trades.db] [--address 0x..] [--dry] [--all]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const DB_PATH = arg('db', 'data/trades.db');
const ADDRESS = arg('address', process.env.PUBLIC_WALLET_ADDRESS || '');
const DRY = has('dry');
const ALL = has('all');
const API = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';

if (!ADDRESS) {
  console.error('Нет адреса. Передай --address 0x… или задай PUBLIC_WALLET_ADDRESS.');
  process.exit(1);
}

async function post(body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
}

// HL portfolio: массив пар [periodKey, { accountValueHistory:[[ts,"val"],...], ... }].
function pickHistory(portfolio, key) {
  if (!Array.isArray(portfolio)) return [];
  const entry = portfolio.find((p) => Array.isArray(p) && p[0] === key);
  const hist = entry?.[1]?.accountValueHistory;
  return Array.isArray(hist) ? hist : [];
}

async function main() {
  console.log(`[equity-backfill] db=${DB_PATH} address=${ADDRESS} ${DRY ? '(DRY)' : ''} ${ALL ? '(ALL)' : '(gap-only)'}`);

  const portfolio = await post({ type: 'portfolio', user: ADDRESS });
  let hist = pickHistory(portfolio, 'allTime');
  if (hist.length === 0) {
    // На некоторых аккаунтах allTime пуст — соберём максимум из month/week/day.
    const merged = new Map();
    for (const k of ['month', 'week', 'day']) {
      for (const [ts, v] of pickHistory(portfolio, k)) merged.set(Number(ts), v);
    }
    hist = [...merged.entries()].sort((a, b) => a[0] - b[0]);
  }
  if (hist.length === 0) {
    console.error('HL вернул пустую accountValueHistory — нечего бэкфиллить. Ключи портфеля:',
      Array.isArray(portfolio) ? portfolio.map((p) => p[0]).join(', ') : typeof portfolio);
    process.exit(2);
  }

  const points = hist
    .map(([ts, v]) => ({ ts: Number(ts), equity: Number(v) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.equity));
  const first = points[0];
  const last = points[points.length - 1];
  console.log(`[equity-backfill] HL точек: ${points.length} | ${new Date(first.ts).toISOString()} ($${first.equity.toFixed(2)}) → ${new Date(last.ts).toISOString()} ($${last.equity.toFixed(2)})`);
  const peak = points.reduce((m, p) => (p.equity > m.equity ? p : m), points[0]);
  console.log(`[equity-backfill] пик по HL: $${peak.equity.toFixed(2)} @ ${new Date(peak.ts).toISOString()}`);

  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS equity_snapshots (ts INTEGER PRIMARY KEY, equity REAL NOT NULL);`);
  const earliest = db.prepare('SELECT MIN(ts) AS m FROM equity_snapshots').get()?.m ?? null;
  console.log(`[equity-backfill] самый ранний существующий снапшот: ${earliest ? new Date(earliest).toISOString() : '—(пусто)'}`);

  const toInsert = ALL || earliest == null
    ? points
    : points.filter((p) => p.ts < earliest);
  console.log(`[equity-backfill] к вставке: ${toInsert.length} точек ${ALL ? '(all)' : '(до провала)'}`);

  if (DRY) {
    console.log('[equity-backfill] DRY — ничего не пишу. Первые 5:',
      toInsert.slice(0, 5).map((p) => `${new Date(p.ts).toISOString()}=$${p.equity.toFixed(2)}`).join('  '));
    return;
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO equity_snapshots (ts, equity) VALUES (?, ?)');
  const tx = db.transaction((rows) => { for (const p of rows) stmt.run(p.ts, p.equity); });
  tx(toInsert);
  const total = db.prepare('SELECT COUNT(*) AS c FROM equity_snapshots').get().c;
  console.log(`[equity-backfill] ✅ вставлено ${toInsert.length}, всего в equity_snapshots: ${total}`);
}

main().catch((err) => {
  console.error('[equity-backfill] FAIL:', err.message);
  process.exit(1);
});
