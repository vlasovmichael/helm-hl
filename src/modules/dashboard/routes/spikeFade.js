// ─────────────────────────────────────────────────
//  Spike-Fade route — витрина бумажного замера «скальпа фитилей»
// ─────────────────────────────────────────────────
// Читает JSONL, который пишет tools/spikeFadeMeasure.mjs (отдельный контейнер-
// наблюдатель, см. docker-compose сервис spike-fade). Файл в общем data-томе:
// data/spike-fade/events.jsonl.
//
// Это ТОЛЬКО показ данных forward-замера: «был бы эдж, если фейдить каждый
// резкий вик». Живого бота не касается. Вывод по эджу — на серии 20+ событий,
// n<20 = шум (2026-07-17).
//
// GET /api/spike-fade — обзор: all/short/long agg + выходы + топ-монеты + окно.

import { join } from "node:path";
import { readEvents, buildOverview } from "../../../../tools/spikeFadeStats.mjs";

const EVENTS_FILE = join("data", "spike-fade", "events.jsonl");
const CACHE_TTL_MS = 30_000; // наблюдатель дописывает редко — 30с кэша достаточно

let cache = { payload: null, loadedAt: 0 };

export function handleSpikeFade(_req, res) {
  const now = Date.now();
  if (cache.payload && now - cache.loadedAt < CACHE_TTL_MS) {
    res.json(cache.payload);
    return;
  }
  let overview;
  try {
    overview = buildOverview(readEvents(EVENTS_FILE));
  } catch (err) {
    res.json({ ok: false, reason: "read-error", message: String(err?.message || err) });
    return;
  }
  const payload = { ok: true, ...overview };
  cache = { payload, loadedAt: now };
  res.json(payload);
}
