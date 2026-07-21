// ─────────────────────────────────────────────────
//  Hunter Open — открытие реальных Hunter-позиций на Hyperliquid
//  Общий скелет openHunterPosition(cfg) + тонкие адаптеры SHORT/LONG +
//  trigger-ордера (SL/TP) + rollback. Пара к hunterPaperOpen (paper.js).
//  Диспетчеризуется из index.js (handleOpen). Close-путь — close.js.
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
  setLeverage,
} from '../exchange.js';
import { resolveAsset, parseFillResponse } from './fill-parser.js';
import { resolveEntrySize, sizeBudgetFromEquity } from './sizing.js';
import {
  checkSlippage, formatHlPrice,
  MARKET_SLIPPAGE, ONE_LEG,
} from './math.js';
import { setCooldown, banOiCap } from './state.js';
import { notify } from './hooks.js';
import {
  notifyOiCapBan,
  notifyHunterOpenProd, notifyHunterOpenFailed,
  notifyHunterLongOpenProd, notifyHunterLongOpenFailed,
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
 * Обобщённый скелет открытия Hunter-позиции на бирже (SHORT и LONG ~95%
 * идентичны). Различия инкапсулированы в `cfg`. Поведение строго 1:1 с
 * прежними productionHunterOpen / productionHunterLongOpen.
 *
 * Поток: getBalance → resolveAsset → sizing → setLeverage → market open →
 * OI-cap detect → parse fill → save position → SL trigger → TP trigger →
 * updateHunterTriggerOids → notify. Любой fail после market open → rollback
 * (cancel триггеров + market close).
 *
 * @param {object}   cfg
 * @param {'hunter'|'hunter_long'} cfg.strategyId
 * @param {'short'|'long'}         cfg.side
 * @param {boolean}  cfg.isBuyOpen        — openMarket is_buy (false=SELL short, true=BUY long)
 * @param {'SELL'|'BUY'} cfg.slipSide     — сторона для checkSlippage
 * @param {number}   cfg.util             — config.trading.hunter[Long]BalanceUtil
 * @param {string}   cfg.sizeTag          — 'Hunter' | 'HunterLong' (resolveEntrySize)
 * @param {string}   cfg.logTag           — 'HUNTER' | 'HUNTER_LONG'
 * @param {string}   cfg.openLabel        — retry-label market open
 * @param {string}   cfg.signalPctField   — 'spikePct' | 'dumpPct' (поле notify)
 * @param {Function} cfg.placeTriggerFn   — placeHunter[Long]Trigger
 * @param {Function} cfg.notifyFailed     — notifyHunter[Long]OpenFailed
 * @param {Function} cfg.notifyOpenProd   — notifyHunter[Long]OpenProd
 * @param {Function} cfg.rollback         — rollbackHunter[Long]Open
 * @param {boolean}  cfg.trackTriggerOids — SHORT=true: recordBotOid для SL/TP; LONG=false
 *
 * @param {string}  coin
 * @param {number}  markPrice    — цена в момент сигнала (для лога/slippage)
 * @param {number}  signalPct    — величина пампа/дампа (для уведомления)
 * @param {number}  sl           — SL price
 * @param {number}  tp           — TP price
 * @param {boolean} [silent=false]
 */
async function openHunterPosition(cfg, coin, markPrice, signalPct, sl, tp, silent = false, entryFeatures = null) {

  // ── 1. Баланс ──
  let balance;
  try {
    balance = await getBalance();
  } catch (err) {
    logger.error(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — getBalance failed: ${err.message}`);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'balance', reason: err.message, rolledBack: false });
    return { ok: false };
  }
  if (balance <= 0) {
    logger.warn(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  // ── 2. szDecimals + размер (util utilization) ──
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    logger.error(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — resolveAsset failed: ${err.message}`);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'resolveAsset', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  // Leverage расширяет нотиональный размер позиции. Два режима сайзинга:
  //  · fromEquity=false (старый): база = свободный баланс × leverage, util от него.
  //  · fromEquity=true: целим util от ВСЕГО депо (equity), потолок — свободная
  //    маржа. Стабильный размер «половина депо», не ужимается при открытой ручной
  //    позе, но за свободную маржу не выходит. См. equityCappedNotional.
  const leverage = config.trading.hunterLeverage;
  const util = cfg.util;
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
        `[Executor] [${cfg.logTag} SKIP] #${coin} — мало свободной маржи: доступно $${budget.available.toFixed(2)} ` +
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
    coin, tag: cfg.sizeTag, equity: riskEquity, capBase,
    capUtil, price: markPrice, sl, szDecimals,
  });
  if (tooSmall) {
    logger.warn(
      `[Executor] [${cfg.logTag} SKIP] #${coin} — size $${sizeUsd.toFixed(2)} / sz=${sz} ` +
        `(free $${balance.toFixed(2)}, ${leverage}x, fromEquity=${config.trading.hunterSizeFromEquity})`,
    );
    return { ok: false };
  }

  // ── 3. Leverage ──
  try {
    await setLeverage(coin, leverage);
  } catch (err) {
    logger.error(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — setLeverage(${leverage}) failed: ${err.message}`);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'setLeverage', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  // ── 4. Market open (taker) ──
  const sideUpper = cfg.side.toUpperCase();
  logger.info(
    `[Executor] PROD ${cfg.logTag} OPEN ${sideUpper} #${coin} — placing market ${cfg.isBuyOpen ? 'BUY' : 'SELL'} | sz=${sz} (~$${(sz * markPrice).toFixed(2)}) | mark=$${markPrice}`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () => openMarket(coin, cfg.isBuyOpen, sz, MARKET_SLIPPAGE),
      { label: `${cfg.openLabel}-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    // OI cap detection — симметрично с funding-веткой выше
    if (OI_CAP_REGEX.test(err.message ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 ${cfg.logTag} OI CAP BAN #${coin} — exchange rejected (${err.message}). ` +
          `Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — marketOpen failed: ${err.message}`);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'marketOpen', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  const fill = parseFillResponse(result, 'OPEN');
  if (!fill.ok) {
    // OI cap detection — биржа могла "отклонить" вместо throw
    if (OI_CAP_REGEX.test(fill.error ?? '')) {
      const { count, ttlMs } = banOiCap(coin);
      const banMin = Math.round(ttlMs / 60_000);
      logger.warn(
        `[Executor] 🚫 ${cfg.logTag} OI CAP BAN #${coin} — exchange rejected (${fill.error}). ` +
          `Banned for ${banMin}min (tier ${count}).`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: banMin });
      return { ok: false, reason: 'OI_CAP', ttlMs };
    }
    logger.error(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — exchange rejected: ${fill.error}`);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'fill', reason: fill.error, rolledBack: false });
    return { ok: false };
  }

  const fillPx  = fill.avgPx;
  const fillSz  = fill.totalSz;
  const fillUsd = fillSz * fillPx;
  const slip    = checkSlippage(markPrice, fillPx, cfg.slipSide);
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
    logger.warn(`[Executor] PROD ${cfg.logTag} OPEN #${coin} — entry equity capture failed: ${err.message}`);
  }

  const id = savePosition({
    coin,
    size_usd:     fillUsd,
    entry_price:  fillPx,
    entry_apy:    0, // Hunter не funding-based
    entry_time:   Date.now(),
    mode:         'PRODUCTION',
    strategy_id:  cfg.strategyId,
    sl_price:     sl,
    tp_price:     tp,
    entry_equity: entryEquity,
    side:         cfg.side,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] ✅ PROD ${cfg.logTag} OPEN ${sideUpper} #${coin} | oid: ${fill.oid} | filled: ${fillSz} @ $${fillPx} ($${fillUsd.toFixed(2)}) | slip: ${slip.label} | id: ${id}`,
  );
  recordBotOid(fill.oid, coin, 'open', id);

  const fillInfo = { sizeUsd: fillUsd, fillPx, sz: fillSz };

  // ── 6. Поставить SL trigger ──
  let slOid;
  try {
    slOid = await cfg.placeTriggerFn(coin, fillSz, sl, 'sl', szDecimals);
    logger.info(`[Executor] PROD ${cfg.logTag} #${coin} SL trigger armed @ $${sl} | oid=${slOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD ${cfg.logTag} #${coin} SL placeOrder failed: ${err.message} — ROLLBACK market close`);
    const rb = await cfg.rollback(coin, fillSz, id, fillPx, /* triggerOids */ []);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'placeSL', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  // ── 7. Поставить TP trigger ──
  let tpOid;
  try {
    tpOid = await cfg.placeTriggerFn(coin, fillSz, tp, 'tp', szDecimals);
    logger.info(`[Executor] PROD ${cfg.logTag} #${coin} TP trigger armed @ $${tp} | oid=${tpOid}`);
  } catch (err) {
    logger.error(`[Executor] PROD ${cfg.logTag} #${coin} TP placeOrder failed: ${err.message} — ROLLBACK (cancel SL + market close)`);
    const rb = await cfg.rollback(coin, fillSz, id, fillPx, [slOid]);
    if (!silent) await cfg.notifyFailed({ coin, stage: 'placeTP', reason: err.message, rolledBack: true, fill: fillInfo, rollback: rb });
    return { ok: false };
  }

  // ── 8. Сохранить oids ──
  updateHunterTriggerOids(id, { hunter_sl_oid: slOid, hunter_tp_oid: tpOid });
  // Асимметрия (выверено): SHORT трекает SL/TP-oid как «свои» для reconciler,
  // LONG исторически не трекает. Сохраняем 1:1 через флаг.
  if (cfg.trackTriggerOids) {
    recordBotOid(slOid, coin, 'sl_trigger', id);
    recordBotOid(tpOid, coin, 'tp_trigger', id);
  }

  // ── 9. Notify ──
  if (!silent) {
    await cfg.notifyOpenProd({
      coin, sizeUsd: fillUsd, balance, leverage,
      fillPx, markPrice, [cfg.signalPctField]: signalPct, sl, tp,
      slOid, tpOid, slipLabel: slip.label, fee,
    });
  }

  notify('afterOpen', {
    coin, price: fillPx, sizeUsd: fillUsd, positionId: Number(id),
    mode: 'PRODUCTION', strategy: cfg.strategyId, side: cfg.side,
  });

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
}

/**
 * Открывает реальную Hunter SHORT с триггерами SL/TP на бирже.
 * Тонкий адаптер над openHunterPosition (SHORT-cfg).
 *
 * @param {string} coin
 * @param {number} markPrice — цена в момент сигнала (для лога/slippage)
 * @param {number} spikePct  — величина пампа (для уведомления)
 * @param {number} sl        — SL price (выше entry для SHORT)
 * @param {number} tp        — TP price (ниже entry для SHORT)
 * @param {boolean} [silent=false]
 */
export async function productionHunterOpen(coin, markPrice, spikePct, sl, tp, silent = false, entryFeatures = null) {
  return openHunterPosition({
    strategyId:       'hunter',
    side:             'short',
    isBuyOpen:        false,           // market SELL
    slipSide:         'SELL',
    util:             config.trading.hunterBalanceUtil,
    sizeTag:          'Hunter',
    logTag:           'HUNTER',
    openLabel:        'hunter-open',
    signalPctField:   'spikePct',
    placeTriggerFn:   placeHunterTrigger,
    notifyFailed:     notifyHunterOpenFailed,
    notifyOpenProd:   notifyHunterOpenProd,
    rollback:         rollbackHunterOpen,
    trackTriggerOids: true,
  }, coin, markPrice, spikePct, sl, tp, silent, entryFeatures);
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
  return openHunterPosition({
    strategyId:       'hunter_long',
    side:             'long',
    isBuyOpen:        true,            // market BUY
    slipSide:         'BUY',
    util:             config.trading.hunterLongBalanceUtil,
    sizeTag:          'HunterLong',
    logTag:           'HUNTER_LONG',
    openLabel:        'hunter-long-open',
    signalPctField:   'dumpPct',
    placeTriggerFn:   placeHunterLongTrigger,
    notifyFailed:     notifyHunterLongOpenFailed,
    notifyOpenProd:   notifyHunterLongOpenProd,
    rollback:         rollbackHunterLongOpen,
    trackTriggerOids: false,           // LONG исторически не трекает SL/TP-oid (см. openHunterPosition)
  }, coin, markPrice, dumpPct, sl, tp, silent, entryFeatures);
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
