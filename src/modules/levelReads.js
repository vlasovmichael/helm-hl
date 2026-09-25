// ─────────────────────────────────────────────────
//  Level reads — журнал разборов страницы уровней и их исходы
// ─────────────────────────────────────────────────
// Каждое открытие разбора пишет сценарии: отскок от S1/R1, пробой вверх и вниз,
// и плацебо-пробой случайного уровня той же геометрии. Через сутки исход
// считается по 15m барам любого ТФ: сработал ли триггер и что было первым,
// стоп или цель.
//
// Выбор монеты делает оператор, поэтому сравнивать группы можно только между
// собой, а не с нулём: плацебо живёт в тех же разборах и несёт тот же отбор.

import { logger } from '../core/logger.js';
import { HL_PRIORITY } from '../core/hlClient.js';
import { getOpenLevelReads, getLevelReads, recordLevelReadRow, resolveLevelRead } from '../core/database.js';
import { getFifteenMinCandles } from './candleCache.js';
import { readPrice, simulate, ACCEPT_BARS } from './dashboard/web/src/features/levelMath.js';

export { simulate };

const BAR_MS = 15 * 60_000;
export const HORIZONS = { h4: 16, h24: 96 };
const LOOKBACK_MIN = 3 * 1440;
// Старше этого 15m-история с HL уже не покрывает сутки после разбора.
const EXPIRE_MS = LOOKBACK_MIN * 60_000 - HORIZONS.h24 * BAR_MS - 2 * 3_600_000;
const INTERVAL_MS = 30 * 60_000;

const round = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : null);

function scenario(id, p, placebo = false) {
  if (!p || p.incomplete) return null;
  return {
    id,
    kind: p.kind,
    side: p.side,
    trigger: round(p.trigger ?? p.entry),
    entry: round(p.entry),
    stop: round(p.stop),
    target: round(p.target),
    atMarket: Boolean(p.atMarket),
    accepted: Boolean(p.accepted),
    thin: Boolean(p.thin),
    netRr: round(p.netRr),
    placebo,
  };
}

/**
 * Плацебо к ждущему пробою: триггер на случайном расстоянии от цены (0.5–2×
 * настоящего), те же расстояния до стопа и цели, та же сторона.
 */
export function placeboFor(real, price, rand = Math.random) {
  if (!real || real.accepted || real.kind !== 'break') return null;
  const dist = Math.abs(real.trigger - price);
  if (!(dist > 0)) return null;
  const sign = real.side === 'long' ? 1 : -1;
  const trigger = price + sign * dist * (0.5 + 1.5 * rand());
  return {
    ...real,
    id: `placebo-${real.side}`,
    trigger: round(trigger),
    entry: round(trigger),
    stop: round(trigger - sign * Math.abs(real.trigger - real.stop)),
    target: round(trigger + sign * Math.abs(real.target - real.trigger)),
    thin: false,
    placebo: true,
  };
}

/** Сценарии разбора в той форме, в какой их видит страница. */
export function scenariosOf(data, rand = Math.random) {
  const read = readPrice(data);
  if (read.kind === 'empty') return [];
  const real = [
    scenario('bounce-long', read.long),
    scenario('bounce-short', read.short),
    scenario('break-up', read.breakUp),
    scenario('break-down', read.breakDown),
  ].filter(Boolean);
  const placebos = real.map((s) => placeboFor(s, data.price, rand)).filter(Boolean);
  return [...real, ...placebos];
}

export function recordLevelRead(data, barTime, now = Date.now()) {
  try {
    const scenarios = scenariosOf(data);
    if (!scenarios.length) return;
    const context = {
      corr: data.btc ? round(data.btc.corr) : null,
      beta: data.btc ? round(data.btc.beta) : null,
      oi: data.oi ? Object.fromEntries(data.oi.windows.map((w) => [w.label, w.mode])) : null,
    };
    recordLevelReadRow({ ts: now, coin: data.coin, tf: data.tf, barTime, price: data.price, scenarios, context });
  } catch (err) {
    logger.warn(`[LevelReads] record ${data?.coin} failed: ${err.message}`);
  }
}

/** Бары, начатые после бара 15m, в котором открыт разбор: всё до них оператор уже видел. */
const barsAfter = (row, bars) => {
  const start = Math.floor(row.ts / BAR_MS) * BAR_MS;
  return bars.filter((b) => b.time > start);
};

export function outcomeOf(row, bars) {
  const after = barsAfter(row, bars);
  const out = {};
  for (const sc of JSON.parse(row.scenarios)) {
    out[sc.id] = Object.fromEntries(Object.entries(HORIZONS).map(([k, n]) => [k, simulate(sc, after, n)]));
  }
  return out;
}

/** Группа сценария для сводки: пробой в тонкий объём против остальных и против плацебо. */
export function groupOf(sc) {
  if (sc.placebo) return 'placebo';
  if (sc.kind === 'break') return sc.thin ? 'break-thin' : 'break';
  return 'bounce';
}

export function summarize(rows) {
  const groups = {};
  for (const row of rows) {
    const scs = JSON.parse(row.scenarios);
    const out = row.outcome ? JSON.parse(row.outcome) : null;
    for (const sc of scs) {
      const g = (groups[groupOf(sc)] ||= { scenarios: 0, resolved: 0, h4: acc(), h24: acc() });
      g.scenarios++;
      if (!out?.[sc.id]) continue;
      g.resolved++;
      for (const h of Object.keys(HORIZONS)) add(g[h], out[sc.id][h]);
    }
  }
  for (const g of Object.values(groups)) {
    for (const h of Object.keys(HORIZONS)) g[h].avgR = g[h].rCount ? g[h].rSum / g[h].rCount : null;
  }
  return groups;
}

const acc = () => ({ triggered: 0, target: 0, stop: 0, open: 0, late: 0, rSum: 0, rCount: 0 });

function add(a, o) {
  if (!o?.triggered) return;
  a.triggered++;
  a[o.how]++;
  if (Number.isFinite(o.r)) {
    a.rSum += o.r;
    a.rCount++;
  }
}

/** Разборы старше суток получают исход; монета грузится один раз на проход. */
export async function resolveLevelReads(now = Date.now()) {
  const due = getOpenLevelReads().filter((r) => r.ts + (HORIZONS.h24 + 2) * BAR_MS <= now);
  if (!due.length) return 0;
  const byCoin = new Map();
  for (const r of due) byCoin.set(r.coin, [...(byCoin.get(r.coin) || []), r]);
  let done = 0;
  for (const [coin, rows] of byCoin) {
    let bars;
    try {
      bars = await getFifteenMinCandles(coin, LOOKBACK_MIN, now, HL_PRIORITY.LOW);
    } catch {
      bars = null;
    }
    for (const r of rows) {
      const after = Array.isArray(bars) ? barsAfter(r, bars).length : 0;
      if (after > HORIZONS.h24) {
        resolveLevelRead(r.id, 'done', outcomeOf(r, bars), now);
        done++;
      } else if (now - r.ts > EXPIRE_MS) {
        resolveLevelRead(r.id, 'expired', null, now);
      }
    }
  }
  return done;
}

export function levelJournal(limit = 1000) {
  const rows = getLevelReads(limit);
  return {
    horizons: HORIZONS,
    acceptBars: ACCEPT_BARS,
    summary: summarize(rows.filter((r) => r.status === 'done')),
    open: rows.filter((r) => r.status === 'open').length,
    recent: rows.slice(0, 40).map((r) => ({
      id: r.id,
      ts: r.ts,
      coin: r.coin,
      tf: r.tf,
      price: r.price,
      status: r.status,
      scenarios: JSON.parse(r.scenarios),
      outcome: r.outcome ? JSON.parse(r.outcome) : null,
    })),
  };
}

export function startLevelReads() {
  const run = () =>
    resolveLevelReads().catch((err) => logger.warn(`[LevelReads] resolve failed: ${err.message}`));
  setTimeout(run, 60_000);
  setInterval(run, INTERVAL_MS);
}
