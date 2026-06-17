// ─────────────────────────────────────────────────
//  Production Mode — реальные позиции на Hyperliquid
// ─────────────────────────────────────────────────

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { retryWithBackoff } from '../../core/retry.js';
import {
  savePosition,
  closePosition as dbClosePosition,
  updateHunterTriggerOids,
  recordBotOid,
} from '../../core/database.js';
import {
  openMarket,
  closeMarket,
  placeTrigger,
  cancelOrderFor,
  getBalance,
  getAccountSummary,
  getPositions,
  setLeverage,
} from '../exchange.js';
import { resolveAsset, parseFillResponse } from './fill-parser.js';
import { resolveEntrySize, sizeBudgetFromEquity } from './sizing.js';
import { fetchUserFills, classifyClose } from '../userFills.js';
import {
  calcSize, calcPnl, checkSlippage, formatHlPrice, calcVolSizeMultiplier,
  MARKET_SLIPPAGE, MIN_ORDER_USD, FEE_RATE, ONE_LEG,
} from './math.js';
import {
  banRuntime, banSlippage, setCooldown,
  getLastRejectedAlert, setRejectedAlert,
  recordLoss, getCircuitBreakerStatus,
  banOiCap,
  RUNTIME_BAN_TTL_MS, SLIPPAGE_BAN_TTL_MS,
  REENTRY_COOLDOWN_MS, REJECTED_ALERT_TTL_MS,
  CB_PAUSE_MS,
} from './state.js';
import { reconcile } from './reconciler.js';
import { sleep } from './reconciler.js';
import { gate, notify } from './hooks.js';
import { consumeHunterMfeMae, clearHunterTrailState, getHunterPeakPct, recordHunterSlExternal } from '../strategistSniper.js';
import {
  consumeHunterLongMfeMae, clearHunterLongTrailState, getHunterLongPeakPct,
} from '../strategistHunterLong.js';
import { setHunterCrossCooldown } from '../hunterCrossCooldown.js';
import { clearAdoptState, getAdoptPeakPct } from '../strategistAdopt.js';
import { recordHunterLongLossEvent } from '../strategistHunterLong.js';
import {
  notifyProductionOpen, notifyOpenFailed, notifyOpenRejected,
  notifyOpenSkipped, notifySlippageBan,
  notifyProductionClose, notifyCloseRejected, notifyCloseFailed,
  notifyExternalClose,
  notifyRotate, notifyRotateFailed,
  notifyCircuitBreaker,
  notifyOiCapBan, notifyOiCapAfterRotate,
  notifyHunterOpenProd, notifyHunterOpenFailed,
  notifyHunterTrailTp,
  notifyHunterLongOpenProd, notifyHunterLongOpenFailed, notifyHunterLongTrailTp,
  notifyTrendFollowOpenProd, notifyTrendFollowOpenFailed,
} from './notifications.js';

// Регэксп для детекции "open interest at cap" в ответе биржи.
// Покрывает варианты: "open interest at cap", "exceeds max open interest",
// "OI cap reached", "open interest cap" и т.п.
const OI_CAP_REGEX = /open\s*interest|oi\s*cap/i;

// ─────────────────────────────────────────────────
//  OPEN
// ─────────────────────────────────────────────────


// ─────────────────────────────────────────────────
//  HUNTER OPEN (Iter C — реальные trigger-ордера на HL)
// ─────────────────────────────────────────────────

/**
 * Размещает trigger-ордер (SL или TP) для закрытия Hunter SHORT-позиции.
 * Возвращает orderId или throw'ает.
 *
 * @param {string} coin
 * @param {number} sz — размер позиции (фактический fill)
 * @param {number} triggerPx — цена срабатывания
 * @param {'sl'|'tp'} tpsl
 */
export async function placeHunterTrigger(coin, sz, triggerPx, tpsl, szDecimals) {
  // HL отклоняет цены с >5 значащих цифр / >(6−szDecimals) десятичных.
  // Сырая `entry × 1.02` для низкопрайсовых монет (REZ ~$0.05) даёт 7 sig figs
  // → "Order has invalid price". Округляем здесь явно.
  const px = formatHlPrice(triggerPx, szDecimals);
  const result = await retryWithBackoff(
    () =>
      placeTrigger({ coin, isBuy: true, sz, px, tpsl }), // закрытие SHORT → BUY reduce_only
    { label: `hunter-${tpsl}-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
  );

  const status = result?.response?.data?.statuses?.[0];
  if (!status) {
    throw new Error(`empty statuses: ${JSON.stringify(result).slice(0, 200)}`);
  }
  if (typeof status === 'string') {
    throw new Error(status);
  }
  if (status.error) {
    throw new Error(status.error);
  }
  // Trigger-ордер не должен сразу исполниться — HL вернёт resting.
  if (status.resting?.oid) {
    return status.resting.oid;
  }
  throw new Error(`unexpected status: ${JSON.stringify(status).slice(0, 200)}`);
}

/**
 * Открывает реальную Hunter SHORT с триггерами SL/TP на бирже.
 *
 * Поток: setLeverage(1) → market SELL → save position → placeOrder SL trigger →
 * placeOrder TP trigger → updateHunterTriggerOids. Любой fail после market open →
 * cancel уже размещённых триггеров + market close (rollback).
 *
 * @param {string} coin
 * @param {number} markPrice — цена в момент сигнала (для лога/slippage)
 * @param {number} spikePct  — величина пампа (для уведомления)
 * @param {number} sl        — SL price (выше entry для SHORT)
 * @param {number} tp        — TP price (ниже entry для SHORT)
 * @param {boolean} [silent=false]
 */
export async function productionHunterOpen(coin, markPrice, spikePct, sl, tp, silent = false, entryFeatures = null) {

  // ── 1. Баланс ──
  let balance;
  try {
    balance = await getBalance();
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — getBalance failed: ${err.message}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'balance', reason: err.message, rolledBack: false });
    return { ok: false };
  }
  if (balance <= 0) {
    logger.warn(`[Executor] PROD HUNTER OPEN #${coin} — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  // ── 2. szDecimals + размер (50% utilization) ──
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — resolveAsset failed: ${err.message}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'resolveAsset', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  // Leverage расширяет нотиональный размер позиции. Два режима сайзинга:
  //  · fromEquity=false (старый): база = свободный баланс × leverage, util от него.
  //  · fromEquity=true: целим util от ВСЕГО депо (equity), потолок — свободная
  //    маржа. Стабильный размер «половина депо», не ужимается при открытой ручной
  //    позе, но за свободную маржу не выходит. См. equityCappedNotional.
  const leverage = config.trading.hunterLeverage;
  const util = config.trading.hunterBalanceUtil;
  let capBase, capUtil, riskEquity;
  if (config.trading.hunterSizeFromEquity) {
    let equity = balance;
    try { ({ equity } = await getAccountSummary()); } catch { /* fallback на free */ }
    if (!(equity > 0)) equity = balance;
    const budget = sizeBudgetFromEquity(
      balance, equity, util, leverage, config.trading.hunterMinSizeFraction,
    );
    // Свободной маржи мало → доступный размер < доли от нормального → не лезем пылью.
    if (!budget.ok) {
      logger.info(
        `[Executor] [HUNTER SKIP] #${coin} — мало свободной маржи: доступно $${budget.available.toFixed(2)} ` +
          `< ${(config.trading.hunterMinSizeFraction * 100).toFixed(0)}% от нормы $${budget.intended.toFixed(2)} ` +
          `(free $${balance.toFixed(2)}). Жду освобождения маржи.`,
      );
      return { ok: false };
    }
    capBase = budget.available; // уже нотионал
    capUtil = 1;
    riskEquity = equity;
  } else {
    capBase = balance * leverage;
    capUtil = util;
    riskEquity = balance;
  }
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'Hunter', equity: riskEquity, capBase,
    capUtil, price: markPrice, sl, szDecimals,
  });
  if (tooSmall) {
    logger.warn(
      `[Executor] [HUNTER SKIP] #${coin} — size $${sizeUsd.toFixed(2)} / sz=${sz} ` +
        `(free $${balance.toFixed(2)}, ${leverage}x, fromEquity=${config.trading.hunterSizeFromEquity})`,
    );
    return { ok: false };
  }

  // ── 3. Leverage ──
  try {
    await setLeverage(coin, leverage);
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — setLeverage(${leverage}) failed: ${err.message}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'setLeverage', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  // ── 4. Market SELL (taker) ──
  logger.info(
    `[Executor] PROD HUNTER OPEN SHORT #${coin} — placing market SELL | sz=${sz} (~$${(sz * markPrice).toFixed(2)}) | mark=$${markPrice}`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () => openMarket(coin, false, sz, MARKET_SLIPPAGE),
      { label: `hunter-open-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    // OI cap detection — симметрично с funding-веткой выше
    if (OI_CAP_REGEX.test(err.message ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 HUNTER OI CAP BAN #${coin} — exchange rejected (${err.message}). ` +
          `Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — marketOpen failed: ${err.message}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'marketOpen', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  const fill = parseFillResponse(result, 'OPEN');
  if (!fill.ok) {
    // OI cap detection — биржа могла "отклонить" вместо throw
    if (OI_CAP_REGEX.test(fill.error ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 HUNTER OI CAP BAN #${coin} — exchange rejected (${fill.error}). ` +
          `Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — exchange rejected: ${fill.error}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'fill', reason: fill.error, rolledBack: false });
    return { ok: false };
  }

  const fillPx  = fill.avgPx;
  const fillSz  = fill.totalSz;
  const fillUsd = fillSz * fillPx;
  const slip    = checkSlippage(markPrice, fillPx, 'SELL');
  const fee     = fillUsd * ONE_LEG;

  // SL/TP стратег задал от сигнальной цены; пересчитываем от реального филла —
  // иначе при проскальзывании стоп встаёт вплотную к entry (инцидент TST 2026-05-19).
  sl = fillPx * (sl / markPrice);
  tp = fillPx * (tp / markPrice);

  // ── 5. Save position (без oids — обновим после триггеров) ──
  let entryEquity = null;
  try {
    const summary = await getAccountSummary();
    entryEquity = summary.equity;
  } catch (err) {
    logger.warn(`[Executor] PROD HUNTER OPEN #${coin} — entry equity capture failed: ${err.message}`);
  }

  const id = savePosition({
    coin,
    size_usd:     fillUsd,
    entry_price:  fillPx,
    entry_apy:    0, // Hunter не funding-based
    entry_time:   Date.now(),
    mode:         'PRODUCTION',
    strategy_id:  'hunter',
    sl_price:     sl,
    tp_price:     tp,
    entry_equity: entryEquity,
    side:         'short',
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] ✅ PROD HUNTER OPEN SHORT #${coin} | oid: ${fill.oid} | filled: ${fillSz} @ $${fillPx} ($${fillUsd.toFixed(2)}) | slip: ${slip.label} | id: ${id}`,
  );
  recordBotOid(fill.oid, coin, 'open', id);

  const fillInfo = { sizeUsd: fillUsd, fillPx, sz: fillSz };

  // ── 6. Поставить SL trigger ──
  let slOid;
  try {
    slOid = await placeHunterTrigger(coin, fillSz, sl, 'sl', szDecimals);
    logger.info(`[Executor] PROD HUNTER #${coin} SL trigger armed @ $${sl} | oid=${slOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER #${coin} SL placeOrder failed: ${err.message} — ROLLBACK market close`);
    const rb = await rollbackHunterOpen(coin, fillSz, id, fillPx, /* triggerOids */ []);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'placeSL', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  // ── 7. Поставить TP trigger ──
  let tpOid;
  try {
    tpOid = await placeHunterTrigger(coin, fillSz, tp, 'tp', szDecimals);
    logger.info(`[Executor] PROD HUNTER #${coin} TP trigger armed @ $${tp} | oid=${tpOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER #${coin} TP placeOrder failed: ${err.message} — ROLLBACK (cancel SL + market close)`);
    const rb = await rollbackHunterOpen(coin, fillSz, id, fillPx, [slOid]);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'placeTP', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  // ── 8. Сохранить oids ──
  updateHunterTriggerOids(id, { hunter_sl_oid: slOid, hunter_tp_oid: tpOid });
  recordBotOid(slOid, coin, 'sl_trigger', id);
  recordBotOid(tpOid, coin, 'tp_trigger', id);

  // ── 9. Notify ──
  if (!silent) {
    await notifyHunterOpenProd({
      coin, sizeUsd: fillUsd, balance, leverage,
      fillPx, markPrice, spikePct, sl, tp,
      slOid, tpOid, slipLabel: slip.label, fee,
    });
  }

  notify('afterOpen', {
    coin, price: fillPx, sizeUsd: fillUsd, positionId: Number(id),
    mode: 'PRODUCTION', strategy: 'hunter',
  });

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
}

/**
 * Откат при сбое размещения триггеров: cancel поставленных триггеров +
 * market close открытой позиции + закрытие записи в БД.
 *
 * Best-effort: каждый шаг логируется отдельно, любой fail внутри не
 * прерывает остальные. Главная цель — не оставить позицию без SL.
 */
async function rollbackHunterOpen(coin, sz, dbId, fillPx, triggerOids) {

  // Cancel уже поставленных триггеров (если есть)
  for (const oid of triggerOids) {
    try {
      await cancelOrderFor(coin, oid);
      logger.info(`[Executor] HUNTER ROLLBACK #${coin} — cancelled trigger oid=${oid}`);
    } catch (err) {
      logger.error(`[Executor] HUNTER ROLLBACK #${coin} — cancel oid=${oid} failed: ${err.message}`);
    }
  }

  // Market close
  let closeResult;
  try {
    closeResult = await retryWithBackoff(
      () => closeMarket(coin, sz, MARKET_SLIPPAGE),
      { label: `hunter-rollback-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    logger.error(`[Executor] HUNTER ROLLBACK #${coin} — marketClose THREW: ${err.message}. РУЧНОЕ ВМЕШАТЕЛЬСТВО!`);
    return null;
  }

  const closeFill = parseFillResponse(closeResult, 'CLOSE');
  const closePx = closeFill.ok ? closeFill.avgPx : fillPx;
  const closeNotional = (closeFill.ok ? closeFill.totalSz : sz) * closePx;
  const totalFee = closeNotional * ONE_LEG + (sz * fillPx) * ONE_LEG;
  // pricePnl на short: (entry − close) × sz
  const pricePnl = sz * (fillPx - closePx);
  const realized = pricePnl - totalFee;

  try {
    dbClosePosition(dbId, {
      close_price:  closePx,
      realized_pnl: realized,
      fee_paid:     totalFee,
      reason:       'hunter_rollback',
    });
    logger.info(
      `[Executor] HUNTER ROLLBACK #${coin} closed: entry $${fillPx} → close $${closePx} | pnl $${realized.toFixed(4)}`,
    );
  } catch (err) {
    logger.error(`[Executor] HUNTER ROLLBACK #${coin} — dbClosePosition failed: ${err.message}`);
  }

  setCooldown(coin);
  return { closePx, pnl: realized, fee: totalFee };
}

// ─────────────────────────────────────────────────
//  HUNTER LONG OPEN (Iter E.3 — реальные trigger-ордера, зеркало Hunter SHORT)
// ─────────────────────────────────────────────────

/**
 * Trigger-ордер для закрытия Hunter LONG-позиции (reduce_only SELL).
 * Отличие от placeHunterTrigger: is_buy=false (закрытие LONG → SELL).
 */
export async function placeHunterLongTrigger(coin, sz, triggerPx, tpsl, szDecimals) {
  const px = formatHlPrice(triggerPx, szDecimals);
  const result = await retryWithBackoff(
    () =>
      placeTrigger({ coin, isBuy: false, sz, px, tpsl }), // закрытие LONG → SELL reduce_only
    { label: `hunter-long-${tpsl}-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
  );

  const status = result?.response?.data?.statuses?.[0];
  if (!status) {
    throw new Error(`empty statuses: ${JSON.stringify(result).slice(0, 200)}`);
  }
  if (typeof status === 'string') {
    throw new Error(status);
  }
  if (status.error) {
    throw new Error(status.error);
  }
  if (status.resting?.oid) {
    return status.resting.oid;
  }
  throw new Error(`unexpected status: ${JSON.stringify(status).slice(0, 200)}`);
}

/**
 * Открывает Hunter LONG в проде: market BUY → place SL (ниже) + TP (выше) triggers.
 * При сбое триггеров — rollback (cancel + market SELL).
 */
export async function productionHunterLongOpen(coin, markPrice, dumpPct, sl, tp, silent = false, entryFeatures = null) {

  let balance;
  try {
    balance = await getBalance();
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER_LONG OPEN #${coin} — getBalance failed: ${err.message}`);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'balance', reason: err.message, rolledBack: false });
    return { ok: false };
  }
  if (balance <= 0) {
    logger.warn(`[Executor] PROD HUNTER_LONG OPEN #${coin} — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER_LONG OPEN #${coin} — resolveAsset failed: ${err.message}`);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'resolveAsset', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  // Сайзинг как у Hunter SHORT: fromEquity → util от всего депо с потолком по
  // свободной марже; иначе старый free-based. См. equityCappedNotional.
  const leverage = config.trading.hunterLeverage; // тот же leverage что у Hunter SHORT
  const util = config.trading.hunterLongBalanceUtil;
  let capBase, capUtil, riskEquity;
  if (config.trading.hunterSizeFromEquity) {
    let equity = balance;
    try { ({ equity } = await getAccountSummary()); } catch { /* fallback на free */ }
    if (!(equity > 0)) equity = balance;
    const budget = sizeBudgetFromEquity(
      balance, equity, util, leverage, config.trading.hunterMinSizeFraction,
    );
    if (!budget.ok) {
      logger.info(
        `[Executor] [HUNTER_LONG SKIP] #${coin} — мало свободной маржи: доступно $${budget.available.toFixed(2)} ` +
          `< ${(config.trading.hunterMinSizeFraction * 100).toFixed(0)}% от нормы $${budget.intended.toFixed(2)} ` +
          `(free $${balance.toFixed(2)}). Жду освобождения маржи.`,
      );
      return { ok: false };
    }
    capBase = budget.available;
    capUtil = 1;
    riskEquity = equity;
  } else {
    capBase = balance * leverage;
    capUtil = util;
    riskEquity = balance;
  }
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'HunterLong', equity: riskEquity, capBase,
    capUtil, price: markPrice, sl, szDecimals,
  });
  if (tooSmall) {
    logger.warn(
      `[Executor] [HUNTER_LONG SKIP] #${coin} — size $${sizeUsd.toFixed(2)} / sz=${sz} ` +
        `(free $${balance.toFixed(2)}, ${leverage}x, fromEquity=${config.trading.hunterSizeFromEquity})`,
    );
    return { ok: false };
  }

  try {
    await setLeverage(coin, leverage);
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER_LONG OPEN #${coin} — setLeverage(${leverage}) failed: ${err.message}`);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'setLeverage', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  logger.info(
    `[Executor] PROD HUNTER_LONG OPEN LONG #${coin} — placing market BUY | sz=${sz} (~$${(sz * markPrice).toFixed(2)}) | mark=$${markPrice}`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () => openMarket(coin, true, sz, MARKET_SLIPPAGE),
      { label: `hunter-long-open-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    if (OI_CAP_REGEX.test(err.message ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 HUNTER_LONG OI CAP BAN #${coin} — ${err.message}. Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD HUNTER_LONG OPEN #${coin} — marketOpen failed: ${err.message}`);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'marketOpen', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  const fill = parseFillResponse(result, 'OPEN');
  if (!fill.ok) {
    if (OI_CAP_REGEX.test(fill.error ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 HUNTER_LONG OI CAP BAN #${coin} — ${fill.error}. Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD HUNTER_LONG OPEN #${coin} — exchange rejected: ${fill.error}`);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'fill', reason: fill.error, rolledBack: false });
    return { ok: false };
  }

  const fillPx  = fill.avgPx;
  const fillSz  = fill.totalSz;
  const fillUsd = fillSz * fillPx;
  const slip    = checkSlippage(markPrice, fillPx, 'BUY');
  const fee     = fillUsd * ONE_LEG;

  // SL/TP стратег задал от сигнальной цены; пересчитываем от реального филла —
  // иначе при проскальзывании стоп встаёт вплотную к entry (инцидент TST 2026-05-19).
  sl = fillPx * (sl / markPrice);
  tp = fillPx * (tp / markPrice);

  let entryEquity = null;
  try {
    const summary = await getAccountSummary();
    entryEquity = summary.equity;
  } catch (err) {
    logger.warn(`[Executor] PROD HUNTER_LONG OPEN #${coin} — entry equity capture failed: ${err.message}`);
  }

  const id = savePosition({
    coin,
    size_usd:     fillUsd,
    entry_price:  fillPx,
    entry_apy:    0,
    entry_time:   Date.now(),
    mode:         'PRODUCTION',
    strategy_id:  'hunter_long',
    sl_price:     sl,
    tp_price:     tp,
    entry_equity: entryEquity,
    side:         'long',
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] ✅ PROD HUNTER_LONG OPEN LONG #${coin} | oid: ${fill.oid} | filled: ${fillSz} @ $${fillPx} ($${fillUsd.toFixed(2)}) | slip: ${slip.label} | id: ${id}`,
  );
  recordBotOid(fill.oid, coin, 'open', id);

  const fillInfo = { sizeUsd: fillUsd, fillPx, sz: fillSz };

  // SL trigger (ниже entry для LONG)
  let slOid;
  try {
    slOid = await placeHunterLongTrigger(coin, fillSz, sl, 'sl', szDecimals);
    logger.info(`[Executor] PROD HUNTER_LONG #${coin} SL trigger armed @ $${sl} | oid=${slOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER_LONG #${coin} SL placeOrder failed: ${err.message} — ROLLBACK market close`);
    const rb = await rollbackHunterLongOpen(coin, fillSz, id, fillPx, /* triggerOids */ []);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'placeSL', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  // TP trigger (выше entry для LONG)
  let tpOid;
  try {
    tpOid = await placeHunterLongTrigger(coin, fillSz, tp, 'tp', szDecimals);
    logger.info(`[Executor] PROD HUNTER_LONG #${coin} TP trigger armed @ $${tp} | oid=${tpOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER_LONG #${coin} TP placeOrder failed: ${err.message} — ROLLBACK (cancel SL + market close)`);
    const rb = await rollbackHunterLongOpen(coin, fillSz, id, fillPx, [slOid]);
    if (!silent) await notifyHunterLongOpenFailed({ coin, stage: 'placeTP', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  updateHunterTriggerOids(id, { hunter_sl_oid: slOid, hunter_tp_oid: tpOid });

  if (!silent) {
    await notifyHunterLongOpenProd({
      coin, sizeUsd: fillUsd, balance, leverage,
      fillPx, markPrice, dumpPct, sl, tp,
      slOid, tpOid, slipLabel: slip.label, fee,
    });
  }

  notify('afterOpen', {
    coin, price: fillPx, sizeUsd: fillUsd, positionId: Number(id),
    mode: 'PRODUCTION', strategy: 'hunter_long',
  });

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
}

/**
 * Откат при сбое триггеров для LONG: cancel triggers + market SELL для закрытия long.
 */
async function rollbackHunterLongOpen(coin, sz, dbId, fillPx, triggerOids) {

  for (const oid of triggerOids) {
    try {
      await cancelOrderFor(coin, oid);
      logger.info(`[Executor] HUNTER_LONG ROLLBACK #${coin} — cancelled trigger oid=${oid}`);
    } catch (err) {
      logger.error(`[Executor] HUNTER_LONG ROLLBACK #${coin} — cancel oid=${oid} failed: ${err.message}`);
    }
  }

  let closeResult;
  try {
    closeResult = await retryWithBackoff(
      () => closeMarket(coin, sz, MARKET_SLIPPAGE),
      { label: `hunter-long-rollback-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    logger.error(`[Executor] HUNTER_LONG ROLLBACK #${coin} — marketClose THREW: ${err.message}. РУЧНОЕ ВМЕШАТЕЛЬСТВО!`);
    return null;
  }

  const closeFill = parseFillResponse(closeResult, 'CLOSE');
  if (!closeFill.ok) {
    logger.error(`[Executor] HUNTER_LONG ROLLBACK #${coin} — close rejected: ${closeFill.error}. РУЧНОЕ ВМЕШАТЕЛЬСТВО!`);
    return null;
  }
  const closePx = closeFill.avgPx;
  const closeNotional = closeFill.totalSz * closePx;
  const totalFee = closeNotional * ONE_LEG + (sz * fillPx) * ONE_LEG;
  // pricePnl на LONG: (close − entry) × sz
  const pricePnl = sz * (closePx - fillPx);
  const realized = pricePnl - totalFee;

  try {
    dbClosePosition(dbId, {
      close_price:  closePx,
      realized_pnl: realized,
      fee_paid:     totalFee,
      reason:       'hunter_long_rollback',
    });
    logger.info(
      `[Executor] HUNTER_LONG ROLLBACK #${coin} closed: entry $${fillPx} → close $${closePx} | pnl $${realized.toFixed(4)}`,
    );
  } catch (err) {
    logger.error(`[Executor] HUNTER_LONG ROLLBACK #${coin} — dbClosePosition failed: ${err.message}`);
  }

  setCooldown(coin);
  return { closePx, pnl: realized, fee: totalFee };
}

// ─────────────────────────────────────────────────
//  TREND FOLLOW (Chill Boy) OPEN — Iter F.3
//  direction-aware: LONG → market BUY + SL (ниже) + TP (выше)
//                   SHORT → market SELL + SL (выше) + TP (ниже)
// ─────────────────────────────────────────────────

export async function productionTrendFollowOpen(
  coin, markPrice, direction, sl, tp, silent = false, entryFeatures = null,
) {
  const isLong   = direction === 'LONG';
  const sideLbl  = isLong ? 'LONG' : 'SHORT';
  const placeTrigger = isLong ? placeHunterLongTrigger : placeHunterTrigger;

  let balance;
  try {
    balance = await getBalance();
  } catch (err) {
    logger.error(`[Executor] PROD CHILLBOY OPEN #${coin} — getBalance failed: ${err.message}`);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'balance', reason: err.message, rolledBack: false });
    return { ok: false };
  }
  if (balance <= 0) {
    logger.warn(`[Executor] PROD CHILLBOY OPEN #${coin} — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    logger.error(`[Executor] PROD CHILLBOY OPEN #${coin} — resolveAsset failed: ${err.message}`);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'resolveAsset', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  // Reuse hunterLeverage до отдельного CHILL_BOY_LEVERAGE / dynamic-leverage задачи.
  const leverage = config.trading.hunterLeverage;
  const utilization = config.trading.chillBoyBalanceUtil;
  const effectiveBalance = balance * leverage;
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'ChillBoy', equity: balance, capBase: effectiveBalance,
    capUtil: utilization, price: markPrice, sl, szDecimals,
  });
  if (tooSmall) {
    logger.warn(
      `[Executor] [CHILLBOY SKIP] #${coin} — size $${sizeUsd.toFixed(2)} / sz=${sz} ` +
        `(${(utilization * 100).toFixed(0)}% от $${balance.toFixed(2)} × ${leverage}x lev = $${effectiveBalance.toFixed(2)})`,
    );
    return { ok: false };
  }

  try {
    await setLeverage(coin, leverage);
  } catch (err) {
    logger.error(`[Executor] PROD CHILLBOY OPEN #${coin} — setLeverage(${leverage}) failed: ${err.message}`);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'setLeverage', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  logger.info(
    `[Executor] PROD CHILLBOY OPEN ${sideLbl} #${coin} — placing market ${isLong ? 'BUY' : 'SELL'} | sz=${sz} (~$${(sz * markPrice).toFixed(2)}) | mark=$${markPrice}`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () => openMarket(coin, isLong, sz, MARKET_SLIPPAGE),
      { label: `chillboy-open-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    if (OI_CAP_REGEX.test(err.message ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 CHILLBOY OI CAP BAN #${coin} — ${err.message}. Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD CHILLBOY OPEN #${coin} — marketOpen failed: ${err.message}`);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'marketOpen', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  const fill = parseFillResponse(result, 'OPEN');
  if (!fill.ok) {
    if (OI_CAP_REGEX.test(fill.error ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 CHILLBOY OI CAP BAN #${coin} — ${fill.error}. Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD CHILLBOY OPEN #${coin} — exchange rejected: ${fill.error}`);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'fill', reason: fill.error, rolledBack: false });
    return { ok: false };
  }

  const fillPx  = fill.avgPx;
  const fillSz  = fill.totalSz;
  const fillUsd = fillSz * fillPx;
  const slip    = checkSlippage(markPrice, fillPx, isLong ? 'BUY' : 'SELL');
  const fee     = fillUsd * ONE_LEG;

  // SL/TP стратег задал от сигнальной цены; пересчитываем от реального филла —
  // иначе при проскальзывании стоп встаёт вплотную к entry (инцидент TST 2026-05-19).
  sl = fillPx * (sl / markPrice);
  tp = fillPx * (tp / markPrice);

  let entryEquity = null;
  try {
    const summary = await getAccountSummary();
    entryEquity = summary.equity;
  } catch (err) {
    logger.warn(`[Executor] PROD CHILLBOY OPEN #${coin} — entry equity capture failed: ${err.message}`);
  }

  const id = savePosition({
    coin,
    size_usd:     fillUsd,
    entry_price:  fillPx,
    entry_apy:    0,
    entry_time:   Date.now(),
    mode:         'PRODUCTION',
    strategy_id:  'trend_follow',
    sl_price:     sl,
    tp_price:     tp,
    entry_equity: entryEquity,
    side:         isLong ? 'long' : 'short',
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] ✅ PROD CHILLBOY OPEN ${sideLbl} #${coin} | oid: ${fill.oid} | filled: ${fillSz} @ $${fillPx} ($${fillUsd.toFixed(2)}) | slip: ${slip.label} | id: ${id}`,
  );
  recordBotOid(fill.oid, coin, 'open', id);

  const fillInfo = { sizeUsd: fillUsd, fillPx, sz: fillSz };

  let slOid;
  try {
    slOid = await placeTrigger(coin, fillSz, sl, 'sl', szDecimals);
    logger.info(`[Executor] PROD CHILLBOY #${coin} SL trigger armed @ $${sl} | oid=${slOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD CHILLBOY #${coin} SL placeOrder failed: ${err.message} — ROLLBACK market close`);
    const rb = await rollbackTrendFollowOpen(coin, fillSz, id, fillPx, isLong, /* triggerOids */ []);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'placeSL', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  let tpOid;
  try {
    tpOid = await placeTrigger(coin, fillSz, tp, 'tp', szDecimals);
    logger.info(`[Executor] PROD CHILLBOY #${coin} TP trigger armed @ $${tp} | oid=${tpOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD CHILLBOY #${coin} TP placeOrder failed: ${err.message} — ROLLBACK (cancel SL + market close)`);
    const rb = await rollbackTrendFollowOpen(coin, fillSz, id, fillPx, isLong, [slOid]);
    if (!silent) await notifyTrendFollowOpenFailed({ coin, direction: sideLbl, stage: 'placeTP', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  updateHunterTriggerOids(id, { hunter_sl_oid: slOid, hunter_tp_oid: tpOid });

  if (!silent) {
    await notifyTrendFollowOpenProd({
      coin, direction: sideLbl, sizeUsd: fillUsd, balance, leverage, utilization,
      fillPx, markPrice, sl, tp, slOid, tpOid, slipLabel: slip.label, fee,
    });
  }

  notify('afterOpen', {
    coin, price: fillPx, sizeUsd: fillUsd, positionId: Number(id),
    mode: 'PRODUCTION', strategy: 'trend_follow',
  });

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
}

/**
 * Откат при сбое триггеров для trend_follow: cancel triggers + market close (side-aware).
 * marketClose сам инвертирует направление по open-позиции.
 */
async function rollbackTrendFollowOpen(coin, sz, dbId, fillPx, isLong, triggerOids) {

  for (const oid of triggerOids) {
    try {
      await cancelOrderFor(coin, oid);
      logger.info(`[Executor] CHILLBOY ROLLBACK #${coin} — cancelled trigger oid=${oid}`);
    } catch (err) {
      logger.error(`[Executor] CHILLBOY ROLLBACK #${coin} — cancel oid=${oid} failed: ${err.message}`);
    }
  }

  let closeResult;
  try {
    closeResult = await retryWithBackoff(
      () => closeMarket(coin, sz, MARKET_SLIPPAGE),
      { label: `chillboy-rollback-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    logger.error(`[Executor] CHILLBOY ROLLBACK #${coin} — marketClose THREW: ${err.message}. РУЧНОЕ ВМЕШАТЕЛЬСТВО!`);
    return null;
  }

  const closeFill = parseFillResponse(closeResult, 'CLOSE');
  if (!closeFill.ok) {
    logger.error(`[Executor] CHILLBOY ROLLBACK #${coin} — close rejected: ${closeFill.error}. РУЧНОЕ ВМЕШАТЕЛЬСТВО!`);
    return null;
  }
  const closePx = closeFill.avgPx;
  const closeNotional = closeFill.totalSz * closePx;
  const totalFee = closeNotional * ONE_LEG + (sz * fillPx) * ONE_LEG;
  // pricePnl: LONG → close − entry, SHORT → entry − close
  const pricePnl = isLong ? sz * (closePx - fillPx) : sz * (fillPx - closePx);
  const realized = pricePnl - totalFee;

  try {
    dbClosePosition(dbId, {
      close_price:  closePx,
      realized_pnl: realized,
      fee_paid:     totalFee,
      reason:       'trend_follow_rollback',
    });
    logger.info(
      `[Executor] CHILLBOY ROLLBACK #${coin} closed: entry $${fillPx} → close $${closePx} | pnl $${realized.toFixed(4)}`,
    );
  } catch (err) {
    logger.error(`[Executor] CHILLBOY ROLLBACK #${coin} — dbClosePosition failed: ${err.message}`);
  }

  return { closePx, pnl: realized, fee: totalFee };
}

// ─────────────────────────────────────────────────
//  CLOSE
// ─────────────────────────────────────────────────

/**
 * Закрывает реальную позицию.
 *
 * @param {{ price: number, reason: string }} signal
 * @param {Object} position — строка из БД
 * @param {boolean} [silent=false]
 * @returns {Promise<{ ok: boolean, pnl?: number, holdHours?: number }>}
 */
export async function productionClose(signal, position, silent = false) {
  const coin = position.coin;
  // Close-направление инвертируется к open: short→BUY, long→SELL.
  const posSide      = position.side || 'short';
  const closeLabel   = posSide === 'long' ? 'SELL' : 'BUY';

  const holdMs = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;

  logger.info(
    `[Executor] PROD CLOSE ${posSide.toUpperCase()} #${coin} — reason: ${signal.reason} | ` +
      `held: ${holdHours.toFixed(1)}h | markPrice: $${signal.price}`,
  );

  // ── 0. Снимаем реальный накопленный фандинг ДО закрытия ─
  // После marketClose позиция исчезнет из clearinghouseState и cumFunding пропадёт.
  // HL convention (side-agnostic): cumFunding.sinceOpen — сколько трейдер заплатил
  // (signed). Получал фандинг → отрицательный → realFundingUsd = -sinceOpen положительный.
  // Платил → положительный → realFundingUsd отрицательный.
  // Подтверждено эмпирически на PURR (short): sinceOpen=-0.009869 → +$0.009869 профита.
  let realFundingUsd = null;
  try {
    const positions = await getPositions();
    const found = positions.find((ap) => (ap?.position?.coin) === coin);
    if (!found) {
      // Позиции уже нет на бирже — это external close (SL/TP/liq/manual).
      // marketClose ниже упадёт с "No position found" и уйдёт в external-close ветку,
      // где cause определяется через userFills. cumFunding читать неоткуда — это нормально.
      logger.info(
        `[Executor] PROD CLOSE #${coin} — position absent in clearinghouseState (external close path); skipping cumFunding read`,
      );
    } else {
      const sinceOpenRaw = found?.position?.cumFunding?.sinceOpen;
      const sinceOpen = parseFloat(sinceOpenRaw);
      if (Number.isFinite(sinceOpen)) {
        realFundingUsd = -sinceOpen;
        logger.info(
          `[Executor] PROD CLOSE #${coin} — cumFunding.sinceOpen=${sinceOpen} → realFundingUsd=$${realFundingUsd.toFixed(6)}`,
        );
      } else {
        logger.warn(
          `[Executor] PROD CLOSE #${coin} — cumFunding.sinceOpen unparseable (${sinceOpenRaw}), fallback to APY estimate`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[Executor] PROD CLOSE #${coin} — failed to read cumFunding (${err.message}), fallback to APY estimate`,
    );
  }

  // ── 1. Отправляем ордер на закрытие ──────────
  let result;
  try {
    result = await retryWithBackoff(
      () =>
        closeMarket(coin, undefined, MARKET_SLIPPAGE), // size undefined → закрыть полностью
      { label: `close-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    if (err.message?.includes("No position found")) {
      logger.error(
        `[Executor] PROD CLOSE #${coin} — no position on exchange! ` +
          `Likely closed via ADL/SL/TP or liquidated. Syncing DB…`,
      );

      let estimatedPnl = 0;
      let equity = 0;
      try {
        const summary = await getAccountSummary();
        equity = summary.equity;
        // PnL ≈ equity_now − equity_at_open. Если entry_equity не сохранён
        // (старая позиция) — оставим 0, чтобы не врать.
        const hasEntry = Number.isFinite(position.entry_equity) && position.entry_equity > 0;
        const equityOk = Number.isFinite(equity) && equity > 0;

        // Guard: API/indexer-glitch может вернуть implausibly low equity
        // (был кейс TON id=61 2026-05-12: TP реально дал +$0.80, а equity
        // на момент reconcile показала $0.5x → estPnl получился −$24.48).
        // Если equity < половины entry_equity — это почти всегда glitch,
        // настоящий трейд физически не мог уронить equity на 50%+ при lev≤1x.
        if (hasEntry && equityOk && equity >= position.entry_equity * 0.5) {
          estimatedPnl = equity - position.entry_equity;
        } else if (hasEntry && equityOk) {
          logger.warn(
            `[Executor] PROD CLOSE #${coin} — equity $${equity.toFixed(2)} implausibly low ` +
              `vs entry_equity $${position.entry_equity.toFixed(2)} (likely API glitch), ` +
              `writing 0 instead of fake negative. Check Reporter alert for real PnL.`,
          );
        } else if (!equityOk) {
          logger.warn(
            `[Executor] PROD CLOSE #${coin} — equity unreadable ($${equity}), ` +
              `est. PnL not computable, writing 0 instead of fake negative.`,
          );
        }
      } catch { /* PnL неизвестен */ }

      // Classify cause via userFills: matched oid → TP/SL trigger;
      // liquidation flag → liquidation; иначе manual_close (оператор закрыл руками
      // через UI до того, как бот успел отправить marketClose).
      let classified = { reason: 'external_close_detected_on_exit', pnl: null, closePx: null };
      try {
        const fills = await fetchUserFills(position.entry_time - 60_000);
        const coinFills = fills.filter((f) => f.coin.toUpperCase() === coin.toUpperCase());
        const c = classifyClose(position, coinFills);
        if (c.reason !== 'external_unknown') {
          classified.reason = c.reason;
        }
        if (Number.isFinite(c.pnl)) {
          classified.pnl = c.pnl;
          estimatedPnl = c.pnl;  // точный PnL из fills предпочтительнее equity-delta
        }
        if (Number.isFinite(c.closePx)) classified.closePx = c.closePx;
        logger.info(
          `[Executor] PROD CLOSE #${coin} — external classified as '${classified.reason}' | ` +
            `pnl(fills)=${classified.pnl != null ? '$' + classified.pnl.toFixed(4) : 'n/a'} | ` +
            `closePx(fills)=${classified.closePx != null ? '$' + classified.closePx : 'n/a'}`,
        );
      } catch (clsErr) {
        logger.debug(`[Executor] classifyClose failed: ${clsErr.message}`);
      }

      try {
        dbClosePosition(position.id, {
          close_price:  classified.closePx ?? 0,
          realized_pnl: estimatedPnl,
          fee_paid:     0,
          reason:       classified.reason,
        });
        logger.info(
          `[Executor] ✅ DB synced: #${coin} (id=${position.id}) → CLOSED | ` +
            `reason: ${classified.reason} | est. PnL: $${estimatedPnl.toFixed(4)}`,
        );
        if (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long') {
          setHunterCrossCooldown(position.coin);
        }
        // Fix C (2026-05-20): external close на hunter_long почти всегда = убыток
        // (delist/halt/liquidation/user manual close). Ставим post-SL cooldown +
        // инкрементим SL-streak, чтобы не войти повторно в ту же токсичную монету.
        // Исключение: если classifier явно вернул tp_trigger → не пенализуем.
        if (
          position.strategy_id === 'hunter_long' &&
          !['tp_trigger', 'hunter_long_tp', 'hunter_long_trail_tp'].includes(classified.reason)
        ) {
          recordHunterLongLossEvent(position.coin);
        }
        // Симметрия Fix C для SHORT (2026-06-12): external close на hunter SHORT —
        // тоже почти всегда убыток (ликвидация / ручное закрытие оператором). Раньше
        // шорт получал только cross-cooldown (60мин), без post-SL cooldown, поэтому
        // бот мог перезашортить ту же монету через ~час (кейс HMSTR #142→#147).
        // Ставим post-SL cooldown, кроме явного TP.
        if (
          position.strategy_id === 'hunter' &&
          !['tp_trigger', 'hunter_tp'].includes(classified.reason)
        ) {
          recordHunterSlExternal(position.coin);
        }
      } catch (dbErr) {
        logger.error(`[Executor] DB close failed: ${dbErr.message}`);
      }

      await notifyExternalClose({
        coin, sizeUsd: position.size_usd, entryPrice: position.entry_price,
        holdHours, estimatedPnl, equity,
      });
      return { ok: false };
    }

    logger.error(
      `[Executor] PROD CLOSE #${coin} — order request failed: ${err.message}`,
    );
    await notifyCloseFailed({
      coin,
      error: `Ордер не отправлен (сетевая ошибка):\n<code>${err.message}</code>`,
      positionStillOpen: true,
    });
    return { ok: false };
  }

  // ── 2. Парсим ответ ──────────────────────────
  const fill = parseFillResponse(result, "CLOSE");

  if (!fill.ok) {
    logger.error(
      `[Executor] PROD CLOSE #${coin} — exchange rejected: ${fill.error}`,
    );
    await notifyCloseRejected({ coin, error: fill.error });
    return { ok: false };
  }

  // ── 3. Slippage guard ────────────────────────
  const slip = checkSlippage(signal.price, fill.avgPx, closeLabel);

  if (slip.ban) {
    banSlippage(coin);
    logger.error(
      `[Executor] 🚫 SLIPPAGE BAN #${coin} ${closeLabel}: ${slip.label} (>${1.5}%) — ` +
        `trading paused for ${SLIPPAGE_BAN_TTL_MS / 60_000}min`,
    );
    await notifySlippageBan({
      coin, slipLabel: slip.label,
      banMinutes: SLIPPAGE_BAN_TTL_MS / 60_000,
    });
  } else if (slip.warn) {
    logger.warn(
      `[Executor] ⚠️ SLIPPAGE #${coin} ${closeLabel}: expected $${signal.price} → fill $${fill.avgPx} (${slip.label})`,
    );
  } else {
    logger.debug(`[Executor] Slippage #${coin} ${closeLabel}: ${slip.label}`);
  }

  // ── 3.5. Re-entry cooldown ──────────────────
  setCooldown(coin);
  logger.info(
    `[Executor] ⏳ Re-entry cooldown set: #${coin} → ${REENTRY_COOLDOWN_MS / 60_000}min`,
  );

  // ── 4. Считаем реальный PnL ──────────────────
  const { pricePnl, fundingPnl, totalFee, realizedPnl, fundingSource } =
    calcPnl(position, fill.avgPx, holdHours, realFundingUsd);

  // ── 5. Закрываем в БД ────────────────────────
  // Hunter: подмешиваем MFE/MAE из tick-трекера + hold_seconds.
  let exitFeatures = null;
  if (position.strategy_id === 'hunter') {
    const mm = consumeHunterMfeMae(position.id);
    exitFeatures = {
      mfe_usd:      mm?.mfeUsd ?? null,
      mae_usd:      mm?.maeUsd ?? null,
      mfe_pct:      mm?.mfePct ?? null,
      mae_pct:      mm?.maePct ?? null,
      hold_seconds: Math.round(holdMs / 1000),
    };
    if (signal.reason === 'hunter_trail_tp') {
      exitFeatures.trail_peak_pct      = signal.peakPct ?? getHunterPeakPct(position.id);
      exitFeatures.trail_give_back_pct = signal.giveBackPct ?? null;
    }
    clearHunterTrailState(position.id);
  } else if (position.strategy_id === 'hunter_long') {
    const mm = consumeHunterLongMfeMae(position.id);
    exitFeatures = {
      mfe_usd:      mm?.mfeUsd ?? null,
      mae_usd:      mm?.maeUsd ?? null,
      mfe_pct:      mm?.mfePct ?? null,
      mae_pct:      mm?.maePct ?? null,
      hold_seconds: Math.round(holdMs / 1000),
    };
    if (signal.reason === 'hunter_long_trail_tp') {
      exitFeatures.trail_peak_pct      = signal.peakPct ?? getHunterLongPeakPct(position.id);
      exitFeatures.trail_give_back_pct = signal.giveBackPct ?? null;
    }
    clearHunterLongTrailState(position.id);
  } else if (position.strategy_id === 'adopt') {
    exitFeatures = { hold_seconds: Math.round(holdMs / 1000) };
    if (signal.reason === 'adopt_trail_tp' || signal.reason === 'adopt_breakeven_ratchet') {
      exitFeatures.trail_peak_pct      = signal.peakPct ?? getAdoptPeakPct(position.id);
      exitFeatures.trail_give_back_pct = signal.giveBackPct ?? null;
    }
    clearAdoptState(position.id);
  }

  dbClosePosition(position.id, {
    close_price:  fill.avgPx,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
    exitFeatures,
  });

  if (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long') {
    setHunterCrossCooldown(position.coin);
  }

  recordBotOid(fill.oid, coin, 'close', position.id);

  const sign = realizedPnl >= 0 ? "+" : "";
  const fSign = fundingPnl >= 0 ? "+" : "";
  logger.info(
    `[Executor] ✅ PROD CLOSE #${coin} | oid: ${fill.oid} | ` +
      `filled: ${fill.totalSz} @ $${fill.avgPx} | slippage: ${slip.label} | ` +
      `pricePnl: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)} | ` +
      `fundingPnl: ${fSign}$${fundingPnl.toFixed(4)} (${fundingSource}) | fees: $${totalFee.toFixed(4)} | ` +
      `total: ${sign}$${realizedPnl.toFixed(4)} | held: ${holdHours.toFixed(1)}h`,
  );

  // ── 6. Reconciliation (fire-and-forget) ──────
  reconcile(coin, "CLOSE", { expectPosition: false });

  // ── 7. Telegram + hooks ──────────────────────
  if (!silent) {
    if (position.strategy_id === 'hunter' && signal.reason === 'hunter_trail_tp') {
      await notifyHunterTrailTp({
        coin,
        entryPrice:   position.entry_price,
        closePrice:   fill.avgPx,
        peakPct:      signal.peakPct ?? exitFeatures?.trail_peak_pct ?? 0,
        giveBackPct:  signal.giveBackPct ?? exitFeatures?.trail_give_back_pct ?? 0,
        pnl:          realizedPnl,
        fee:          totalFee,
        holdMinutes:  Math.round(holdHours * 60),
        fixedTpPrice: position.tp_price,
      });
    } else if (position.strategy_id === 'hunter_long' && signal.reason === 'hunter_long_trail_tp') {
      await notifyHunterLongTrailTp({
        coin,
        entryPrice:   position.entry_price,
        closePrice:   fill.avgPx,
        peakPct:      signal.peakPct ?? exitFeatures?.trail_peak_pct ?? 0,
        giveBackPct:  signal.giveBackPct ?? exitFeatures?.trail_give_back_pct ?? 0,
        pnl:          realizedPnl,
        fee:          totalFee,
        holdMinutes:  Math.round(holdHours * 60),
        fixedTpPrice: position.tp_price,
      });
    } else {
      await notifyProductionClose({
        coin, holdHours, entryPrice: position.entry_price,
        avgPx: fill.avgPx, slip, pricePnl, fundingPnl,
        totalFee, realizedPnl, reason: signal.reason,
        oid: fill.oid, side: posSide,
      });
    }
  }

  // Circuit breaker: фиксируем убыток
  if (realizedPnl < 0) {
    const tripped = recordLoss(coin, realizedPnl);
    if (tripped) {
      logger.error(
        `[Executor] 🛑 CIRCUIT BREAKER TRIPPED after PROD loss #${coin} ($${realizedPnl.toFixed(4)})`,
      );
      await notifyCircuitBreaker({
        losses: 3,
        pauseMinutes: CB_PAUSE_MS / 60_000,
        lastCoin: coin,
        lastPnl: realizedPnl,
      });
    }
  }

  notify('afterClose', {
    coin, pnl: realizedPnl, holdHours,
    reason: signal.reason, fill, mode: 'PRODUCTION',
  });

  return { ok: true, pnl: realizedPnl, holdHours };
}

