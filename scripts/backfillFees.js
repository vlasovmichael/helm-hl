// ─────────────────────────────────────────────────────────────────────────────
//  Одноразовый бэкфилл комиссий для старых external/offline-close сделок.
//
//  ПРЕДЫСТОРИЯ: до фикса (commit 798520f) integrity.js/sync.js писали внешние
//  закрытия (основной путь выхода adopt-сделок) с fee_paid=0 И realized_pnl=gross
//  (Σ closedPnl, price PnL ДО комиссий). Контракт таблицы history — realized_pnl
//  net of fees. Этот скрипт дотягивает реальную комиссию из HL fills и пересчитывает
//  realized_pnl = gross − fee для затронутых строк — В ОБОИХ источниках, которые
//  читает P&L Summary: live-таблица history И архив data/history_archive.json
//  (Auto-Cleanup переносит старое туда).
//
//  БЕЗОПАСНОСТЬ:
//   · dry-run по умолчанию (только печатает план); запись — ТОЛЬКО с --apply.
//   · идемпотентен: трогает строку лишь если её realized_pnl ещё gross
//     (|realized_pnl − leg.pnl| < eps). Если уже net — пропускает (двойного
//     вычитания не будет). PAPER-строки не матчат реальные fills → не трогаются.
//   · перед записью делает бэкап КАЖДОГО источника (live: .backup(); архив: копия).
//   · только fee_paid≈0 строки с уверенным gross-матчем в fills. equity-diff
//     закрытия (нет fills / pnl не совпал) не трогаются.
//
//  Запуск (внутри контейнера на Oracle, где лежит БД и есть ключи в env):
//    docker compose exec -T hl-paper-scanner node scripts/backfillFees.js
//    docker compose exec -T hl-paper-scanner node scripts/backfillFees.js --apply
//    … --days 120 --tol-ms 15000   (окно fills / допуск матча по closed_at)
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fetchUserFills, reconstructRoundTrips } from '../src/modules/userFills.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const DB_PATH = arg('db', 'data/trades.db');
const ARCHIVE_PATH = arg('archive', 'data/history_archive.json');
const DAYS = parseInt(arg('days', '120'), 10);
const TOL_MS = parseInt(arg('tol-ms', '10000'), 10); // допуск матча по closed_at
const APPLY = has('apply');
const EPS = 1e-6; // gross/net различаются на размер комиссии (~$0.04) ≫ EPS

const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(4);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Для каждой строки (id, coin, side, realized_pnl, closed_at) ищет ногу из fills и
// возвращает { id, newPnl, fee } если нужно обновить. Иначе null + причина в skipped.
function planRow(r, byKey, skipped) {
  const key = `${(r.coin || '').toUpperCase()}|${(r.side || '').toLowerCase()}`;
  const cands = byKey.get(key) || [];
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
    return null;
  }
  const grossMatch = Math.abs((r.realized_pnl || 0) - (best.pnl || 0)) < EPS;
  const netMatch =
    Math.abs((r.realized_pnl || 0) - ((best.pnl || 0) - (best.fee || 0))) < EPS;
  if (netMatch && !grossMatch) {
    skipped.net++;
    return null;
  }
  if (!grossMatch) {
    skipped.ambiguous++;
    return null;
  }
  if (!(best.fee > 0)) {
    skipped.zeroFee++;
    return null;
  }
  return {
    id: r.id,
    coin: r.coin,
    side: r.side,
    oldPnl: r.realized_pnl || 0,
    newPnl: (r.realized_pnl || 0) - best.fee,
    fee: best.fee,
    deltaMs: bestDelta,
  };
}

function printPlan(label, updates, skipped) {
  console.log('');
  console.log(`── ${label} ──`);
  console.log(`  под обновление: ${updates.length}`);
  console.log(
    `  пропущено: уже-net=${skipped.net}, нет-матча=${skipped.noMatch}, ` +
      `комиссия=0 (${skipped.zeroFee}), неоднозначно/equity-diff=${skipped.ambiguous}`,
  );
  if (!updates.length) return;
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
  console.log(`  ИТОГО комиссий: $${totFee.toFixed(4)} (PnL уменьшится на столько же)`);
}

async function main() {
  console.log(`[backfill] БД: ${DB_PATH} | архив: ${ARCHIVE_PATH} | окно fills: ${DAYS}д`);

  // ── Round-trip ноги из fills (общий источник для обоих наборов) ──
  const since = Date.now() - DAYS * 86_400_000;
  console.log(`[backfill] тяну fills за ${DAYS}д…`);
  const fills = await fetchUserFills(since, { force: true });
  const legs = reconstructRoundTrips(fills, [], null).filter((t) => t.status === 'closed');
  console.log(`[backfill] закрытых round-trip ног из fills: ${legs.length}`);
  const byKey = new Map();
  for (const l of legs) {
    const k = `${(l.coin || '').toUpperCase()}|${(l.side || '').toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }

  // ── 1. Live-таблица history ──
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const liveRows = db
    .prepare(
      `SELECT id, coin, side, realized_pnl, fee_paid, closed_at
         FROM history WHERE ABS(fee_paid) < ${EPS} ORDER BY closed_at ASC`,
    )
    .all();
  const liveSkip = { net: 0, noMatch: 0, zeroFee: 0, ambiguous: 0 };
  const liveUpd = [];
  for (const r of liveRows) {
    const u = planRow(r, byKey, liveSkip);
    if (u) liveUpd.push(u);
  }
  console.log(`\n[backfill] LIVE history: строк с fee≈0 = ${liveRows.length}`);
  printPlan('LIVE history', liveUpd, liveSkip);

  // ── 2. Архив history_archive.json ──
  let archive = null;
  let archUpd = [];
  const archSkip = { net: 0, noMatch: 0, zeroFee: 0, ambiguous: 0 };
  if (existsSync(ARCHIVE_PATH)) {
    archive = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
    if (Array.isArray(archive)) {
      const archZero = archive.filter((r) => Math.abs(r.fee_paid || 0) < EPS);
      for (const r of archZero) {
        const u = planRow(r, byKey, archSkip);
        if (u) archUpd.push(u);
      }
      console.log(`\n[backfill] АРХИВ: строк с fee≈0 = ${archZero.length}`);
      printPlan('АРХИВ', archUpd, archSkip);
    } else {
      console.log('[backfill] архив не массив — пропускаю.');
      archive = null;
    }
  } else {
    console.log(`[backfill] архив ${ARCHIVE_PATH} не найден — пропускаю.`);
  }

  const total = liveUpd.length + archUpd.length;
  console.log(`\n[backfill] ВСЕГО под обновление: ${total} (live=${liveUpd.length}, архив=${archUpd.length})`);

  if (!APPLY) {
    console.log('[backfill] DRY-RUN. Для записи добавь --apply (бэкапы будут сделаны).');
    db.close();
    return;
  }
  if (total === 0) {
    console.log('[backfill] нет изменений — запись не нужна.');
    db.close();
    return;
  }

  // ── Запись (с бэкапами) ──
  if (liveUpd.length) {
    const bak = `${DB_PATH}.pre-fee-backfill.${stamp()}.bak`;
    console.log(`\n[backfill] бэкап live → ${bak}`);
    await db.backup(bak);
    const upd = db.prepare('UPDATE history SET fee_paid = ?, realized_pnl = ? WHERE id = ?');
    db.transaction((list) => {
      for (const u of list) upd.run(u.fee, u.newPnl, u.id);
    })(liveUpd);
    console.log(`[backfill] ✅ live обновлено: ${liveUpd.length}`);
  }
  db.close();

  if (archUpd.length && archive) {
    const bak = `${ARCHIVE_PATH}.pre-fee-backfill.${stamp()}.bak`;
    console.log(`[backfill] бэкап архива → ${bak}`);
    copyFileSync(ARCHIVE_PATH, bak);
    const updById = new Map(archUpd.map((u) => [u.id, u]));
    for (const r of archive) {
      const u = updById.get(r.id);
      if (u) {
        r.fee_paid = u.fee;
        r.realized_pnl = u.newPnl;
      }
    }
    writeFileSync(ARCHIVE_PATH, JSON.stringify(archive));
    console.log(`[backfill] ✅ архив обновлён: ${archUpd.length}`);
  }
  console.log('[backfill] готово.');
}

main().catch((err) => {
  console.error(`[backfill] ОШИБКА: ${err.stack || err.message}`);
  process.exit(1);
});
