// ─────────────────────────────────────────────────
//  Форвард по чужим прогнозам — витрина и ручное закрытие
// ─────────────────────────────────────────────────
// Открытые сигнальные позы + журнал, включая ПРОПУЩЕННЫЕ с причиной.
//
// 🚨 Итог отдаётся с доверительным интервалом, и решает интервал: среднее на
// такой выборке скачет на порядок и читается как результат, которого нет.

import { logger } from "../../../core/logger.js";
import { config } from "../../../core/config.js";
import {
  closePosition,
  getActiveTgSignalPositions,
  getTgSignals,
  getTgClaims,
  getStrategyTrades,
} from "../../../core/database.js";
import { calcPnl, FEE_RATE } from "../../executor/math.js";
import { resolvePrice } from "../../paperEntry.js";
import { getAdoptPeakPct } from "../../strategistAdopt.js";

const STRATEGY_ID = "tg_signal";

/** Mark-to-market открытой бумажной позы по текущей цене. */
function markToMarket(pos, price) {
  const side = pos.side || "long";
  const delta = side === "long" ? price - pos.entry_price : pos.entry_price - price;
  const pricePct = pos.entry_price > 0 ? (delta / pos.entry_price) * 100 : 0;
  const pricePnl = (pos.size_usd * delta) / (pos.entry_price || 1);
  const fee = pos.size_usd * FEE_RATE * 2; // вход+выход (оценка)
  const lev = pos.leverage || 1;
  return { price, pricePct, roePct: pricePct * lev, unrealized: pricePnl - fee };
}

/**
 * Сводка по выборке процентов: n, доля побед, среднее и 95% CI.
 * Медиана рядом со средним не для красоты: на выборке из десятка сделок одна
 * штанга уводит среднее куда угодно, и расхождение этих двух чисел — сразу
 * видимый признак, что среднему верить рано.
 */
export function summarize(pcts) {
  const n = pcts.length;
  if (!n) return { n: 0 };
  const wins = pcts.filter((x) => x > 0).length;
  const sorted = [...pcts].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const ci = meanCi(pcts);
  return {
    n,
    winRate: (wins / n) * 100,
    mean: ci.mean,
    median,
    lo: ci.lo,
    hi: ci.hi,
    best: sorted[n - 1],
    worst: sorted[0],
  };
}

/** Среднее и 95% CI (нормальное приближение). */
export function meanCi(xs) {
  const n = xs.length;
  if (n < 2) return n === 1 ? { n, mean: xs[0], lo: null, hi: null } : null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return { n, mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
}

/** GET /api/tg-signals — открытые позы, журнал и итог с CI. */
export async function handleList(_req, res) {
  try {
    const open = getActiveTgSignalPositions();
    const positions = [];
    for (const pos of open) {
      const price = await resolvePrice(pos.coin);
      const mtm = price != null ? markToMarket(pos, price) : null;
      positions.push({
        id: pos.id,
        coin: pos.coin,
        side: (pos.side || "long").toUpperCase(),
        leverage: pos.leverage || 1,
        sizeUsd: pos.size_usd,
        entryPrice: pos.entry_price,
        entryTime: pos.entry_time,
        markPrice: mtm?.price ?? null,
        pricePct: mtm?.pricePct ?? null,
        roePct: mtm?.roePct ?? null,
        unrealized: mtm?.unrealized ?? null,
        stopPrice: Number.isFinite(pos.sl_price) ? pos.sl_price : null,
        targetPrice: Number.isFinite(pos.tp_price) ? pos.tp_price : null,
        peakPct: getAdoptPeakPct(pos.id) || 0,
      });
    }

    // Хэндл канала наружу не отдаём: витрина показывает подпись из настроек.
    const labelOf = (handle) =>
      config.trading.tgSignalChannels.find((c) => c.handle === handle)?.label || handle;

    const journal = getTgSignals(60).map((r) => ({
      id: r.id,
      channel: labelOf(r.channel),
      postedAt: r.posted_at,
      coin: r.coin,
      side: (r.side || "long").toUpperCase(),
      status: r.status,
      skipReason: r.skip_reason,
      positionId: r.position_id,
      entryPrice: r.entry_price,
    }));

    // Только проценты от нотионала: доллары на $10 говорят о размере, не о прогнозе.
    const netPct = (rows) =>
      (rows || [])
        .filter((t) => Number.isFinite(t.realized_pnl) && t.size_usd > 0)
        .map((t) => (t.realized_pnl / t.size_usd) * 100);

    const theirs = netPct(getStrategyTrades(STRATEGY_ID, "PAPER"));
    const mine = netPct(getStrategyTrades("manual_paper", "PAPER"));
    const stats = meanCi(theirs);

    // Третья колонка — витрина: то, что канал публикует о себе сам. Проценты
    // там плечевые, и приводим к 1x только явно подписанные плечом.
    const claims = getTgClaims(400);
    const claimPct = claims.map((c) => c.pct);
    const claimAt1x = claims.filter((c) => c.pct_at_1x != null).map((c) => c.pct_at_1x);

    const comparison = {
      mine: summarize(mine),
      theirs: summarize(theirs),
      claimed: {
        ...summarize(claimPct),
        withLeverage: claimAt1x.length,
        at1x: claimAt1x.length ? summarize(claimAt1x) : { n: 0 },
        lastAt: claims[0]?.posted_at ?? null,
      },
    };

    res.json({
      ok: true,
      enabled: config.trading.tgSignalEnabled,
      channels: config.trading.tgSignalChannels.map((c) => c.label),
      sizeUsd: config.trading.tgSignalSizeUsd,
      leverage: config.trading.tgSignalLeverage,
      positions,
      journal,
      closedCount: theirs.length,
      stats,
      comparison,
      generatedAt: Date.now(),
    });
  } catch (err) {
    logger.warn(`[tgSignals] list failed: ${err.message}`);
    res.status(500).json({ ok: false, positions: [], journal: [], error: true });
  }
}

/** POST /api/tg-signals/close {id} — закрыть сигнальную позу рукой. */
export async function handleClose(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id required" });

    const pos = getActiveTgSignalPositions().find((p) => p.id === id);
    if (!pos) return res.status(404).json({ error: "no open signal position with that id" });

    const price = await resolvePrice(pos.coin);
    if (price == null) return res.status(422).json({ error: `no live price for ${pos.coin}` });

    const now = Date.now();
    const holdHours = (now - pos.entry_time) / 3_600_000;
    const { realizedPnl, totalFee } = calcPnl(pos, price, holdHours, 0, FEE_RATE);
    closePosition(id, {
      close_price: price,
      realized_pnl: realizedPnl,
      fee_paid: totalFee,
      reason: "manual",
      closed_at: now,
      exitFeatures: { hold_seconds: Math.round((now - pos.entry_time) / 1000) },
    });
    logger.info(`[tgSignals] CLOSE #${pos.coin} @ ${price} → ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(4)}`);
    res.json({ ok: true, id, coin: pos.coin, closePrice: price, realizedPnl });
  } catch (err) {
    logger.warn(`[tgSignals] close failed: ${err.message}`);
    res.status(500).json({ error: true });
  }
}
