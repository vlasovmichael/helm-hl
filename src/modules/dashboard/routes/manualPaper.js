// ─────────────────────────────────────────────────
//  Личный paper-журнал (manual_paper) — открыть/закрыть/список
// ─────────────────────────────────────────────────
// «Свой папер как в Rabbit, только на бумаге»: оператор видит движуху в Hot Movers,
// жмёт кнопку → модалка (монета/сторона/плечо/слайдер от реального депо) →
// открывается бумажная позиция strategy_id='manual_paper', mode='PAPER'.
//
// Вход рукой, выход ведёт нянька (app/manualPaperSupervise.js) — тем же кодом,
// что и реальный adopt. Оператор может закрыть кнопкой в любой момент. Цена
// остаётся свежей сама (scout пиннит все PAPER-коины через getActivePaperCoins)
// → live mark-to-market. Архив закрытых сделок поднимается в таблицу Strategies
// через обычные getStrategyStats (history с тем же strategy_id).
//
// Multi-slot (как adopt): можно держать несколько бумажных входов разом.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { closePosition, getActiveManualPaperPositions } from "../../../core/database.js";
import { getLivePriceMap } from "../../exchange.js";
import { calcPnl, FEE_RATE } from "../../executor/math.js";
import { openPaperPosition, resolvePrice, safeEquity } from "../../paperEntry.js";
import { getAdoptPeakPct } from "../../strategistAdopt.js";
import { getUniverse } from "../../../core/universe.js";

const STRATEGY_ID = "manual_paper";
const MAX_SLOTS = 8;          // потолок одновременных бумажных входов
const MAX_LEVERAGE = 50;

/** Список торгуемых монет (с живой ценой) для автоподстановки. [] при ошибке. */
async function availableCoins() {
  try {
    const map = await getLivePriceMap(); // Map<coin, px>
    return [...map.keys()].sort();
  } catch {
    return [];
  }
}

/** Карта COIN(UPPERCASE) → maxLeverage из universe (HL meta). {} если пусто. */
function leverageByCoin() {
  const out = {};
  for (const a of getUniverse()) {
    const lev = Number(a?.maxLeverage);
    if (a?.name && Number.isFinite(lev) && lev > 0) out[a.name.toUpperCase()] = lev;
  }
  return out;
}

/** Mark-to-market открытой бумажной позы по текущей цене. */
function markToMarket(pos, price) {
  const side = pos.side || "long";
  const delta = side === "long" ? price - pos.entry_price : pos.entry_price - price;
  const pricePct = pos.entry_price > 0 ? (delta / pos.entry_price) * 100 : 0;
  const pricePnl = (pos.size_usd * delta) / (pos.entry_price || 1);
  const fee = pos.size_usd * FEE_RATE * 2; // вход+выход taker (оценка)
  const lev = pos.leverage || 1;
  const margin = lev > 0 ? pos.size_usd / lev : pos.size_usd;
  return {
    price,
    pricePct,                         // движение цены, %
    roePct: pricePct * lev,           // ROE на маржу
    unrealized: pricePnl - fee,       // нетто с оценкой комиссии
    margin,
  };
}

/** GET /api/manual-paper — открытые позы (mark-to-market) + депо для слайдера. */
export async function handleList(_req, res) {
  try {
    const open = getActiveManualPaperPositions();
    const equity = await safeEquity();
    const positions = [];
    for (const pos of open) {
      const price = await resolvePrice(pos.coin);
      const mtm = price != null ? markToMarket(pos, price) : null;
      const stopPct =
        Number.isFinite(pos.sl_price) && pos.sl_price > 0 && pos.entry_price > 0
          ? Math.abs((pos.sl_price - pos.entry_price) / pos.entry_price) * 100
          : null;
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
        margin: mtm?.margin ?? null,
        // «Бумажный adopt»: бот ведёт выход. Стоп + текущий пик (MFE) для UI.
        managed: config.trading.manualPaperAdoptEnabled,
        stopPrice: Number.isFinite(pos.sl_price) ? pos.sl_price : null,
        stopPct,
        targetPrice: Number.isFinite(pos.tp_price) ? pos.tp_price : null,
        peakPct: getAdoptPeakPct(pos.id) || 0,
      });
    }
    const coins = await availableCoins();
    res.json({ positions, equity, coins, leverage: leverageByCoin(), slots: { used: open.length, max: MAX_SLOTS }, generatedAt: Date.now() });
  } catch (err) {
    logger.warn(`[manualPaper] list failed: ${err.message}`);
    res.status(500).json({ positions: [], equity: 0, error: true });
  }
}

/** POST /api/manual-paper/open {coin, side, leverage, sizeUsd, entryPrice?} */
export async function handleOpen(req, res) {
  try {
    const b = req.body || {};
    const coin = String(b.coin || "").toUpperCase().replace(/-PERP$/i, "").replace(/^@/, "");
    const side = b.side === "short" ? "short" : b.side === "long" ? "long" : null;
    const leverage = Math.min(MAX_LEVERAGE, Math.max(1, Number(b.leverage) || 1));
    const sizeUsd = Number(b.sizeUsd);

    if (!coin) return res.status(400).json({ error: "coin required" });
    if (!side) return res.status(400).json({ error: "side must be long|short" });
    if (!(sizeUsd > 0)) return res.status(400).json({ error: "sizeUsd must be > 0" });

    const open = getActiveManualPaperPositions();
    if (open.length >= MAX_SLOTS) {
      return res.status(409).json({ error: `slot limit reached (${MAX_SLOTS})` });
    }
    if (open.some((p) => p.coin === coin && (p.side || "long") === side)) {
      return res.status(409).json({ error: `already open ${side} ${coin}` });
    }

    // Один путь входа с автоматом по сигналам: стоп, цель и ступени считаются там.
    const r = await openPaperPosition({
      coin, side, sizeUsd, leverage,
      strategyId: STRATEGY_ID,
      entryPrice: Number(b.entryPrice) > 0 ? Number(b.entryPrice) : undefined,
      tag: "manualPaper",
    });
    if (!r.ok) return res.status(422).json({ error: r.error });
    res.json({ ok: true, id: r.id, coin, side, leverage, sizeUsd, entryPrice: r.entryPrice, slPrice: r.slPrice, tpPrice: r.tpPrice });
  } catch (err) {
    logger.warn(`[manualPaper] open failed: ${err.message}`);
    res.status(500).json({ error: true });
  }
}

/** POST /api/manual-paper/close {id, closePrice?} */
export async function handleClose(req, res) {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id required" });

    const pos = getActiveManualPaperPositions().find((p) => p.id === id);
    if (!pos) return res.status(404).json({ error: "no open manual_paper position with that id" });

    let price = await resolvePrice(pos.coin);
    if (price == null && Number(req.body?.closePrice) > 0) price = Number(req.body.closePrice);
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
    logger.info(`[manualPaper] CLOSE #${pos.coin} @ ${price} → ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(4)}`);
    res.json({ ok: true, id, coin: pos.coin, closePrice: price, realizedPnl, fee: totalFee });
  } catch (err) {
    logger.warn(`[manualPaper] close failed: ${err.message}`);
    res.status(500).json({ error: true });
  }
}
