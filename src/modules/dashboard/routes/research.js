// ─────────────────────────────────────────────────
//  Research routes — витрина накопителя чужих прогнозов
// ─────────────────────────────────────────────────
// 2026-08-28: /api/execution-quality и /api/discipline сняты вместе со своими
// карточками — вопросы закрыты, а стакан за две недели не записал ни строки.
// Остался /api/external-calls: чужие прогнозы и их базрейт.
//
// Витрина существует не для красоты: накопитель, который не видно, тихо
// умирает — ровно так три недели простоял Spike-Fade, показывая замёрзший
// снимок как живой. Поэтому каждая карточка обязана показывать ВОЗРАСТ данных,
// и роут отдаёт его явным полем, а не оставляет фронту догадываться.
//
// Счёт — из tools/researchStats.mjs, тот же модуль, что у CLI-инструментов:
// иначе дашборд и консоль разъедутся в цифрах.

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { readJsonl, stats } from "../../../../tools/researchStats.mjs";

const CACHE_TTL_MS = 60_000;
const cache = new Map();

/** Общая обёртка: кэш + fail-soft. Ни одна витрина не должна ронять дашборд. */
function served(key, build) {
  return (_req, res) => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) { res.json(hit.payload); return; }
    let payload;
    try {
      payload = { ok: true, ...build() };
    } catch (err) {
      payload = { ok: false, reason: "read-error", message: String(err?.message || err) };
    }
    cache.set(key, { payload, at: now });
    res.json(payload);
  };
}

const monthFile = (dir, prefix) => join("data", dir, `${prefix}-${new Date().toISOString().slice(0, 7)}.jsonl`);
export const handleExternalCalls = served("calls", () => {
  if (!existsSync(CALLS_FILE)) return { calls: [], settled: 0 };
  const db = JSON.parse(readFileSync(CALLS_FILE, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const calls = (db.calls || []).map((c) => ({
    ...c,
    expired: c.deadline < today,
    daysLeft: Math.round((new Date(c.deadline) - Date.now()) / 86_400_000),
  }));
  return { calls, settled: calls.filter((c) => c.expired).length };
});
