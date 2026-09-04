// ─────────────────────────────────────────────────
//  Research routes — витрина накопителя чужих прогнозов
// ─────────────────────────────────────────────────
// Здесь остался прогресс форварда FVG, и он по устройству не отдаёт ни одной
// метрики результата.
//
// 🚨 Накопитель, которого не видно, тихо умирает и месяцами показывает
// замёрзший снимок как живой. Поэтому каждая карточка обязана показывать
// ВОЗРАСТ данных,
// и роут отдаёт его явным полем, а не оставляет фронту догадываться.
//
// Счёт — из tools/researchStats.mjs, тот же модуль, что у CLI-инструментов:
// иначе дашборд и консоль разъедутся в цифрах.

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { readJsonl } from "../../../../tools/researchStats.mjs";

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

// ── Все форвард-накопители одним списком ────────────────────────────────────
// Гипотез стало пять, и держать под каждую свою ручку значит однажды забыть
// одну из них — а забытый накопитель это и есть тихо умерший накопитель.
// Здесь по-прежнему НЕТ ни одной метрики результата: только сколько набрано,
// с какой скоростью и когда последняя запись.
const FORWARDS = [
  {
    id: "fvg-wide-retest-4h", label: "FVG wide retest 4h",
    file: join("data", "fvg-forward", "trades.jsonl"),
    target: 1500, unit: "trades", tField: "entryT", startedISO: "2026-08-29",
  },
  {
    id: "liqwick-net-edge-n277", label: "Liquidation wick fade",
    file: join("data", "liq-wick", "events.jsonl"),
    target: 277, unit: "events", tField: "entry_ts", startedISO: "2026-07-22",
  },
  {
    id: "wide-stop-premium-4h", label: "Wide stop premium",
    file: join("data", "forward", "wide-stop-premium-4h.jsonl"),
    target: 700, unit: "pairs", tField: "entryT", startedISO: "2026-09-01",
  },
  {
    id: "session-open-reversal", label: "Session open reversal",
    file: join("data", "forward", "session-open-reversal.jsonl"),
    target: 60, unit: "days", tField: "entryT", startedISO: "2026-09-01", byDay: true,
  },
  {
    id: "squeeze-expansion-4h", label: "Squeeze expansion 4h",
    file: join("data", "forward", "squeeze-expansion-4h.jsonl"),
    target: 1200, unit: "trades", tField: "entryT", startedISO: "2026-09-01",
  },
];

// Условия остановки сверх n — общие для гипотез, предзаявленных 31.08.
const MIN_CALENDAR_DAYS = 45;
const MIN_REGIME_SHARE = 0.2;

export const handleForwards = served("forwards", () => {
  const items = FORWARDS.map((f) => {
    const rows = readJsonl(f.file);
    const times = rows.map((r) => r[f.tField]).filter(Number.isFinite).sort((a, b) => a - b);
    const dayKeys = new Set(times.map((t) => new Date(t).toISOString().slice(0, 10)));
    const n = f.byDay ? dayKeys.size : rows.length;
    const startedMs = Date.parse(`${f.startedISO}T00:00:00Z`);
    const daysRunning = Math.max(0, (Date.now() - startedMs) / 86_400_000);
    const perDay = daysRunning >= 1 && n ? n / daysRunning : null;
    const etaDays = perDay && perDay > 0 && n < f.target ? (f.target - n) / perDay : null;
    // Режимы пишутся только у гипотез 31.08 — у остальных поля просто нет.
    let up = 0, down = 0;
    for (const r of rows) {
      if (r.btcRegime === "btc_up") up++;
      else if (r.btcRegime === "btc_down") down++;
    }
    const regimeTotal = up + down;
    return {
      id: f.id, label: f.label, unit: f.unit,
      n, target: f.target, pct: (n / f.target) * 100,
      daysRunning, perDay,
      etaISO: etaDays != null && Number.isFinite(etaDays)
        ? new Date(Date.now() + etaDays * 86_400_000).toISOString().slice(0, 10)
        : null,
      staleHours: times.length ? (Date.now() - times[times.length - 1]) / 3_600_000 : null,
      calendarDays: dayKeys.size,
      minCalendarDays: MIN_CALENDAR_DAYS,
      regimeShare: regimeTotal ? Math.min(up, down) / regimeTotal : null,
      minRegimeShare: MIN_REGIME_SHARE,
    };
  });
  return { items, decisionRule: "каждая оценивается ровно один раз, по своим условиям из реестра" };
});
