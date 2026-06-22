// ─────────────────────────────────────────────────
//  Личный paper-журнал (manual_paper) — открыть/закрыть/список
// ─────────────────────────────────────────────────
// «Свой папер как в Rabbit, только на бумаге»: оператор видит движуху в Hot Movers,
// жмёт кнопку → модалка (монета/сторона/плечо/слайдер от реального депо) →
// открывается бумажная позиция strategy_id='manual_paper', mode='PAPER'.
//
// Бот её НЕ торгует и НЕ закрывает: своего тика у manual_paper нет. Цена остаётся
// свежей сама (scout пиннит все PAPER-коины через getActivePaperCoins) → live
// mark-to-market. Закрывает только оператор кнопкой. Архив закрытых сделок поднимается
// в таблицу Strategies через обычные getStrategyStats (history с тем же strategy_id).
//
// Multi-slot (как adopt): можно держать несколько бумажных входов разом.

import { logger } from "../../../core/logger.js";
import {
  savePosition,
  closePosition,
  getActiveManualPaperPositions,
} from "../../../core/database.js";
import { getLivePrice } from "../../../core/priceFeed.js";
import { getLivePriceMap } from "../../exchange.js";
import { getAccountEquity } from "../../wallet.js";
import { calcPnl, FEE_RATE } from "../../executor/math.js";

const STRATEGY_ID = "manual_paper";
const MAX_SLOTS = 8;          // потолок одновременных бумажных входов
const MAX_LEVERAGE = 50;

/** Свежая цена монеты: WS-фид → fallback на кэш price-map. null если нет. */
async function resolvePrice(coin) {
  const c = String(coin || "").toUpperCase();
  const live = getLivePrice(c);
  if (Number.isFinite(live) && live > 0) return live;
  try {
    const map = await getLivePriceMap();
    const p = map?.[c];
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* price-map недоступен — вернём null, вызывающий решит */
  }
  return null;
}

/** Доступное депо (equity) для слайдера. 0 при ошибке. */
async function safeEquity() {
  try {
    const eq = await getAccountEquity();
    return Number.isFinite(eq) && eq > 0 ? eq : 0;
  } catch {
    return 0;
  }
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
      });
    }
    res.json({ positions, equity, slots: { used: open.length, max: MAX_SLOTS }, generatedAt: Date.now() });
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

    let price = await resolvePrice(coin);
    if (price == null && Number(b.entryPrice) > 0) price = Number(b.entryPrice); // fallback на цену из карточки
    if (price == null) return res.status(422).json({ error: `no live price for ${coin}` });

    const equity = await safeEquity();
    const id = savePosition({
      coin,
      size_usd: sizeUsd,
      entry_price: price,
      entry_apy: 0,                  // нет funding-edge — чистый price-журнал
      entry_time: Date.now(),
      mode: "PAPER",
      strategy_id: STRATEGY_ID,
      side,
      leverage,
      entry_equity: equity || null,
    });
    logger.info(`[manualPaper] OPEN ${side} #${coin} ${leverage}x $${sizeUsd.toFixed(2)} @ ${price}`);
    res.json({ ok: true, id, coin, side, leverage, sizeUsd, entryPrice: price });
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
