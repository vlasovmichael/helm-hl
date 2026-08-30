// ─────────────────────────────────────────────────
//  P&L Summary + Insights — realized PnL breakdown
// ─────────────────────────────────────────────────
//
// Возвращает агрегаты realized PnL + per-strategy + utilization + funding по
// 5 периодам (today/yesterday/7d/30d/all). Today/yesterday — server local TZ
// (как воспринимает пользователь), 7d/30d — rolling N*24h, all — без границы.
//
// Funding: query Hyperliquid userFunding API раз в N минут (cache), суммируем
// по period boundaries — с начала торговли, чтобы «All» совпадал с Ledger.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";
import { getAccountSummary, getPositionsCached } from "../../exchange.js";
import { getAccountEquity } from "../../wallet.js";
import {
  getActivePosition,
  getHistory,
  getDayNote,
  setDayNote,
} from "../../../core/database.js";
import { getAllRoundTrips } from "./manualTrades.js";

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "d7", label: "7d" },
  { key: "d30", label: "30d" },
  { key: "all", label: "All" },
];

function periodBoundaries(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const todayStart = d.getTime();
  return {
    today: { start: todayStart, end: now },
    yesterday: { start: todayStart - 24 * 3600_000, end: todayStart },
    d7: { start: now - 7 * 24 * 3600_000, end: now },
    d30: { start: now - 30 * 24 * 3600_000, end: now },
    all: { start: 0, end: now },
  };
}

const FUNDING_CACHE_TTL_MS = 5 * 60_000;
let fundingCache = { ts: 0, deltas: [] }; // deltas: [{ts, usdc}]

async function getFundingHistory() {
  if (
    Date.now() - fundingCache.ts < FUNDING_CACHE_TTL_MS &&
    fundingCache.deltas.length > 0
  ) {
    return fundingCache.deltas;
  }
  // userFunding возвращает все funding-payments (uPnL делится на ts + usdc).
  // Окно — с начала торговли, как у Ledger: на 60 днях период «All» показывал
  // funding −$0.08 против +$1.95 в Ledger, и итоги двух витрин расходились.
  try {
    const startTime = Date.UTC(2026, 3, 1);
    const data = await hlInfo(
      {
        type: "userFunding",
        user: config.wallet.address,
        startTime,
      },
      { label: "dash/userFunding", timeoutMs: 8000, priority: HL_PRIORITY.LOW },
    );
    if (!Array.isArray(data)) return fundingCache.deltas;
    // Каждый элемент: { time, hash, delta: { coin, usdc, szi, fundingRate, nSamples } }
    const deltas = data
      .map((it) => ({
        ts: it.time,
        usdc: parseFloat(it.delta?.usdc ?? "0"),
      }))
      .filter((x) => Number.isFinite(x.usdc));
    fundingCache = { ts: Date.now(), deltas };
    return deltas;
  } catch (err) {
    logger.debug(`[Dashboard] userFunding fetch failed: ${err.message}`);
    return fundingCache.deltas; // stale-OK
  }
}

function sumFundingInRange(deltas, start, end) {
  let sum = 0;
  for (const d of deltas) {
    if (d.ts >= start && d.ts < end) sum += d.usdc;
  }
  return sum;
}

function computeStats(trades, equityRef = 0) {
  if (trades.length === 0) {
    return {
      totalPnl: 0,
      count: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      payoffRatio: 0,
      expectancy: 0,
      bestPnl: 0,
      worstPnl: 0,
      byStrategy: {},
      totalHoldMs: 0,
      totalFees: 0,
      grossPnl: 0,
      feesPctOfGross: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
    };
  }
  let totalPnl = 0,
    wins = 0,
    losses = 0;
  let winsSum = 0,
    lossesSum = 0;
  let bestPnl = -Infinity,
    worstPnl = Infinity;
  let totalFees = 0;
  const byStrategy = {};
  let totalHoldMs = 0;
  for (const t of trades) {
    const pnl = t.realized_pnl || 0;
    const fee = t.fee_paid || 0;
    totalPnl += pnl;
    totalFees += fee;
    if (pnl > 0) {
      wins++;
      winsSum += pnl;
    } else if (pnl < 0) {
      losses++;
      lossesSum += pnl;
    }
    if (pnl > bestPnl) bestPnl = pnl;
    if (pnl < worstPnl) worstPnl = pnl;
    const sid = t.strategy_id || "carry";
    if (!byStrategy[sid]) byStrategy[sid] = { pnl: 0, count: 0, wins: 0 };
    byStrategy[sid].pnl += pnl;
    byStrategy[sid].count += 1;
    if (pnl > 0) byStrategy[sid].wins += 1;
    if (t.entry_time && t.closed_at) {
      totalHoldMs += Math.max(0, t.closed_at - t.entry_time);
    } else if (t.hold_seconds) {
      totalHoldMs += t.hold_seconds * 1000;
    }
  }
  const count = trades.length;
  const winRate = count > 0 ? (wins / count) * 100 : 0;
  const avgPnl = totalPnl / count;
  const avgWin = wins > 0 ? winsSum / wins : 0;
  const avgLoss = losses > 0 ? lossesSum / losses : 0; // negative
  const payoffRatio = losses > 0 && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : (wins > 0 ? Infinity : 0);
  // expectancy = WR·avgWin + LR·avgLoss; математически = avgPnl.
  // Дублируем explicit как самостоятельную метрику для UI.
  const expectancy = avgPnl;
  const grossPnl = totalPnl + totalFees;
  const feesPctOfGross = grossPnl !== 0 ? (totalFees / Math.abs(grossPnl)) * 100 : 0;

  // Max drawdown по equity-кривой: сортируем по closed_at, считаем cumPnL,
  // отслеживаем пик и максимальную просадку от пика.
  const sorted = [...trades].sort((a, b) => (a.closed_at || 0) - (b.closed_at || 0));
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.realized_pnl || 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  // % просадки считаем от equity счёта — это осмысленный знаменатель.
  // Старый вариант (пик кумулятивного P&L) взрывался до сотен %, когда пик
  // был копеечный: $2.41 просадки / $0.88 пик = 273%. equityRef=0 (API
  // недоступен) → null, и UI просто не показывает процент.
  const maxDrawdownPct = equityRef > 0 ? (maxDD / equityRef) * 100 : null;

  return {
    totalPnl,
    count,
    wins,
    losses,
    winRate,
    avgPnl,
    avgWin,
    avgLoss,
    payoffRatio: Number.isFinite(payoffRatio) ? payoffRatio : null,
    expectancy,
    bestPnl: bestPnl === -Infinity ? 0 : bestPnl,
    worstPnl: worstPnl === Infinity ? 0 : worstPnl,
    byStrategy,
    totalHoldMs,
    totalFees,
    grossPnl,
    feesPctOfGross,
    maxDrawdown: maxDD,
    maxDrawdownPct,
  };
}

export async function handlePnlSummary(_req, res) {
  try {
    const now = Date.now();
    const bounds = periodBoundaries(now);
    const fundingDeltas = await getFundingHistory();

    // Equity счёта — знаменатель для maxDrawdown %. Падение API не критично:
    // equityNow=0 → computeStats вернёт maxDrawdownPct=null и UI скроет процент.
    let equityNow = 0;
    try {
      equityNow = config.isProduction
        ? (await getAccountSummary()).equity
        : await getAccountEquity();
    } catch {
      /* equityNow=0 → процент просадки не показываем */
    }

    // ЕДИНЫЙ источник с Monthly Ledger — round-trip'ы из HL fills. Раньше
    // бот-сделки брались из history-таблицы, а ручные из fills за 60 дней:
    // «All» показывала −$47.59 против −$156.78 в Ledger, потому что ручные
    // сделки апреля–июня в окно не попадали, а history после rebuild'ов
    // неполная (живых строк 1, всё остальное в архиве). Теперь обе части
    // приходят из одного места и по определению сходятся.
    const roundTrips = (await getAllRoundTrips()).filter((t) => t.status === "closed");

    // Приводим к контракту history-строки, который ждёт computeStats:
    // realized_pnl уже NET комиссий (t.pnl — price PnL ДО них).
    const asHistoryRow = (t) => ({
      coin: t.coin,
      side: t.side,
      realized_pnl: (t.pnl || 0) - (t.fee || 0),
      fee_paid: t.fee || 0,
      strategy_id: t.source === "manual" ? "manual" : t.source === "adopted" ? "adopt" : "bot",
      entry_time: t.entryTime,
      closed_at: t.closeTime,
      mode: "PRODUCTION",
    });

    // «Бот» для сравнения = всё, что вёл бот сам или подхватил нянька.
    const allTrades = roundTrips.filter((t) => t.source !== "manual").map(asHistoryRow);
    const manualTrades = roundTrips.filter((t) => t.source === "manual");

    const openPos = getActivePosition();
    let unrealized = 0;
    try {
      if (openPos && config.isProduction) {
        const positions = await getPositionsCached();
        const livePos = positions.find((p) => p.coin === openPos.coin);
        if (livePos) unrealized = parseFloat(livePos.unrealizedPnl ?? "0");
      }
    } catch {
      /* leave unrealized=0 */
    }

    const result = {};
    for (const { key } of PERIODS) {
      const { start, end } = bounds[key];
      const inRange = allTrades.filter(
        (t) => t.closed_at >= start && t.closed_at < end,
      );

      // Manual split: trades закрытые в этом окне.
      const manualInRange = manualTrades.filter(
        (m) =>
          m.status === "closed" && m.closeTime >= start && m.closeTime < end,
      );

      // Normalize manual trades to the shape computeStats() expects so они
      // попадают во все метрики (avg, expectancy, best/worst, wins/losses,
      // payoff, maxDD, fees) единым набором с bot trades.
      // m.pnl из реконструкции = price PnL ДО комиссий (Σ closedPnl), m.fee отдельно.
      // DB-сделки в history несут realized_pnl УЖЕ net of fees → приводим manual к
      // тому же контракту (net), иначе grossPnl = totalPnl + totalFees задвоит комиссию.
      const manualAsBotShape = manualInRange.map((m) => ({
        realized_pnl: (m.pnl || 0) - (m.fee || 0),
        fee_paid: m.fee || 0,
        strategy_id: "manual",
        entry_time: m.entryTime,
        closed_at: m.closeTime,
      }));
      const combined = [...inRange, ...manualAsBotShape];
      const stats = computeStats(combined, equityNow);
      const botStats = computeStats(inRange, equityNow);

      const periodMs =
        key === "all"
          ? combined.length > 0
            ? now - Math.min(...combined.map((t) => t.closed_at))
            : 1
          : end - start;
      const utilizationPct =
        periodMs > 0 ? Math.min(100, (stats.totalHoldMs / periodMs) * 100) : 0;
      const funding = sumFundingInRange(fundingDeltas, start, end);

      // net (− fee), консистентно с combined-метриками выше.
      const manualPnl = manualInRange.reduce(
        (s, m) => s + (m.pnl || 0) - (m.fee || 0),
        0,
      );
      const manualCount = manualInRange.length;
      const manualWins = manualInRange.filter(
        (m) => (m.pnl || 0) - (m.fee || 0) > 0,
      ).length;

      result[key] = {
        ...stats,
        utilizationPct,
        funding,
        // Price-only PnL = realized_pnl − funding_collected. Если funding_collected NULL
        // (старые записи) — fallback: показываем total как есть, отдельно period funding.
        pricePnl: stats.totalPnl,
        // Bot vs manual split (2026-05-13): bot = bot-only stats, manual = reconstructed.
        bot: {
          pnl: botStats.totalPnl,
          count: botStats.count,
          wins: botStats.wins,
        },
        manual: {
          pnl: manualPnl,
          count: manualCount,
          wins: manualWins,
        },
      };
    }

    res.json({
      now,
      bounds,
      periods: result,
      unrealized,
      activeCoin: openPos?.coin || null,
      activeStrategy: openPos?.strategy_id || null,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/pnl-summary error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────
//  Insights — per-coin lifetime + daily P&L heatmap (90d)
// ─────────────────────────────────────────────────
// Pure-агрегация Insights. Вход — закрытые round-trip'ы в shape computeStats
// (+ coin, side). Выход: perCoin (lifetime), daily (хитмап), bySide (long/short),
// byStrategy (bot/adopted/manual). Вынесено отдельно и экспортировано для теста.
export function buildInsights(combined) {
  // ── Per-coin aggregation (lifetime, all periods) ──
  const byCoin = new Map();
  for (const t of combined) {
    const c = (t.coin || "?").toUpperCase();
    if (!byCoin.has(c)) {
      byCoin.set(c, {
        coin: c,
        trades: 0,
        pnl: 0,
        wins: 0,
        losses: 0,
        fees: 0,
        lastClosedAt: 0,
      });
    }
    const row = byCoin.get(c);
    row.trades += 1;
    const pnl = t.realized_pnl || 0;
    row.pnl += pnl;
    row.fees += t.fee_paid || 0;
    if (pnl > 0) row.wins += 1;
    else if (pnl < 0) row.losses += 1;
    if ((t.closed_at || 0) > row.lastClosedAt) row.lastClosedAt = t.closed_at;
  }
  const perCoin = [...byCoin.values()]
    .map((r) => ({
      ...r,
      avg: r.trades > 0 ? r.pnl / r.trades : 0,
      winRate: r.trades > 0 ? (r.wins / r.trades) * 100 : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  // ── Daily P&L across full history (heatmap, в UI сгруппирован по месяцам/годам) ──
  // Возвращаем ТОЛЬКО дни с торговлей (без заливки пустых) — фронт сам строит
  // календарную сетку по месяцам и подставляет дни по date-ключу. Окно не
  // ограничено 90 днями: фронт листает года. День в локальной зоне: YYYY-MM-DD.
  const localDayKey = (ts) => {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const dailyMap = new Map();
  for (const t of combined) {
    if (!t.closed_at) continue;
    const key = localDayKey(t.closed_at);
    if (!dailyMap.has(key)) dailyMap.set(key, { date: key, pnl: 0, trades: 0 });
    const row = dailyMap.get(key);
    row.pnl += t.realized_pnl || 0;
    row.trades += 1;
  }
  const daily = [...dailyMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // ── Срезы LONG/SHORT и по стратегии с expectancy/payoff ──
  // Проект: эдж = шорты (лонги хрупкие), главный леак = payoff → выносим эти
  // метрики на страницу. computeStats даёт expectancy/payoff на любой подвыборке.
  const summarize = (subset) => {
    const s = computeStats(subset);
    return {
      trades: s.count,
      pnl: s.totalPnl,
      winRate: s.winRate,
      avgPnl: s.avgPnl,
      expectancy: s.expectancy,
      payoffRatio: s.payoffRatio,
    };
  };
  const bucket = (keyFn) => {
    const m = new Map();
    for (const t of combined) {
      const k = keyFn(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return m;
  };
  const bySide = [...bucket((t) => (t.side || "?").toLowerCase()).entries()]
    .map(([side, arr]) => ({ side, ...summarize(arr) }))
    .sort((a, b) => b.trades - a.trades);
  const byStrategy = [...bucket((t) => t.strategy_id || "?").entries()]
    .map(([strategy, arr]) => ({ strategy, ...summarize(arr) }))
    .sort((a, b) => b.pnl - a.pnl);

  return { perCoin, daily, bySide, byStrategy };
}

// ─────────────────────────────────────────────────
//  Exit quality — MFE/MAE excursion analysis
// ─────────────────────────────────────────────────
// Проф-метрика (Tradezella/Edgewise): насколько хорошо мы ВЫХОДИМ. Источник —
// DB-таблица history (бот трекает intra-trade peak/trough), НЕ fills: из fills
// excursion не восстановить. Покрывает ТОЛЬКО adopt-сделки (мой ручной вход +
// выход боту) с записанным mfe/mae — бумажные стратегии бота исключены.
//
// · capture = realized / MFE — какую долю доступного хода забрали (только winners,
//   MFE>0). Низкий % = выход рано/трейл отдаёт; ~50%+ = крепко. Гнаться за 100%
//   нельзя — MFE это мгновенный пик, не достижимая цель.
// · leftOnTable = MFE − realized ($, сколько отдали от пика).
// · heat (MAE) на winners = сколько «терпели» до разворота (тайминг входа / нож).
// · roundTripped = был в заметном плюсе (MFE≥floor), закрылся в минус — худший
//   тип выхода (зелёную в красную).
export function buildExcursion(rows) {
  const ROUNDTRIP_FLOOR = 0.3; // $ — порог «был заметно в плюсе», глушит шум

  // «Мои» сделки = adopt (ручной вход, выход боту). Бумажные стратегии бота
  // (hunter*/fadehot) тоже трекают mfe/mae, но это НЕ мои выходы — они засоряют
  // статистику качества выходов. Оставляем только рабочий контур оператора (см.
  // memory working_contour_focus_manual_entry_bot_exit).
  const mine = (rows || []).filter((t) => t.strategy_id === "adopt");

  // Дедуп фантомных дублей: adopt flip-merge двоит round-trip (тот же coin/side/pnl,
  // закрытие в пределах пары секунд — см. memory adopt_flip_merge_bug). Оставляем
  // первый по closed_at, чтобы счёт сделок и средние не двоились.
  const sorted = [...mine].sort((a, b) => (a.closed_at || 0) - (b.closed_at || 0));
  const kept = [];
  let dupsRemoved = 0;
  for (const t of sorted) {
    const dup = kept.find(
      (s) =>
        s.coin === t.coin &&
        s.side === t.side &&
        Math.abs((s.realized_pnl || 0) - (t.realized_pnl || 0)) < 1e-6 &&
        Math.abs((s.closed_at || 0) - (t.closed_at || 0)) < 60_000,
    );
    if (dup) {
      dupsRemoved++;
      continue;
    }
    kept.push(t);
  }

  const trades = kept
    .filter((t) => t.mfe_usd != null && t.close_price != null)
    .map((t) => ({
      coin: (t.coin || "?").toUpperCase(),
      side: (t.side || "?").toLowerCase(),
      strategy: t.strategy_id || "?",
      pnl: t.realized_pnl || 0,
      mfeUsd: t.mfe_usd ?? null,
      maeUsd: t.mae_usd ?? null,
      closedAt: t.closed_at || 0,
      capture:
        t.mfe_usd > 0 ? (t.realized_pnl || 0) / t.mfe_usd : null,
    }))
    .sort((a, b) => b.closedAt - a.closedAt);

  const winners = trades.filter((t) => t.pnl > 0 && t.mfeUsd > 0);
  const mean = (arr, fn) =>
    arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : null;

  const roundTripped = trades.filter(
    (t) => t.mfeUsd >= ROUNDTRIP_FLOOR && t.pnl < 0,
  ).length;

  return {
    sample: trades.length,
    winners: winners.length,
    dupsRemoved,
    avgCapturePct: mean(winners, (t) => t.capture * 100),
    avgLeftOnTable: mean(winners, (t) => t.mfeUsd - t.pnl),
    avgHeat: mean(winners, (t) => Math.abs(t.maeUsd ?? 0)),
    roundTripped,
    rows: trades,
  };
}

export async function handleInsights(_req, res) {
  try {
    const now = Date.now();

    // ЕДИНЫЙ источник = HL fills (тот же reconstructRoundTrips, что у Monthly
    // Ledger) → Insights сходится с Ledger. Раньше bot брался из trades.db
    // (теряет историю при порче БД, см. ledger.js), а manual — из fills: две
    // правды не сходились. reconstructRoundTrips отдаёт pnl = price PnL ДО комиссий
    // (Σ closedPnl), fee отдельно → приводим к net (pnl − fee), чтобы realized_pnl
    // совпадал с DB-контрактом и итоги Insights сходились с P&L Summary.
    const roundTrips = await getAllRoundTrips();
    const combined = roundTrips
      .filter((t) => t.status === "closed")
      .map((t) => ({
        coin: t.coin,
        realized_pnl: (t.pnl || 0) - (t.fee || 0),
        fee_paid: t.fee || 0,
        strategy_id: t.source, // bot | adopted | manual
        side: t.side, // long | short
        entry_time: t.entryTime,
        closed_at: t.closeTime,
      }));

    // Excursion (exit quality) — отдельный источник: DB history с mfe/mae.
    // Fail-soft: ошибка чтения не валит весь Insights.
    let excursion = null;
    try {
      excursion = buildExcursion(getHistory(500));
    } catch (e) {
      logger.warn(`[Dashboard] excursion build failed: ${e.message}`);
    }

    res.json({ now, ...buildInsights(combined), excursion });
  } catch (err) {
    logger.warn(`[Dashboard] /api/insights error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────
//  Day journal — разбор дня по клику в календаре Insights
// ─────────────────────────────────────────────────
// GET /api/day-journal?date=YYYY-MM-DD → сделки дня (из тех же round-trip'ов,
// что Insights/Ledger) + сохранённая заметка. Сделки фильтруем по локальному
// дню закрытия — ровно как daily-хитмап (localDayKey в buildInsights).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const localDayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function handleDayJournal(req, res) {
  try {
    const date = String(req.query.date || "");
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const roundTrips = await getAllRoundTrips();
    const trades = roundTrips
      .filter((t) => t.status === "closed" && t.closeTime && localDayKey(t.closeTime) === date)
      .map((t) => ({
        coin: t.coin,
        side: t.side, // long | short
        source: t.source, // bot | adopted | manual
        // net (− fee) — совпадает с DB realized_pnl и клеткой хитмапа.
        pnl: (t.pnl || 0) - (t.fee || 0),
        fee: t.fee || 0,
        entryTime: t.entryTime || null,
        closeTime: t.closeTime,
      }))
      .sort((a, b) => a.closeTime - b.closeTime);

    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const fees = trades.reduce((s, t) => s + t.fee, 0);
    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl < 0).length;

    res.json({
      date,
      note: getDayNote(date),
      summary: { trades: trades.length, pnl, fees, wins, losses },
      trades,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/day-journal error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

export function handleDayNoteSave(req, res) {
  try {
    const date = String(req.body?.date || "");
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    setDayNote(date, req.body?.note ?? "");
    res.json({ ok: true, date, note: getDayNote(date) });
  } catch (err) {
    logger.warn(`[Dashboard] /api/day-journal save error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
