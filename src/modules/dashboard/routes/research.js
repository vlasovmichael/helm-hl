// ─────────────────────────────────────────────────
//  Research routes — витрины трёх накопителей, запущенных 11.08.2026
// ─────────────────────────────────────────────────
// Все три копят данные, которых иначе не будет:
//   /api/execution-quality — стакан (HL не отдаёт исторический, только вперёд)
//   /api/discipline        — сколько поза жила без стопа
//   /api/external-calls    — чужие прогнозы и их базрейт
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
import { readJsonl, bookSummary, makerVerdict, disciplineBuckets, stats } from "../../../../tools/researchStats.mjs";

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

// ── Качество исполнения ─────────────────────────────────────────────────────

export const handleExecutionQuality = served("exec", () => {
  const rows = readJsonl(monthFile("book", "book"));
  const summary = bookSummary(rows);
  return {
    ...summary,
    coins: summary.coins.map((c) => ({ ...c, ...makerVerdict(c.medSpreadBp) })),
    // Сколько минут назад писали в последний раз. Если больше нескольких —
    // коллектор встал, и карточка обязана сказать это, а не молчать.
    ageMin: summary.to ? Math.round((Date.now() - summary.to) / 60_000) : null,
  };
});

// ── Дисциплина ──────────────────────────────────────────────────────────────

const DISCIPLINE_FILE = join("data", "discipline", "trips.json");

export const handleDiscipline = served("discipline", () => {
  if (!existsSync(DISCIPLINE_FILE)) {
    return { empty: true, hint: "запусти tools/disciplineAudit.mjs --save" };
  }
  const saved = JSON.parse(readFileSync(DISCIPLINE_FILE, "utf8"));
  const trips = saved.trips || [];
  const naked = trips.filter((t) => t.minsToStop == null);
  const withStop = trips.filter((t) => t.minsToStop != null).map((t) => t.minsToStop).sort((a, b) => a - b);
  return {
    windowFrom: saved.windowFrom,
    windowTo: saved.windowTo,
    clamped: saved.clamped,
    computedAt: saved.computedAt,
    buckets: disciplineBuckets(trips),
    total: trips.length,
    nakedCount: naked.length,
    nakedShare: trips.length ? naked.length / trips.length : null,
    nakedSum: stats(naked.map((t) => t.net)).sum ?? null,
    medianDelayMin: withStop.length ? withStop[withStop.length >> 1] : null,
  };
});

// ── Чужие прогнозы ──────────────────────────────────────────────────────────

const CALLS_FILE = join("data", "external-calls", "calls.json");

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
