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
import { getFillCosts, getVenueSnapshots } from "../../../core/database.js";

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
    decisionRule: `evaluated exactly once, at n=${FVG_TARGET}`,
  };
});

// ── Все форвард-накопители одним списком ────────────────────────────────────
// Держать под каждую гипотезу свою ручку значит однажды забыть одну из них — а
// забытый накопитель это и есть тихо умерший накопитель. Здесь по-прежнему НЕТ
// ни одной метрики результата: только сколько набрано, с какой скоростью и
// когда последняя запись.
//
// 🚨 Гипотеза с ВЕРДИКТОМ из списка убирается: витрина показывает идущее, а
// закрытое живёт в data/hypotheses/registry.json (runs). Снято отсюда:
// liqwick-net-edge-n277 и exec-hour-cost-n400 — обе отвергнуты 05.09.
const FORWARDS = [
  {
    id: "fvg-wide-retest-4h", label: "FVG wide retest 4h",
    file: join("data", "fvg-forward", "trades.jsonl"),
    target: 1500, unit: "trades", tField: "entryT", startedISO: "2026-08-29",
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

// Накопители, которые живут в БД, а не в jsonl. Считаются теми же полями, что
// проверяет стоп-правило в реестре: иначе витрина и вердикт разъедутся.
//
// 🚨 Здесь по-прежнему ТОЛЬКО счётчики. У гипотез про издержки подглядывание в
// счётчик разрешено предзаявкой (в отличие от предсказательных), но метрики
// результата на витрину всё равно не идут — их печатает execCostStats.mjs один
// раз при взятии порога.
const DB_FORWARDS = [
  {
    // 🚨 Гипотеза про ИЗМЕНЕНИЕ, поэтому счёт идёт только с момента включения
    // post-only. Пока EXEC_POSTONLY_SINCE не выставлен, накопитель честно стоит
    // на нуле: 2000 залитых филлов — это база «до», а не прогресс.
    id: "exec-maker-share-n200", label: "Execution cost · maker share",
    target: 200, unit: "fills", startedISO: "2026-09-05",
    rows: () => {
      const since = Date.parse(process.env.EXEC_POSTONLY_SINCE || "");
      return Number.isFinite(since) ? getFillCosts(since) : [];
    },
  },
  {
    id: "exec-stop-slippage-n60", label: "Stop trigger slippage",
    target: 60, unit: "stops", startedISO: "2026-09-05",
    rows: () => getFillCosts(0).filter((r) => r.slip_bp != null),
  },
  {
    id: "exec-alert-lag-n40", label: "Alert to trade lag",
    target: 40, unit: "trades", startedISO: "2026-09-05",
    rows: () => getFillCosts(0).filter((r) => r.alert_lag_ms != null),
  },
  {
    id: "venue-hip3-premium-45d", label: "HIP-3 venue premium",
    target: 45, unit: "days", startedISO: "2026-09-05", byDay: true,
    rows: () => getVenueSnapshots(0),
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
  // Накопители из БД — тем же payload'ом, фронту различать источник незачем.
  for (const f of DB_FORWARDS) {
    let rows;
    try {
      rows = f.rows() || [];
    } catch {
      continue; // таблицы ещё нет — накопитель просто не показываем
    }
    const times = rows.map((r) => r.ts).filter(Number.isFinite).sort((a, b) => a - b);
    const dayKeys = new Set(times.map((t) => new Date(t).toISOString().slice(0, 10)));
    const n = f.byDay ? dayKeys.size : rows.length;
    const startedMs = Date.parse(`${f.startedISO}T00:00:00Z`);
    const daysRunning = Math.max(0, (Date.now() - startedMs) / 86_400_000);
    const perDay = daysRunning >= 1 && n ? n / daysRunning : null;
    const etaDays = perDay && perDay > 0 && n < f.target ? (f.target - n) / perDay : null;
    items.push({
      id: f.id, label: f.label, unit: f.unit,
      n, target: f.target, pct: (n / f.target) * 100,
      daysRunning, perDay,
      etaISO: etaDays != null && Number.isFinite(etaDays)
        ? new Date(Date.now() + etaDays * 86_400_000).toISOString().slice(0, 10)
        : null,
      staleHours: times.length ? (Date.now() - times[times.length - 1]) / 3_600_000 : null,
      calendarDays: dayKeys.size,
      // Условия про календарь и режимы касаются предсказательных гипотез 31.08;
      // у накопителей про издержки их нет, и рисовать «ещё нужно» было бы враньём.
      minCalendarDays: null,
      regimeShare: null,
      minRegimeShare: null,
    });
  }

  return { items, decisionRule: "each one is evaluated exactly once, on its own terms from the registry" };
});
