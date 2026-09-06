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
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { readJsonl, stats, clusterCi, winLose } from "../../../../tools/researchStats.mjs";
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

// ── Разбор одного форварда ──────────────────────────────────────────────────
// 🚨 Подглядывание ломает предзаявку. Ручка его не запрещает, но требует явный
// `?peek=1` и пишет просмотр в data/hypotheses/peeks.jsonl: результат, увиденный
// до срока, перестаёт быть чистым тестом, и это должно остаться записанным.
const PEEK_LOG = join("data", "hypotheses", "peeks.jsonl");

// Величина гипотезы — по одной на форвард. Нет строки = метрики на строку нет.
const METRICS = {
  "fvg-wide-retest-4h": { field: "rNet", unit: "R", label: "net R per trade" },
  "wide-stop-premium-4h": {
    field: "diffNet", unit: "R", label: "net R difference, wide − narrow (paired)",
    legs: { wide: (r) => r.wide?.rNet, narrow: (r) => r.narrow?.rNet },
  },
  "session-open-reversal": { field: "rNet", unit: "R", label: "net R per trade" },
  "squeeze-expansion-4h": { field: "rNet", unit: "R", label: "net R per trade" },
};

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

function registryEntry(id) {
  try {
    const reg = JSON.parse(readFileSync(join("data", "hypotheses", "registry.json"), "utf8"));
    return (reg.hypotheses || []).find((h) => h.id === id) || null;
  } catch {
    return null;
  }
}

/** Прогресс и условия остановки — те же поля, что у списка форвардов. */
function progressOf(f, rows) {
  const times = rows.map((r) => r[f.tField]).filter(Number.isFinite).sort((a, b) => a - b);
  const days = new Set(times.map(dayOf));
  const n = f.byDay ? days.size : rows.length;
  let up = 0, down = 0;
  for (const r of rows) {
    if (r.btcRegime === "btc_up") up++;
    else if (r.btcRegime === "btc_down") down++;
  }
  const regimeTotal = up + down;
  const regimeShare = regimeTotal ? Math.min(up, down) / regimeTotal : null;
  return {
    n, target: f.target, unit: f.unit, pct: (n / f.target) * 100,
    calendarDays: days.size, minCalendarDays: MIN_CALENDAR_DAYS,
    regimeShare, minRegimeShare: MIN_REGIME_SHARE,
    lastT: times[times.length - 1] ?? null,
    ready: n >= f.target && days.size >= MIN_CALENDAR_DAYS && (regimeShare ?? 0) >= MIN_REGIME_SHARE,
  };
}

/** Одна клетка разбора: среднее с CI + таблица «выиграло/проиграло». */
function cell(label, values, dayKeys) {
  return { label, ...winLose(values), stats: stats(values), cluster: clusterCi(values, dayKeys) };
}

export function handleForwardBreakdown(req, res) {
  const id = String(req.params.id || "");
  const f = FORWARDS.find((x) => x.id === id);
  if (!f) {
    // Накопители из БД считает execCostStats.mjs: величина там не на строку.
    const db = DB_FORWARDS.find((x) => x.id === id);
    res.json(db
      ? { ok: true, id, label: db.label, hasMetric: false,
          note: "This one is a cost counter, not a per-trade bet — it is read once by tools/execCostStats.mjs." }
      : { ok: false, reason: "unknown-forward" });
    return;
  }

  let payload;
  try {
    const rows = readJsonl(f.file);
    const prog = progressOf(f, rows);
    const reg = registryEntry(id);
    const head = {
      ok: true, id, label: f.label, hasMetric: !!METRICS[id],
      progress: prog,
      // Правило печатает фронт по-английски из порогов: в реестре оно русское.
      description: reg?.description || null,
    };
    const peek = req.query?.peek === "1";
    if (!prog.ready && !peek) { res.json({ ...head, locked: true }); return; }
    const m = METRICS[id];
    if (!m) { res.json({ ...head, locked: false }); return; }

    const usable = rows.filter((r) => Number.isFinite(r[m.field]) && Number.isFinite(r[f.tField]));
    const values = usable.map((r) => r[m.field]);
    const dayKeys = usable.map((r) => dayOf(r[f.tField]));
    const pick = (fn) => {
      const sel = usable.filter(fn);
      return { values: sel.map((r) => r[m.field]), days: sel.map((r) => dayOf(r[f.tField])) };
    };
    const up = pick((r) => r.btcRegime === "btc_up");
    const down = pick((r) => r.btcRegime === "btc_down");
    const longs = pick((r) => r.side === "LONG");
    const shorts = pick((r) => r.side === "SHORT");

    const all = cell("All", values, dayKeys);
    const cells = [
      cell("BTC up", up.values, up.days),
      cell("BTC down", down.values, down.days),
      cell("LONG", longs.values, longs.days),
      cell("SHORT", shorts.values, shorts.days),
    ].filter((c) => c.n > 0);

    // Ноги пары: без них не видно, какая из них двигает разницу.
    const legs = m.legs
      ? Object.entries(m.legs).map(([name, get]) => {
          const v = usable.map(get).filter(Number.isFinite);
          return { label: name, ...winLose(v), stats: stats(v) };
        })
      : null;

    // Порог из предзаявки: среднее > 0, кластерный CI мимо нуля, тот же знак в
    // обеих клетках режима. Провал любого = отвергнута.
    const upCell = cells.find((c) => c.label === "BTC up");
    const downCell = cells.find((c) => c.label === "BTC down");
    const checks = [
      { label: "mean above zero", pass: all.stats?.mean > 0 },
      { label: "clustered CI clears zero", pass: !!all.cluster && !all.cluster.zeroInside },
      {
        label: "positive in both BTC regimes",
        pass: (upCell?.stats?.mean ?? -1) > 0 && (downCell?.stats?.mean ?? -1) > 0,
      },
    ];

    if (peek && !prog.ready) {
      try {
        mkdirSync(join("data", "hypotheses"), { recursive: true });
        appendFileSync(PEEK_LOG, JSON.stringify({ id, at: new Date().toISOString(), n: prog.n, target: f.target }) + "\n");
      } catch { /* журнал подглядываний не должен ронять ответ */ }
    }

    payload = {
      ...head,
      locked: false,
      peeked: peek && !prog.ready,
      metric: { field: m.field, unit: m.unit, label: m.label },
      all,
      cells,
      legs,
      checks,
      verdict: checks.every((c) => c.pass) ? "passes" : "fails",
    };
  } catch (err) {
    payload = { ok: false, reason: "read-error", message: String(err?.message || err) };
  }
  res.json(payload);
}

/** Сколько раз в незакрытый форвард уже заглядывали (витрина спрашивает). */
export function handleForwardPeeks(_req, res) {
  const rows = existsSync(PEEK_LOG) ? readJsonl(PEEK_LOG) : [];
  const byId = {};
  for (const r of rows) byId[r.id] = (byId[r.id] || 0) + 1;
  res.json({ ok: true, byId, total: rows.length });
}
