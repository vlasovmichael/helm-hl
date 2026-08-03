// ─────────────────────────────────────────────────
//  Leaderboard persistence route — витрина теста «есть ли на HL кого копировать»
// ─────────────────────────────────────────────────
// Читает недельный архив снимков лидерборда (tools/leaderboardSnapshot.mjs,
// cron в index.js) и отдаёт out-of-sample тест персистентности.
//
// Живого бота не касается — только чтение файлов с диска. Расчёт ~1.2с
// (перестановочный бейзлайн), данные обновляются раз в неделю → кэш длинный.
//
// GET /api/leaderboard-persistence

import { listSnapshots, readSnapshot } from "../../../../tools/leaderboardSnapshot.mjs";
import { buildReconstructed, buildForward } from "../../../../tools/leaderboardStats.mjs";

const CACHE_TTL_MS = 6 * 3_600_000;
const MIN_FORWARD_DAYS = 21; // короче — прирост тонет в шуме, форвард не показываем

let cache = { payload: null, loadedAt: 0, key: "" };

export function handleLeaderboardPersistence(_req, res) {
  const snaps = listSnapshots();
  const key = snaps.map((s) => s.date).join(",");
  const now = Date.now();
  if (cache.payload && cache.key === key && now - cache.loadedAt < CACHE_TTL_MS) {
    res.json(cache.payload);
    return;
  }

  if (snaps.length === 0) {
    res.json({ ok: false, reason: "no-snapshots", snapshots: [] });
    return;
  }

  let payload;
  try {
    const latest = readSnapshot(snaps[snaps.length - 1].date);
    const reconstructed = buildReconstructed(latest);

    // Форвард — только когда архив реально накопился. Ищем самый ранний снимок,
    // отстоящий от свежего достаточно далеко: больше span = меньше шума.
    let forward = null;
    if (snaps.length >= 2) {
      const first = readSnapshot(snaps[0].date);
      const days = Math.round((latest.capturedAt - first.capturedAt) / 864e5);
      if (days >= MIN_FORWARD_DAYS) forward = buildForward(first, latest);
      else forward = { ok: false, reason: "too-short", spanDays: days, needDays: MIN_FORWARD_DAYS };
    }

    payload = {
      ok: true,
      snapshots: snaps,
      snapshotCount: snaps.length,
      reconstructed,
      forward,
    };
  } catch (err) {
    res.json({ ok: false, reason: "read-error", message: String(err?.message || err) });
    return;
  }

  cache = { payload, loadedAt: now, key };
  res.json(payload);
}
