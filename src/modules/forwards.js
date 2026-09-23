// ─────────────────────────────────────────────────
//  Форвард-накопители: один список для витрины и для сторожа
// ─────────────────────────────────────────────────
// Метрик результата здесь нет: только сколько набрано, с какой скоростью и
// когда последняя запись. Подглядывание в незакрытый форвард ломает предзаявку.
//
// Что показывать, решает реестр: закрытая гипотеза уходит из «идут» сама.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { readJsonl } from "../../tools/researchStats.mjs";
import { resolveStageBranch } from "../../tools/hypothesisStages.mjs";
import { getFillCosts, getVenueSnapshots } from "../core/database.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const REGISTRY = join("data", "hypotheses", "registry.json");
const FLOW_DB = join("data", "flow", "flow.db");
const BAR_MS = 300_000;

/** Сколько дней провалившийся вердикт висит на витрине, прежде чем уйти. */
export const VERDICT_SHOWN_DAYS = 7;
const KEEP_RESULTS = new Set(["PASSED_ECONOMICS"]);

// ── flow.db: пишет отдельный контейнер ──────────────
// Её отсутствие, блокировка или битый файл гасят одну карточку, а не весь список.
let flowDb = null;
function pressureDb() {
  if (flowDb) return flowDb;
  if (!existsSync(FLOW_DB)) return null;
  flowDb = new Database(FLOW_DB, { readonly: true, fileMustExist: true });
  flowDb.pragma("busy_timeout = 3000");
  return flowDb;
}

function hasPressureTable(db) {
  return !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pressure_events'").get();
}

export function pressureRows() {
  try {
    const db = pressureDb();
    if (!hasPressureTable(db)) return [];
    return db.prepare(`
      SELECT c.name AS coin, e.side, e.cohort,
             e.entry_bar * ? AS entryT, e.fade_bp AS fadeBp,
             e.btc_regime AS btcRegime
        FROM pressure_events e JOIN coins c ON c.id = e.coin
       WHERE e.status = 'resolved'
       ORDER BY e.entry_bar`).all(BAR_MS);
  } catch { return []; }
}

function pressureLatest() {
  try {
    const db = pressureDb();
    if (!hasPressureTable(db)) return null;
    const bar = db.prepare("SELECT MAX(bar) AS bar FROM market_bars WHERE closed = 1").get()?.bar;
    return Number.isFinite(bar) ? bar * BAR_MS : null;
  } catch { return null; }
}

// Разлоки: в зачёт идут только чистые закрытые события, а живость сбора видна
// по последнему найденному событию — закрытия редкие.
const UNLOCKS = join("data", "unlocks", "forward.jsonl");
function unlockRows() {
  return readJsonl(UNLOCKS).filter((r) => r.status === "closed" && r.clean);
}
function unlockLatest() {
  let t = null;
  for (const r of readJsonl(UNLOCKS)) {
    const v = r.settledAt ?? r.discoveredAt;
    if (Number.isFinite(v) && (t == null || v > t)) t = v;
  }
  return t;
}

/**
 * Все форварды, у которых есть живой сборщик.
 * maxSilentHours — сколько сборщик может молчать при исправной работе.
 * evalCommand — скрипт оценки по предзаявке; сторож зовёт его один раз на пороге.
 */
export const FORWARDS = [
  {
    id: "fvg-wide-retest-4h", label: "FVG wide retest 4h",
    rows: () => readJsonl(join("data", "fvg-forward", "trades.jsonl")),
    target: 1500, unit: "trades", tField: "entryT", startedISO: "2026-08-29",
    minCalendarDays: 45, minRegimeShare: 0.2, maxSilentHours: 72,
  },
  {
    id: "flow-pressure-exhaustion-2026-09", label: "Flow pressure exhaustion",
    rows: pressureRows, latest: pressureLatest,
    target: 300, unit: "events", tField: "entryT", startedISO: "2026-09-14",
    minCalendarDays: 60, minRegimeShare: 0.2, groupField: "cohort", minPerGroup: 100,
    maxSilentHours: 1,
    note: "This mechanism test is evaluated once with a clustered cohort comparison from the registry.",
  },
  {
    // Гипотеза про изменение: счёт идёт с момента включения post-only, база «до» не в счёт.
    id: "exec-maker-share-n200", label: "Execution cost · maker share",
    rows: () => {
      const since = Date.parse(process.env.EXEC_POSTONLY_SINCE || "");
      return Number.isFinite(since) ? getFillCosts(since) : [];
    },
    target: 200, unit: "fills", tField: "ts", startedISO: "2026-09-05",
    maxSilentHours: 96, evalCommand: ["tools/execCostStats.mjs"],
  },
  {
    id: "exec-stop-slippage-n60", label: "Stop trigger slippage",
    rows: () => getFillCosts(0).filter((r) => r.slip_bp != null),
    target: 60, unit: "stops", tField: "ts", startedISO: "2026-09-05",
    maxSilentHours: 168,
  },
  {
    id: "venue-hip3-premium-45d", label: "HIP-3 venue premium",
    rows: () => getVenueSnapshots(0),
    target: 45, unit: "days", tField: "ts", startedISO: "2026-09-05", byDay: true,
    maxSilentHours: 3,
  },
  {
    // Пары копятся медленнее календаря: прогресс считается днями до срока из реестра.
    id: "hl-kraken-funding-forward-2026-09", label: "HL ↔ Kraken funding spread",
    rows: () => readJsonl(join("data", "funding-spread", "snapshots.jsonl")),
    target: 273, unit: "days", tField: "t", startedISO: "2026-09-11", byDay: true,
    maxSilentHours: 3, evalCommand: ["tools/fundingSpreadEval.mjs"],
    note: "Stop rule: 100 closed pairs or 2027-06-11, whichever comes first.",
  },
  {
    id: "unlock-cliff-front-2026-09", label: "Unlock cliff · short a week before",
    rows: unlockRows, latest: unlockLatest,
    target: 60, unit: "events", tField: "unlockTs", startedISO: "2026-09-09",
    maxSilentHours: 24 * 7,
  },
];

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** Прогресс и условия остановки. Чистая функция: на ней и витрина, и сторож. */
export function forwardProgress(f, rows, now = Date.now()) {
  const times = rows.map((r) => r[f.tField]).filter(Number.isFinite).sort((a, b) => a - b);
  const days = new Set(times.map(dayOf));
  const n = f.byDay ? days.size : rows.length;
  const daysRunning = Math.max(0, (now - Date.parse(`${f.startedISO}T00:00:00Z`)) / DAY);
  const perDay = daysRunning >= 1 && n ? n / daysRunning : null;
  const etaDays = perDay && n < f.target ? (f.target - n) / perDay : null;

  let up = 0, down = 0;
  for (const r of rows) {
    if (r.btcRegime === "btc_up") up++;
    else if (r.btcRegime === "btc_down") down++;
  }
  const regimeShare = f.minRegimeShare && up + down ? Math.min(up, down) / (up + down) : null;

  let groups = null;
  let groupReady = true;
  if (f.groupField && f.minPerGroup) {
    groups = {};
    for (const r of rows) {
      const key = r[f.groupField];
      if (key) groups[key] = (groups[key] || 0) + 1;
    }
    groupReady = Object.keys(groups).length >= 2 && Object.values(groups).every((c) => c >= f.minPerGroup);
  }

  const lastT = f.latest?.() ?? times[times.length - 1] ?? null;
  const staleHours = lastT != null ? (now - lastT) / HOUR : null;
  const minCalendarDays = f.minCalendarDays ?? null;
  const ready = n >= f.target &&
    (!minCalendarDays || days.size >= minCalendarDays) &&
    (!f.minRegimeShare || (regimeShare ?? 0) >= f.minRegimeShare) &&
    groupReady;

  return {
    n, target: f.target, unit: f.unit, pct: (n / f.target) * 100,
    daysRunning, perDay,
    etaISO: etaDays != null && Number.isFinite(etaDays) ? dayOf(now + etaDays * DAY) : null,
    lastT, staleHours,
    // Сборщик, не давший ни строки за сутки работы, тоже молчит.
    silent: staleHours != null ? staleHours > f.maxSilentHours : daysRunning > 1,
    maxSilentHours: f.maxSilentHours,
    calendarDays: days.size, minCalendarDays,
    regimeShare, minRegimeShare: f.minRegimeShare ?? null,
    groups, minPerGroup: f.minPerGroup ?? null, groupReady,
    ready,
  };
}

// ── Реестр ──────────────────────────────────────────

export function readRegistry(path = REGISTRY) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Дата закрытия = последний прогон гипотезы: отдельного поля в реестре нет. */
function lastRunAt(registry, id) {
  let t = null;
  for (const r of registry?.runs || []) {
    if (r.id !== id) continue;
    const v = Date.parse(r.ranAt);
    if (Number.isFinite(v) && (t == null || v > t)) t = v;
  }
  return t;
}

/**
 * Разложить реестр для витрины.
 * running — форварды со сборщиком и статусом OPEN (без реестра — все);
 * finished — закрытые за последние VERDICT_SHOWN_DAYS дней, прошедшие экономику — всегда;
 * idle — OPEN без сборщика, чтобы ни одна открытая гипотеза не терялась.
 */
export function classifyHypotheses(registry, forwards = FORWARDS, now = Date.now()) {
  const byId = new Map((registry?.hypotheses || []).map((h) => [h.id, h]));
  const withCollector = new Set(forwards.map((f) => f.id));
  const running = forwards.filter((f) => !registry || byId.get(f.id)?.status === "OPEN");

  const finished = [];
  for (const h of registry?.hypotheses || []) {
    if (h.status !== "CLOSED") continue;
    // Исход ветки — с последней стадии: holdout перекрывает успех разработки.
    let resultStatus = h.resultStatus ?? null;
    try {
      resultStatus = resolveStageBranch(registry, h.id).terminalHypothesis.resultStatus ?? resultStatus;
    } catch { /* битая связь стадий — остаётся исход самой записи */ }
    const closedAt = lastRunAt(registry, h.id);
    const keep = KEEP_RESULTS.has(resultStatus);
    if (!keep && (closedAt == null || now - closedAt > VERDICT_SHOWN_DAYS * DAY)) continue;
    finished.push({
      id: h.id,
      label: forwards.find((f) => f.id === h.id)?.label ?? h.id,
      resultStatus,
      closedAt,
      hidesAt: keep || closedAt == null ? null : closedAt + VERDICT_SHOWN_DAYS * DAY,
    });
  }
  finished.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

  const idle = (registry?.hypotheses || [])
    .filter((h) => h.status === "OPEN" && !withCollector.has(h.id))
    .map((h) => h.id);

  return { running, finished, idle };
}
