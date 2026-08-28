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

// ── Форвард FVG: ТОЛЬКО прогресс ────────────────────────────────────────────
// Карточка существует, чтобы накопитель было видно: невидимый накопитель тихо
// умирает (Spike-Fade простоял так три недели). Но показывать она обязана
// только счётчик и даты — ни E[R], ни winrate, ни даже знак последней сделки.
// Причина не в стиле: гипотеза предзаявлена со stopRule n=1500, и подглядывание
// в промежуточный результат ломает тест независимо от того, как честно потом
// посчитан сам критерий. Поле `r` из журнала сюда не попадает намеренно.
const FVG_JOURNAL = join("data", "fvg-forward", "trades.jsonl");
const FVG_TARGET = 1500;
export const handleFvgForward = served("fvg", () => {
  const rows = readJsonl(FVG_JOURNAL);
  const n = rows.length;
  const times = rows.map((t) => t.entryT).filter(Number.isFinite).sort((a, b) => a - b);
  const firstT = times[0] ?? null;
  const lastT = times[times.length - 1] ?? null;
  const startedMs = Date.parse("2026-08-29T00:00:00Z");
  const daysRunning = Math.max(0, (Date.now() - startedMs) / 86_400_000);
  const perDay = daysRunning >= 1 && n ? n / daysRunning : null;
  const etaDays = perDay && perDay > 0 ? (FVG_TARGET - n) / perDay : null;
  return {
    n,
    target: FVG_TARGET,
    pct: (n / FVG_TARGET) * 100,
    firstT,
    lastT,
    daysRunning,
    perDay,
    etaISO: etaDays != null && Number.isFinite(etaDays)
      ? new Date(Date.now() + etaDays * 86_400_000).toISOString().slice(0, 10)
      : null,
    // возраст последней записи — чтобы молчащий коллектор было видно сразу,
    // а не через месяц при разборе
    staleHours: lastT ? (Date.now() - lastT) / 3_600_000 : null,
    decisionRule: `оценка ровно один раз при n=${FVG_TARGET}`,
  };
});
