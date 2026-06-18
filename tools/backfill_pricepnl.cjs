// One-shot backfill: восстановить ценовую компоненту realized_pnl для
// hotmovers/swing paper-сделок, которые paperClose писал без pricePnl (баг
// 2026-06-19 — нет ветки strategy_id в paper.js). Конвенция совпадает с кодом:
//   realized_pnl_new = realized_pnl_old + pricePnl
//   pricePnl = isLong ? size*(close-entry)/entry : size*(entry-close)/entry
// Комиссию (fee_paid) НЕ трогаем — она посчитана корректно. Размер берём из
// positions (в history/архиве size не хранится). DRY_RUN=1 → только отчёт.
const fs = require('fs');
const Database = require('better-sqlite3');

const DB = process.env.DB || '/app/data/trades.db';
const ARCHIVE = process.env.ARCHIVE || '/app/data/history_archive.json';
const STRATS = new Set(['hotmovers', 'swing']);
const DRY = process.env.DRY_RUN === '1';

const db = new Database(DB);

function sizeFor(coin, ep) {
  if (ep == null) return null;
  const tol = Math.abs(ep) * 1e-6 + 1e-12;
  const r = db
    .prepare('SELECT size_usd FROM positions WHERE coin=? AND ABS(entry_price-?)<? ORDER BY id LIMIT 1')
    .get(coin, ep, tol);
  return r?.size_usd ?? null;
}

function pricePnl(row, size) {
  const ep = row.entry_price, cp = row.close_price;
  if (ep == null || cp == null || size == null) return null;
  const isLong = (row.side || 'short') === 'long';
  return isLong ? (size * (cp - ep)) / ep : (size * (ep - cp)) / ep;
}

const report = [];
let unmatched = 0;

// ── 1. live history ──
const liveRows = db
  .prepare("SELECT * FROM history WHERE strategy_id IN ('hotmovers','swing')")
  .all();
const updLive = db.prepare(
  'UPDATE history SET realized_pnl=?, hold_seconds=COALESCE(hold_seconds,?) WHERE id=?',
);
const txLive = db.transaction((rows) => {
  for (const r of rows) {
    const size = sizeFor(r.coin, r.entry_price);
    const pp = pricePnl(r, size);
    if (pp == null) { unmatched++; report.push({ src: 'live', id: r.id, coin: r.coin, note: 'NO SIZE — skipped' }); continue; }
    const newPnl = (r.realized_pnl || 0) + pp;
    const hold = r.entry_time && r.closed_at ? Math.round((r.closed_at - r.entry_time) / 1000) : null;
    if (!DRY) updLive.run(newPnl, hold, r.id);
    report.push({ src: 'live', id: r.id, coin: r.coin, side: r.side, reason: r.reason, size: +size.toFixed(1), old: +(r.realized_pnl || 0).toFixed(3), pricePnl: +pp.toFixed(3), new: +newPnl.toFixed(3) });
  }
});
txLive(liveRows);

// ── 2. archive json ──
const archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
let archChanged = 0;
for (const r of archive) {
  if (!STRATS.has(r.strategy_id)) continue;
  const size = sizeFor(r.coin, r.entry_price);
  const pp = pricePnl(r, size);
  if (pp == null) { unmatched++; report.push({ src: 'arch', coin: r.coin, note: 'NO SIZE — skipped' }); continue; }
  const oldPnl = r.realized_pnl || 0;
  const newPnl = oldPnl + pp;
  report.push({ src: 'arch', coin: r.coin, side: r.side, reason: r.reason, size: +size.toFixed(1), old: +oldPnl.toFixed(3), pricePnl: +pp.toFixed(3), new: +newPnl.toFixed(3) });
  if (!DRY) {
    r.realized_pnl = newPnl;
    if (r.size_usd == null) r.size_usd = size; // дозаписываем размер в архив
    archChanged++;
  }
}
if (!DRY && archChanged) fs.writeFileSync(ARCHIVE, JSON.stringify(archive, null, 0));

// ── summary ──
const scored = report.filter((x) => x.new != null);
console.log(JSON.stringify(report, null, 1));
const sumOld = scored.reduce((a, x) => a + x.old, 0);
const sumNew = scored.reduce((a, x) => a + x.new, 0);
const winsNew = scored.filter((x) => x.new > 0).length;
console.log(`\n${DRY ? '[DRY RUN] ' : ''}rows scored: ${scored.length} | unmatched(no size): ${unmatched}`);
console.log(`gross realized_pnl: old $${sumOld.toFixed(3)} → new $${sumNew.toFixed(3)}`);
console.log(`rows with realized_pnl>0 (gross, pre fee-subtract): ${winsNew}/${scored.length}`);
db.close();
