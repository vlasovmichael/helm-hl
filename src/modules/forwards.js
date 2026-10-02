// ─────────────────────────────────────────────────
//  Форвард-накопители: один список для витрины и для сторожа
// ─────────────────────────────────────────────────
// Метрик результата здесь нет: только сколько набрано, с какой скоростью и
// когда последняя запись. Подглядывание в незакрытый форвард ломает предзаявку.
//
// Что показывать, решает реестр: закрытая гипотеза уходит из «идут» сама.

import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { resolveStageBranch } from "../../tools/hypothesisStages.mjs";
import { getVenueSnapshots } from "../core/database.js";
import { PREREG_AT as WEEKEND_PREREG_AT, buildEvents as weekendEvents } from "../../tools/weekendFade.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const REGISTRY = join("data", "hypotheses", "registry.json");
const NEGFUNDING_DIR = join("data", "negfunding-forward");

/** Сколько дней провалившийся вердикт висит на витрине, прежде чем уйти. */
export const VERDICT_SHOWN_DAYS = 7;
const KEEP_RESULTS = new Set(["PASSED_ECONOMICS"]);

// Сборщик пишет эпизоды без доходности раз в сутки; свежесть — по файлу снимков.
function negFundingRows() {
  try {
    return JSON.parse(readFileSync(join(NEGFUNDING_DIR, "episodes.json"), "utf8")).filter((r) => r.status === "valid");
  } catch { return []; }
}

function negFundingLatest() {
  try { return statSync(join(NEGFUNDING_DIR, "quotes.jsonl")).mtimeMs; } catch { return null; }
}

/**
 * Все форварды, у которых есть живой сборщик.
 * maxSilentHours — сколько сборщик может молчать при исправной работе.
 * evalCommand — скрипт оценки по предзаявке; сторож зовёт его один раз на пороге.
 * deadlineISO — срок из стоп-правила: в этот день форвард готов при любом n.
 */
export const FORWARDS = [
  {
    // Стоп-правило — 20 выходных с предзаявки и 40 событий: выходные идут гейтом дней.
    id: "hip3-weekend-overshoot-2026-09", label: "HIP-3 weekend overshoot",
    rows: () => weekendEvents(getVenueSnapshots(WEEKEND_PREREG_AT - 7 * DAY)),
    latest: () => getVenueSnapshots(Date.now() - DAY).at(-1)?.ts ?? null,
    target: 40, unit: "events", tField: "t", startedISO: "2026-09-23", minDaysRunning: 140,
    maxSilentHours: 3, evalCommand: ["tools/weekendFade.mjs"],
  },
  {
    id: "hl-negfunding-kraken-forward-2026-10", label: "Negative funding HL × Kraken spot",
    rows: negFundingRows, latest: negFundingLatest,
    target: 40, unit: "episodes", tField: "t", startedISO: "2026-10-02", deadlineISO: "2027-07-01",
    maxSilentHours: 2, evalCommand: ["tools/negFundingKrakenForwardEval.mjs"],
    note: "Stop rule: 40 valid closed episodes or 2027-07-01; fewer than 30 by then is inconclusive.",
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
  const deadline = f.deadlineISO ? Date.parse(`${f.deadlineISO}T00:00:00Z`) : null;
  const ready = (n >= f.target &&
    (!f.minDaysRunning || daysRunning >= f.minDaysRunning) &&
    (!minCalendarDays || days.size >= minCalendarDays) &&
    (!f.minRegimeShare || (regimeShare ?? 0) >= f.minRegimeShare) &&
    groupReady) || (deadline != null && now >= deadline);

  return {
    n, target: f.target, unit: f.unit, pct: (n / f.target) * 100,
    daysRunning, perDay,
    etaISO: etaDays != null && Number.isFinite(etaDays) ? dayOf(now + etaDays * DAY) : null,
    lastT, staleHours,
    // Сборщик, не давший ни строки за сутки работы, тоже молчит.
    silent: staleHours != null ? staleHours > f.maxSilentHours : daysRunning > 1,
    maxSilentHours: f.maxSilentHours,
    calendarDays: days.size, minCalendarDays, minDaysRunning: f.minDaysRunning ?? null,
    regimeShare, minRegimeShare: f.minRegimeShare ?? null,
    groups, minPerGroup: f.minPerGroup ?? null, groupReady,
    deadlineISO: f.deadlineISO ?? null,
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
