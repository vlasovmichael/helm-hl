// ─────────────────────────────────────────────────
//  Research routes — витрина форвард-тестов
// ─────────────────────────────────────────────────
// Список форвардов и их прогресс — из src/modules/forwards.js, того же модуля,
// что у сторожа: витрина и пуши не должны разойтись в том, что считать живым.
//
// Каждая карточка обязана показывать возраст данных: замёрзший снимок без
// него выглядит живым.

import { join } from "node:path";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { readJsonl, stats, clusterCi, winLose } from "../../../../tools/researchStats.mjs";
import { FORWARDS, classifyHypotheses, forwardProgress, readRegistry } from "../../forwards.js";
import { latestAutoEvals } from "../../../app/forwardWatch.js";

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

// ── Все форварды одним списком ──────────────────────────────────────────────
// Идущие — со счётчиком, завершённые — с исходом из реестра, открытые без
// сборщика — одной строкой. Метрик результата здесь нет.
export const handleForwards = served("forwards", () => {
  const now = Date.now();
  const registry = readRegistry();
  const { running, finished, idle } = classifyHypotheses(registry, FORWARDS, now);
  const evals = latestAutoEvals();
  const items = [];
  for (const f of running) {
    let rows;
    try {
      rows = f.rows() || [];
    } catch {
      continue; // таблицы ещё нет — накопитель просто не показываем
    }
    const p = forwardProgress(f, rows, now);
    const { lastT: _lastT, ...progress } = p;
    items.push({
      id: f.id, label: f.label, note: f.note ?? null,
      ...progress,
      autoEvalAt: evals[f.id]?.at ?? null,
    });
  }
  return {
    items,
    finished,
    idle,
    registryLoaded: !!registry,
    decisionRule: "each one is evaluated exactly once, on its own terms from the registry",
  };
});

// ── Разбор одного форварда ──────────────────────────────────────────────────
// 🚨 Подглядывание ломает предзаявку. Ручка его не запрещает, но требует явный
// `?peek=1` и пишет просмотр в data/hypotheses/peeks.jsonl: результат, увиденный
// до срока, перестаёт быть чистым тестом, и это должно остаться записанным.
const PEEK_LOG = join("data", "hypotheses", "peeks.jsonl");

// Величина гипотезы — по одной на форвард. Нет строки = метрики на строку нет.
const METRICS = {
  "fvg-wide-retest-4h": { field: "rNet", unit: "R", label: "net R per trade" },
};

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** Одна клетка разбора: среднее с CI + таблица «выиграло/проиграло». */
function cell(label, values, dayKeys) {
  return { label, ...winLose(values), stats: stats(values), cluster: clusterCi(values, dayKeys) };
}

export function handleForwardBreakdown(req, res) {
  const id = String(req.params.id || "");
  const f = FORWARDS.find((x) => x.id === id);
  if (!f) { res.json({ ok: false, reason: "unknown-forward" }); return; }

  let payload;
  try {
    const rows = f.rows() || [];
    const prog = forwardProgress(f, rows);
    const reg = (readRegistry()?.hypotheses || []).find((h) => h.id === id) || null;
    const head = {
      ok: true, id, label: f.label, hasMetric: !!METRICS[id],
      progress: prog,
      // Правило печатает фронт по-английски из порогов: в реестре оно русское.
      description: reg?.description || null,
      note: f.note || null,
    };
    // Без величины на строку разбора нет: есть только вывод оценки по предзаявке,
    // который сторож снял на пороге.
    if (!METRICS[id]) {
      const ev = latestAutoEvals()[id] || null;
      res.json({
        ...head, locked: false,
        autoEval: ev ? { at: ev.at, command: ev.command, exitCode: ev.exitCode, output: ev.output } : null,
        evalCommand: f.evalCommand ? f.evalCommand.join(" ") : null,
      });
      return;
    }
    const peek = req.query?.peek === "1";
    if (!prog.ready && !peek) { res.json({ ...head, locked: true }); return; }
    const m = METRICS[id];

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
