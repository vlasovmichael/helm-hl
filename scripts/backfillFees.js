// ─────────────────────────────────────────────────────────────────────────────
//  Одноразовый бэкфилл комиссий для старых external/offline-close сделок.
//
//  ПРЕДЫСТОРИЯ: до фикса (commit 798520f) integrity.js/sync.js писали внешние
//  закрытия (основной путь выхода adopt-сделок) с fee_paid=0 И realized_pnl=gross
//  (Σ closedPnl, price PnL ДО комиссий). Контракт таблицы history — realized_pnl
//  net of fees. Этот скрипт дотягивает реальную комиссию из HL fills и пересчитывает
//  realized_pnl = gross − fee для затронутых строк.
//
//  БЕЗОПАСНОСТЬ:
//   · dry-run по умолчанию (только печатает план); запись — ТОЛЬКО с --apply.
//   · идемпотентен: трогает строку лишь если её realized_pnl ещё gross
//     (|realized_pnl − leg.pnl| < eps). Если уже net — пропускает (двойного
//     вычитания не будет).
//   · перед записью делает консистентный бэкап БД (better-sqlite3 .backup()).
//   · меняет только fee_paid≈0 строки, у которых нашёлся уверенный gross-матч в
//     fills. equity-diff закрытия (нет fills / pnl не совпал) не трогаются.
//
//  Запуск (внутри контейнера на Oracle, где лежит БД и есть ключи в env):
//    node scripts/backfillFees.js                 # dry-run
//    node scripts/backfillFees.js --apply         # запись (с бэкапом)
//    node scripts/backfillFees.js --days 120 --tol-ms 15000 --apply
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { fetchUserFills, reconstructRoundTrips } from '../src/modules/userFills.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const DB_PATH = arg('db', 'data/trades.db');
const DAYS = parseInt(arg('days', '90'), 10);
const TOL_MS = parseInt(arg('tol-ms', '10000'), 10); // допуск матча по closed_at
const APPLY = has('apply');
const EPS = 1e-6; // gross/net различаются на размер комиссии (~$0.04) ≫ EPS

const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(4);

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Строки-кандидаты: закрытые сделки с нулевой комиссией.
  const rows = db
    .prepare(
      `SELECT id, coin, side, realized_pnl, fee_paid, closed_at, reason, strategy_id
         FROM history
        WHERE ABS(fee_paid) < ${EPS}
        ORDER BY closed_at ASC`,
    )
    .all();

  console.log(`[backfill] БД: ${DB_PATH}`);
  console.log(`[backfill] строк с fee_paid≈0: ${rows.length}`);
  if (rows.length === 0) {
    console.log('[backfill] нечего делать.');
    db.close();
    return;
  }

  // Round-trip ноги из fills (тот же движок, что у дашборда/integrity). Источник
  // классификации не нужен → botTrades=[], oidSet=null (как findRoundTripForPosition).
  const since = Date.now() - DAYS * 86_400_000;
  console.log(`[backfill] тяну fills за ${DAYS}д…`);
  const fills = await fetchUserFills(since, { force: true });
  const legs = reconstructRoundTrips(fills, [], null).filter((t) => t.status === 'closed');
  console.log(`[backfill] закрытых round-trip ног из fills: ${legs.length}`);

  // Индекс ног по coin|side для быстрого матча.
  const byKey = new Map();
  for (const l of legs) {
    const k = `${(l.coin || '').toUpperCase()}|${(l.side || '').toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }

  const updates = [];
  const skipped = { net: 0, noMatch: 0, zeroFee: 0, ambiguous: 0 };

  for (const r of rows) {
    const key = `${(r.coin || '').toUpperCase()}|${(r.side || '').toLowerCase()}`;
    const cands = byKey.get(key) || [];
    // Ближайшая нога по времени закрытия в пределах допуска.
    let best = null;
    let bestDelta = Infinity;
    for (const l of cands) {
      const delta = Math.abs((l.closeTime ?? 0) - (r.closed_at ?? 0));
      if (delta <= TOL_MS && delta < bestDelta) {
        bestDelta = delta;
        best = l;
      }
    }
    if (!best) {
      skipped.noMatch++;
      continue;
    }
    const grossMatch = Math.abs((r.realized_pnl || 0) - (best.pnl || 0)) < EPS;
    const netMatch = Math.abs((r.realized_pnl || 0) - ((best.pnl || 0) - (best.fee || 0))) < EPS;
    if (netMatch && !grossMatch) {
      skipped.net++; // уже мигрирована (новый код) — пропускаем
      continue;
    }
    if (!grossMatch) {
      // pnl не совпал ни как gross, ни как net → это не та нога / equity-diff close.
      skipped.ambiguous++;
      continue;
    }
    if (!(best.fee > 0)) {
      skipped.zeroFee++; // комиссии нет — fee_paid=0 корректен
      continue;
    }
    updates.push({
      id: r.id,
      coin: r.coin,
      side: r.side,
      oldPnl: r.realized_pnl || 0,
      newPnl: (r.realized_pnl || 0) - best.fee,
      fee: best.fee,
      deltaMs: bestDelta,
    });
  }

  console.log('');
  console.log(`[backfill] под обновление: ${updates.length}`);
  console.log(
    `[backfill] пропущено: уже-net=${skipped.net}, нет-матча=${skipped.noMatch}, ` +
      `комиссия=0 (${skipped.zeroFee}), неоднозначно/equity-diff=${skipped.ambiguous}`,
  );
  if (updates.length) {
    console.log('');
    console.log('  id     coin     side   realized: gross → net      fee      Δt');
    console.log('  ' + '─'.repeat(66));
    for (const u of updates) {
      console.log(
        `  ${String(u.id).padEnd(6)} ${String(u.coin).padEnd(8)} ` +
          `${String(u.side).padEnd(5)}  ${fmt(u.oldPnl).padStart(9)} → ${fmt(u.newPnl).padStart(9)}` +
          `   ${u.fee.toFixed(4).padStart(7)}   ${(u.deltaMs / 1000).toFixed(1)}s`,
      );
    }
    const totFee = updates.reduce((s, u) => s + u.fee, 0);
    console.log('  ' + '─'.repeat(66));
    console.log(
      `  ИТОГО: комиссий дописано $${totFee.toFixed(4)} · PnL уменьшится на $${totFee.toFixed(4)} (net)`,
    );
  }

  if (!APPLY) {
    console.log('');
    console.log('[backfill] DRY-RUN. Для записи добавь --apply (будет сделан бэкап БД).');
    db.close();
    return;
  }

  if (updates.length === 0) {
    console.log('[backfill] нет изменений — запись не нужна.');
    db.close();
    return;
  }

  // Консистентный бэкап перед записью.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.pre-fee-backfill.${stamp}.bak`;
  console.log('');
  console.log(`[backfill] бэкап → ${backupPath}`);
  await db.backup(backupPath);

  const upd = db.prepare('UPDATE history SET fee_paid = ?, realized_pnl = ? WHERE id = ?');
  const tx = db.transaction((list) => {
    for (const u of list) upd.run(u.fee, u.newPnl, u.id);
  });
  tx(updates);
  console.log(`[backfill] ✅ обновлено строк: ${updates.length}`);
  db.close();
}

main().catch((err) => {
  console.error(`[backfill] ОШИБКА: ${err.stack || err.message}`);
  process.exit(1);
});
