// ─────────────────────────────────────────────────
//  Торговый журнал: контекст входа, итог и авто-метки по каждой закрытой
//  сделке + разрезы с кластерным CI по дням. Чистая функция: роут дашборда и
//  дев-превью считают одним кодом.
//
//  🚨 Метка — описание сделки, а не вердикт. Вывод «метка стоит денег» только
//  по разрезу с CI, у одной сделки его нет.
//  🚨 Заметки об исходе заданы результатом сделки: в разрезы и в сравнение
//  «помеченные / чистые» не входят, иначе минус у них получается по построению.
// ─────────────────────────────────────────────────
import { clusterCi } from "../../tools/researchStats.mjs";

export const SESSIONS = [
  { key: "asia", label: "Asia", fromUtc: 0, toUtc: 7 },
  { key: "europe", label: "Europe", fromUtc: 7, toUtc: 13 },
  { key: "us", label: "US", fromUtc: 13, toUtc: 20 },
  { key: "late", label: "Late US", fromUtc: 20, toUtc: 24 },
];

export const TREND_FLAT_PCT = 0.3;
export const CHASE_PCT = 3;
export const REVENGE_MS = 30 * 60_000;
export const DAY_TRADE_LIMIT = 5;
export const GAVE_BACK_MFE_PCT = 1;
const WEEK_MS = 7 * 86_400_000;

export const FLAGS = {
  revenge: "Re-entry within 30 min of a loss",
  overtrading: `Trade ${DAY_TRADE_LIMIT + 1}+ of the day`,
  counterTrend: "Against the 1h trend",
  chased: `Entered after a ${CHASE_PCT}%+ 15m move`,
};

export const OUTCOME_NOTES = {
  gaveBack: `Was up ${GAVE_BACK_MFE_PCT}%+, closed red`,
};

const TREND_LABELS = { with: "With 1h trend", flat: "Flat 1h", against: "Against 1h trend", unknown: "No 1h data" };
const HOLD_BUCKETS = [
  { key: "lt15m", label: "Under 15m", maxSeconds: 15 * 60 },
  { key: "lt1h", label: "15m – 1h", maxSeconds: 3600 },
  { key: "lt4h", label: "1h – 4h", maxSeconds: 4 * 3600 },
  { key: "gte4h", label: "4h and longer", maxSeconds: Infinity },
];

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const warsawDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" });

export function sessionOf(ms) {
  const hour = new Date(ms).getUTCHours();
  return SESSIONS.find((session) => hour >= session.fromUtc && hour < session.toUtc).key;
}

/** Номинал из прямого поля или из пары MFE/MAE в долларах и процентах. */
export function notionalOf(row) {
  if (finite(row.size_usd) && Number(row.size_usd) > 0) return Number(row.size_usd);
  for (const [usd, pct] of [["mfe_usd", "mfe_pct"], ["mae_usd", "mae_pct"]]) {
    if (finite(row[usd]) && finite(row[pct]) && Math.abs(Number(row[pct])) > 1e-9) {
      return Math.abs(Number(row[usd]) / (Number(row[pct]) / 100));
    }
  }
  return null;
}

export function trendAlignment(row) {
  if (!finite(row.entry_trend_1h_pct)) return "unknown";
  const aligned = Number(row.entry_trend_1h_pct) * (row.side === "short" ? -1 : 1);
  if (aligned > TREND_FLAT_PCT) return "with";
  if (aligned < -TREND_FLAT_PCT) return "against";
  return "flat";
}

function entryTimeOf(row) {
  if (finite(row.entry_time)) return Number(row.entry_time);
  if (finite(row.hold_seconds)) return row.closed_at - Number(row.hold_seconds) * 1000;
  return row.closed_at;
}

/** Каждая сделка с контекстом входа и метками; порядок — по времени входа. */
export function enrichTrades(rows) {
  const byEntry = rows.map((row) => ({ row, entryTime: entryTimeOf(row) })).sort((a, b) => a.entryTime - b.entryTime);
  const byClose = [...rows].sort((a, b) => a.closed_at - b.closed_at);
  const perDay = new Map();
  return byEntry.map(({ row, entryTime }) => {
    const direction = row.side === "short" ? -1 : 1;
    const day = warsawDay.format(entryTime);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    const previous = byClose.findLast((other) => other !== row && other.closed_at <= entryTime);
    const notional = notionalOf(row);
    const net = Number(row.realized_pnl) || 0;
    const trend = trendAlignment(row);
    const flags = [];
    if (previous && previous.realized_pnl < 0 && entryTime - previous.closed_at <= REVENGE_MS) flags.push("revenge");
    if (perDay.get(day) > DAY_TRADE_LIMIT) flags.push("overtrading");
    if (trend === "against") flags.push("counterTrend");
    if (finite(row.entry_trend_15m_pct) && Number(row.entry_trend_15m_pct) * direction >= CHASE_PCT) flags.push("chased");
    const notes = [];
    if (finite(row.mfe_pct) && Number(row.mfe_pct) >= GAVE_BACK_MFE_PCT && net < 0) notes.push("gaveBack");
    return {
      coin: row.coin,
      side: row.side === "short" ? "short" : "long",
      entryTime,
      closedAt: row.closed_at,
      session: sessionOf(entryTime),
      trend,
      trend1hPct: finite(row.entry_trend_1h_pct) ? Number(row.entry_trend_1h_pct) : null,
      move15mPct: finite(row.entry_trend_15m_pct) ? Number(row.entry_trend_15m_pct) : null,
      holdSeconds: finite(row.hold_seconds) ? Number(row.hold_seconds) : null,
      mfePct: finite(row.mfe_pct) ? Number(row.mfe_pct) : null,
      maePct: finite(row.mae_pct) ? Number(row.mae_pct) : null,
      net,
      netPct: notional ? (net / notional) * 100 : null,
      fees: Number(row.fee_paid) || 0,
      reason: row.reason ?? null,
      flags,
      notes,
    };
  });
}

export function summarize(trades) {
  if (!trades.length) return { n: 0 };
  const values = trades.map((trade) => trade.net);
  const net = values.reduce((a, b) => a + b, 0);
  const wins = values.filter((value) => value > 0).length;
  const ci = clusterCi(values, trades.map((trade) => warsawDay.format(trade.closedAt)));
  return {
    n: trades.length,
    net,
    fees: trades.reduce((a, trade) => a + trade.fees, 0),
    winPct: (wins / trades.length) * 100,
    avg: net / trades.length,
    ci95: ci ? [ci.lo, ci.hi] : null,
    days: ci?.days ?? null,
  };
}

function breakdown(trades, groups) {
  return groups.map(({ key, label, match }) => ({ key, label, ...summarize(trades.filter(match)) }));
}

export function buildTradeJournal(rows, { now = Date.now(), recent = 50 } = {}) {
  const trades = enrichTrades(rows.filter((row) => finite(row.closed_at)));
  if (!trades.length) return { empty: true, flags: FLAGS, notes: OUTCOME_NOTES };
  const flagged = trades.filter((trade) => trade.flags.length);
  const holdKey = (seconds) => HOLD_BUCKETS.find((bucket) => seconds < bucket.maxSeconds)?.key;
  return {
    asOf: now,
    period: { from: Math.min(...trades.map((t) => t.closedAt)), to: Math.max(...trades.map((t) => t.closedAt)) },
    flags: FLAGS,
    notes: OUTCOME_NOTES,
    overall: { ...summarize(trades), flagged: summarize(flagged), clean: summarize(trades.filter((t) => !t.flags.length)) },
    breakdowns: {
      session: breakdown(trades, SESSIONS.map((s) => ({ key: s.key, label: `${s.label} · ${s.fromUtc}–${s.toUtc} UTC`, match: (t) => t.session === s.key }))),
      side: breakdown(trades, ["long", "short"].map((side) => ({ key: side, label: side === "long" ? "Long" : "Short", match: (t) => t.side === side }))),
      trend: breakdown(trades, Object.entries(TREND_LABELS).map(([key, label]) => ({ key, label, match: (t) => t.trend === key }))),
      hold: breakdown(trades, [
        ...HOLD_BUCKETS.map((b) => ({ key: b.key, label: b.label, match: (t) => t.holdSeconds !== null && holdKey(t.holdSeconds) === b.key })),
        { key: "unknown", label: "No hold data", match: (t) => t.holdSeconds === null },
      ]),
      flags: breakdown(trades, [
        { key: "clean", label: "No flags", match: (t) => !t.flags.length },
        ...Object.entries(FLAGS).map(([key, label]) => ({ key, label, match: (t) => t.flags.includes(key) })),
      ]),
    },
    week: {
      current: summarize(trades.filter((t) => t.closedAt > now - WEEK_MS && t.closedAt <= now)),
      previous: summarize(trades.filter((t) => t.closedAt > now - 2 * WEEK_MS && t.closedAt <= now - WEEK_MS)),
    },
    trades: [...trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, recent),
  };
}
