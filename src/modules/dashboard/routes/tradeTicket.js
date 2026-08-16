// ─────────────────────────────────────────────────
//  Trade Ticket — ручное открытие/закрытие позиции с дашборда
// ─────────────────────────────────────────────────
// Повод (11.08.2026, tools/feeAudit.mjs): сторонний фронтенд вшивает в ордер
// builder-fee 2 бп — это +46% к тейкерской ставке. За два месяца $9.29 при
// депо $10.16. Ордера, отправленные ботом через SDK, надбавки не несут:
// 374 филла прошли по 4.32 бп при builderFee $0.00. Сайт биржи её тоже не
// берёт, но пользоваться им неудобно, а Rabby всплывает на каждый клик.
// Эти три ручки закрывают ровно этот разрыв: тариф биржи, интерфейс — свой.
//
// 🔒 ГРАНИЦА ОТВЕТСТВЕННОСТИ (решено 16.08.2026, не размывать):
// Эти ручки ТОЛЬКО кладут ордер на биржу. Они НЕ пишут в `positions`, НЕ ставят
// стопы и НЕ ведут позицию. Дальше всё как при входе с сайта биржи: orphanCheck
// увидит новую ручную позу, adopt усыновит её и повесит свой ATR-стоп (~15 сек).
// Если бы мы писали строку в БД сами, получился бы второй владелец позиции —
// ровно тот класс рассинхрона «зеркало ≠ биржа», где уже собрано 8 фиксов.
//
// Почему серверные проверки дублируют клиентские: клиенту доверять нельзя, это
// живые деньги. Всё, что гейтит форму в браузере, продублировано здесь.

import { config } from "../../../core/config.js";
import { logger } from "../../../core/logger.js";
import { retryWithBackoff } from "../../../core/retry.js";
import {
  openMarket,
  closeMarket,
  placeLimit,
  getAccountSummary,
  getBalance,
  setLeverage,
  getPositions,
} from "../../exchange.js";
import { getLivePrice } from "../../../core/priceFeed.js";
import { getLivePriceMap } from "../../exchange.js";
import { fetchExchangePositions } from "../../sync.js";
import { getFrontendOpenOrders } from "../../exchange.js";
import { resolveAsset, parseFillResponse } from "../../executor/fill-parser.js";
import { formatHlPrice, MARKET_SLIPPAGE } from "../../executor/math.js";
import { computeStopDistPct } from "../../../app/adoptReconcile.js";
import { getLastDailyRiskStatus } from "../../dailyRisk.js";
import { getUniverse } from "../../../core/universe.js";

// Биржевой минимум ордера на HL. Меньше — гарантированный отказ.
const MIN_ORDER_USD = 10;

// Потолок плеча. Депо ~$10-15: выше 10x ликвидация приходит раньше, чем стоп
// няньки (−7% ATR), то есть стоп перестаёт быть стопом.
const MAX_LEVERAGE = 10;

// Потолок нотионала на одну ручную сделку. Защита от опечатки и от того, что
// одна сделка съест весь депозит. Не риск-менеджмент — грубый предохранитель.
const MAX_NOTIONAL_USD = 60;

/** Свежая цена: WS-фид → fallback на кэш price-map. null если нет. */
async function resolvePrice(coin) {
  const c = String(coin || "").toUpperCase();
  if (!c) return null;
  const live = getLivePrice(c);
  if (live && Number.isFinite(live.price) && live.price > 0) return live.price;
  try {
    const map = await getLivePriceMap();
    const p = map?.get?.(c);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* price-map недоступен */
  }
  return null;
}

/** Свободная маржа. 0 при ошибке — форма тогда просто не даст открыть. */
async function safeAvailable() {
  try {
    const bal = await getBalance();
    return Number.isFinite(bal) && bal > 0 ? bal : 0;
  } catch {
    return 0;
  }
}

/** Нормализация тела запроса — на входе всегда недоверенные данные. */
function readOpenBody(b) {
  return {
    coin: String(b?.coin || "").toUpperCase().replace(/-PERP$/i, "").replace(/^@/, ""),
    side: b?.side === "long" ? "long" : b?.side === "short" ? "short" : null,
    marginUsd: Number(b?.marginUsd),
    leverage: Math.round(Number(b?.leverage)),
    orderType: b?.orderType === "limit" ? "limit" : "market",
    limitPx: Number(b?.limitPx),
  };
}

/**
 * GET /api/ticket/context?coin=CHIP
 * Всё, что нужно модалке: цена, свободная маржа, потолок плеча, ATR-стоп
 * няньки, дневной риск и открытые позиции с их стопами.
 */
export async function handleContext(req, res) {
  const coin = String(req.query.coin || "").toUpperCase().replace(/-PERP$/i, "");
  try {
    const [price, available, positions] = await Promise.all([
      coin ? resolvePrice(coin) : Promise.resolve(null),
      safeAvailable(),
      buildPositions(),
    ]);

    // ATR-стоп няньки: показываем ТО ЖЕ число, что она реально применит.
    let stopDistPct = null;
    let stopBasis = null;
    if (coin && config.trading.adoptEnabled) {
      try {
        ({ distPct: stopDistPct, basis: stopBasis } = await computeStopDistPct(coin));
      } catch {
        /* нет ATR — модалка честно скажет «по ATR после входа» */
      }
    }

    // Потолок плеча по монете из universe HL (у большинства 3–10x).
    // resolveAsset отдаёт только szDecimals, поэтому maxLeverage берём из
    // universe напрямую — как это делает routes/manualPaper.js.
    let maxLeverage = MAX_LEVERAGE;
    let coinKnown = null;
    if (coin) {
      const asset = getUniverse().find((a) => String(a?.name).toUpperCase() === coin);
      coinKnown = !!asset;
      const lev = Number(asset?.maxLeverage);
      if (Number.isFinite(lev) && lev > 0) maxLeverage = Math.min(MAX_LEVERAGE, lev);
    }

    const day = getLastDailyRiskStatus();
    res.json({
      coin,
      coinKnown,
      price,
      available,
      maxLeverage,
      maxNotionalUsd: MAX_NOTIONAL_USD,
      minOrderUsd: MIN_ORDER_USD,
      stopDistPct,
      stopBasis,
      adoptEnabled: config.trading.adoptEnabled,
      hasPosition: positions.some((p) => p.coin === coin),
      positions,
      day: {
        netUsd: day?.netUsd ?? null,
        limitUsd: day?.limitUsd ?? config.trading.dailyLossLimitUsd,
        halted: !!day?.halted,
      },
      generatedAt: Date.now(),
    });
  } catch (err) {
    logger.warn(`[TradeTicket] context failed: ${err.message}`);
    res.status(500).json({ error: true });
  }
}

/**
 * Открытые позы + их стопы. Стоп берём из живых trigger-ордеров на бирже, а НЕ
 * из нашей БД: истина о том, защищена ли поза, живёт на бирже (инцидент
 * «API-кошелёк мёртв 4 дня» — в БД стопы были, на бирже нет).
 */
async function buildPositions() {
  let raw = [];
  try {
    raw = await fetchExchangePositions();
  } catch {
    return [];
  }
  let triggers = [];
  try {
    triggers = await getFrontendOpenOrders();
  } catch {
    /* без стопов — покажем «никто не ведёт», это честнее чем промолчать */
  }
  return raw.map((p) => {
    const side = p.szi < 0 ? "short" : "long";
    const stop = triggers.find(
      (o) =>
        String(o.coin).toUpperCase() === String(p.coin).toUpperCase() &&
        o.reduceOnly &&
        /stop/i.test(o.orderType || ""),
    );
    return {
      coin: p.coin,
      side,
      sz: Math.abs(p.szi),
      sizeUsd: Math.abs(p.positionValue),
      entryPrice: p.entryPx,
      markPrice: Math.abs(p.szi) > 0 ? Math.abs(p.positionValue) / Math.abs(p.szi) : p.entryPx,
      unrealized: p.unrealizedPnl,
      liquidationPx: p.liquidationPx,
      stopPrice: stop ? Number(stop.triggerPx) : null,
    };
  });
}

/** POST /api/ticket/open */
export async function handleOpen(req, res) {
  if (!config.isProduction) {
    return res.status(409).json({ error: "бот в PAPER-режиме — реальные ордера отключены" });
  }
  const b = readOpenBody(req.body);

  // ── Проверки. Дублируют клиентские намеренно: это живые деньги. ──
  if (!b.coin) return res.status(400).json({ error: "coin required" });
  if (!b.side) return res.status(400).json({ error: "side must be long|short" });
  if (!(b.marginUsd > 0)) return res.status(400).json({ error: "marginUsd must be > 0" });
  if (!Number.isInteger(b.leverage) || b.leverage < 1 || b.leverage > MAX_LEVERAGE) {
    return res.status(400).json({ error: `leverage must be 1..${MAX_LEVERAGE}` });
  }

  const notional = b.marginUsd * b.leverage;
  if (notional < MIN_ORDER_USD) {
    return res.status(422).json({ error: `минимальный ордер на бирже — $${MIN_ORDER_USD}` });
  }
  if (notional > MAX_NOTIONAL_USD) {
    return res.status(422).json({ error: `нотионал $${notional.toFixed(2)} > потолка $${MAX_NOTIONAL_USD}` });
  }

  // Дневной стоп запирает ВХОД. Выход не запирает никогда (см. handleClose).
  const day = getLastDailyRiskStatus();
  if (day?.halted) {
    return res.status(423).json({ error: "дневной стоп сработал — вход закрыт до полуночи" });
  }

  const available = await safeAvailable();
  if (b.marginUsd > available + 1e-9) {
    return res.status(422).json({ error: `маржа $${b.marginUsd.toFixed(2)} > свободной $${available.toFixed(2)}` });
  }

  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(b.coin));
  } catch (err) {
    return res.status(422).json({ error: `биржа не знает тикер ${b.coin}` });
  }

  const price = await resolvePrice(b.coin);
  if (price == null) return res.status(422).json({ error: `нет живой цены для ${b.coin}` });

  const entryPx = b.orderType === "limit" ? b.limitPx : price;
  if (b.orderType === "limit") {
    if (!(b.limitPx > 0)) return res.status(400).json({ error: "limitPx required for limit order" });
    // Post-only, пересекающая рынок, будет отклонена биржей — ловим раньше,
    // чтобы оператор не решил, что ордер поставился.
    const wouldCross = b.side === "short" ? b.limitPx < price : b.limitPx > price;
    if (wouldCross) {
      return res.status(422).json({ error: "post-only пересекает рынок — сдвинь цену или возьми Market" });
    }
  }

  // Размер в монетах — округляем вниз до szDecimals, иначе биржа отклонит.
  const step = Math.pow(10, szDecimals);
  const sz = Math.floor((notional / entryPx) * step) / step;
  if (!(sz > 0)) {
    return res.status(422).json({ error: `размер округлился в ноль (szDecimals=${szDecimals})` });
  }

  try {
    await setLeverage(b.coin, b.leverage);
  } catch (err) {
    logger.warn(`[TradeTicket] setLeverage(${b.coin}, ${b.leverage}) failed: ${err.message}`);
    return res.status(502).json({ error: `не смог выставить плечо: ${err.message}` });
  }

  const isBuy = b.side === "long";
  try {
    if (b.orderType === "limit") {
      const px = formatHlPrice(b.limitPx, szDecimals);
      const result = await retryWithBackoff(
        () => placeLimit({ coin: b.coin, isBuy, sz, px, tif: "Alo", reduceOnly: false }),
        { label: `ticket-open-limit-${b.coin}`, maxRetries: 2, baseDelayMs: 1000 },
      );
      const status = result?.response?.data?.statuses?.[0];
      if (typeof status === "string") throw new Error(status);
      if (status?.error) throw new Error(status.error);
      const oid = status?.resting?.oid ?? status?.filled?.oid ?? null;
      logger.info(
        `[TradeTicket] 📝 LIMIT ${b.side.toUpperCase()} #${b.coin} sz=${sz} @ ${px} ` +
          `($${notional.toFixed(2)} = ${b.marginUsd.toFixed(2)}×${b.leverage}) oid=${oid}`,
      );
      return res.json({
        ok: true,
        kind: "limit",
        oid,
        message: `${b.side === "short" ? "Short" : "Long"} ${b.coin} · limit ${px} resting · $${notional.toFixed(2)} (${b.marginUsd.toFixed(2)}×${b.leverage}) · bot will attach the stop once it fills`,
      });
    }

    const result = await retryWithBackoff(
      () => openMarket(b.coin, isBuy, sz, MARKET_SLIPPAGE),
      { label: `ticket-open-market-${b.coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
    const fill = parseFillResponse(result, "OPEN");
    if (!fill.ok) throw new Error(fill.error || "exchange rejected");
    logger.info(
      `[TradeTicket] ✅ MARKET ${b.side.toUpperCase()} #${b.coin} filled ${fill.totalSz} @ $${fill.avgPx} ` +
        `($${(fill.totalSz * fill.avgPx).toFixed(2)}) oid=${fill.oid}`,
    );
    return res.json({
      ok: true,
      kind: "market",
      oid: fill.oid,
      fillPx: fill.avgPx,
      sz: fill.totalSz,
      message: `${b.side === "short" ? "Short" : "Long"} ${b.coin} filled ${fill.totalSz} @ ${fill.avgPx} · $${(fill.totalSz * fill.avgPx).toFixed(2)} · bot attaches the stop in ~15s`,
    });
  } catch (err) {
    logger.error(`[TradeTicket] open #${b.coin} failed: ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
}

/**
 * POST /api/ticket/close
 * Намеренно почти не гейтится: дневной стоп на выход НЕ распространяется и
 * PAPER-проверка тут тоже уместна только как «нет реальных поз».
 */
export async function handleClose(req, res) {
  if (!config.isProduction) {
    return res.status(409).json({ error: "бот в PAPER-режиме — реальных позиций нет" });
  }
  const coin = String(req.body?.coin || "").toUpperCase().replace(/-PERP$/i, "");
  const pct = Number(req.body?.pct);
  const orderType = req.body?.orderType === "limit" ? "limit" : "market";
  const limitPx = Number(req.body?.limitPx);

  if (!coin) return res.status(400).json({ error: "coin required" });
  if (!(pct > 0) || pct > 100) return res.status(400).json({ error: "pct must be 1..100" });

  // Истина о позиции — с биржи, не из БД.
  let positions;
  try {
    positions = await getPositions();
  } catch (err) {
    return res.status(502).json({ error: `не смог прочитать позиции: ${err.message}` });
  }
  const ap = (positions || []).find(
    (x) => String(x?.position?.coin || "").toUpperCase() === coin,
  );
  const szi = parseFloat(ap?.position?.szi ?? "0");
  if (!szi) return res.status(404).json({ error: `нет открытой позиции по ${coin}` });

  const side = szi < 0 ? "short" : "long";
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    return res.status(422).json({ error: `биржа не знает тикер ${coin}` });
  }

  const step = Math.pow(10, szDecimals);
  let sz = Math.floor((Math.abs(szi) * pct) / 100 * step) / step;
  // Просят 100% — закрываем ровно то, что есть, без потерь на округлении вниз.
  if (pct === 100) sz = Math.abs(szi);
  if (!(sz > 0)) return res.status(422).json({ error: "размер закрытия округлился в ноль" });

  try {
    if (orderType === "limit") {
      if (!(limitPx > 0)) return res.status(400).json({ error: "limitPx required for limit order" });
      const price = await resolvePrice(coin);
      const isBuy = side === "short"; // закрытие шорта = BUY
      if (price != null) {
        const wouldCross = isBuy ? limitPx > price : limitPx < price;
        if (wouldCross) {
          return res.status(422).json({ error: "post-only пересекает рынок — сдвинь цену или возьми Market" });
        }
      }
      const px = formatHlPrice(limitPx, szDecimals);
      const result = await retryWithBackoff(
        () => placeLimit({ coin, isBuy, sz, px, tif: "Alo", reduceOnly: true }),
        { label: `ticket-close-limit-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
      );
      const status = result?.response?.data?.statuses?.[0];
      if (typeof status === "string") throw new Error(status);
      if (status?.error) throw new Error(status.error);
      const oid = status?.resting?.oid ?? status?.filled?.oid ?? null;
      logger.info(`[TradeTicket] 📝 CLOSE-LIMIT #${coin} ${pct}% sz=${sz} @ ${px} oid=${oid}`);
      return res.json({
        ok: true,
        kind: "limit",
        oid,
        message: `${coin}: reduce-only limit for ${pct}% resting @ ${px}`,
      });
    }

    const result = await retryWithBackoff(
      () => closeMarket(coin, sz, MARKET_SLIPPAGE),
      { label: `ticket-close-market-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
    const fill = parseFillResponse(result, "CLOSE");
    if (!fill.ok) throw new Error(fill.error || "exchange rejected");
    logger.info(`[TradeTicket] ✅ CLOSE #${coin} ${pct}% filled ${fill.totalSz} @ $${fill.avgPx}`);
    return res.json({
      ok: true,
      kind: "market",
      fillPx: fill.avgPx,
      sz: fill.totalSz,
      message: `${coin}: closed ${pct}% — ${fill.totalSz} @ ${fill.avgPx}`,
    });
  } catch (err) {
    logger.error(`[TradeTicket] close #${coin} failed: ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
}
