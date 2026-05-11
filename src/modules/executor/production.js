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
} from '../../core/database.js';
import {
  getExchange,
  getBalance,
  getAccountSummary,
  getPositions,
  setLeverage,
} from '../exchange.js';
import { resolveAsset, parseFillResponse } from './fill-parser.js';
import {
  calcSize, calcPnl, checkSlippage, formatHlPrice,
  MARKET_SLIPPAGE, MIN_ORDER_USD, FEE_RATE, ONE_LEG,
  HUNTER_BALANCE_UTILIZATION,
} from './math.js';
import {
  banRuntime, banSlippage, setCooldown,
  getLastRejectedAlert, setRejectedAlert,
  recordLoss, getCircuitBreakerStatus,
  banOiCap,
  RUNTIME_BAN_TTL_MS, SLIPPAGE_BAN_TTL_MS,
  REENTRY_COOLDOWN_MS, REJECTED_ALERT_TTL_MS,
  OI_CAP_BAN_TTL_MS,
  CB_PAUSE_MS,
} from './state.js';
import { reconcile } from './reconciler.js';
import { sleep } from './reconciler.js';
import { gate, notify } from './hooks.js';
import { consumeHunterMfeMae } from '../strategistSniper.js';
import {
  notifyProductionOpen, notifyOpenFailed, notifyOpenRejected,
  notifyOpenSkipped, notifySlippageBan,
  notifyProductionClose, notifyCloseRejected, notifyCloseFailed,
  notifyExternalClose,
  notifyRotate, notifyRotateFailed,
  notifyCircuitBreaker,
  notifyOiCapBan, notifyOiCapAfterRotate,
  notifyHunterOpenProd, notifyHunterOpenFailed,
} from './notifications.js';

// Регэксп для детекции "open interest at cap" в ответе биржи.
// Покрывает варианты: "open interest at cap", "exceeds max open interest",
// "OI cap reached", "open interest cap" и т.п.
const OI_CAP_REGEX = /open\s*interest|oi\s*cap/i;

// ─────────────────────────────────────────────────
//  OPEN
// ─────────────────────────────────────────────────

/**
 * Открывает реальную SHORT-позицию на Hyperliquid.
 *
 * Стратегия дельта-нейтральная: шортим перп для сбора фандинга.
 * Ордер: IoC Limit (имитация маркета) через sdk.custom.marketOpen().
 *
 * @param {string}  coin
 * @param {number}  price — текущая markPrice
 * @param {number}  apy   — текущий smoothedApy
 * @param {boolean} [silent=false]
 * @returns {Promise<{ ok: boolean, positionId?: number, sizeUsd?: number }>}
 */
export async function productionOpen(coin, price, apy, silent = false, strategyId = 'carry', side = 'short') {
  const exchange = getExchange();
  const isLong   = side === 'long';
  const orderLabel = isLong ? 'BUY' : 'SELL';
  const isBuy    = isLong; // is_buy=true → BUY (long), false → SELL (short)

  // ── 0. Equity ДО ордера — для корректной оценки PnL при external close ──
  let entryEquity = null;
  try {
    const summary = await getAccountSummary();
    entryEquity = summary.equity;
  } catch (err) {
    logger.warn(`[Executor] PROD OPEN #${coin} — failed to capture entry equity: ${err.message}`);
  }

  // ── 1. Баланс (с retry при подозрительно малом значении) ──
  let balance;
  try {
    balance = await getBalance();

    if (balance < MIN_ORDER_USD) {
      logger.info(
        `[Executor] PROD OPEN #${coin} — balance $${balance.toFixed(2)} < $${MIN_ORDER_USD}, ` +
          `waiting 2s for exchange to settle…`,
      );
      await sleep(2_000);
      balance = await getBalance();
      logger.info(
        `[Executor] PROD OPEN #${coin} — balance after retry: $${balance.toFixed(2)}`,
      );
    }
  } catch (err) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — failed to get balance: ${err.message}`,
    );
    await notifyOpenFailed({ coin, reason: `Не удалось получить баланс: <code>${err.message}</code>` });
    return { ok: false };
  }

  if (balance <= 0) {
    logger.warn(
      `[Executor] PROD OPEN #${coin} — balance is $${balance.toFixed(2)}, cannot open`,
    );
    await notifyOpenSkipped({ coin, reason: `Баланс: <b>$${balance.toFixed(2)}</b> — недостаточно средств.` });
    return { ok: false };
  }

  // ── 2. szDecimals ─────────────────────────────
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — resolveAsset failed: ${err.message}`,
    );
    await notifyOpenFailed({ coin, reason: `Актив не найден: <code>${err.message}</code>` });
    return { ok: false };
  }

  // ── 3. Расчёт размера ────────────────────────
  const { sizeUsd, sz, tooSmall } = calcSize(balance, price, szDecimals);

  if (tooSmall) {
    logger.warn(
      `[Executor] [SKIP] #${coin} — order size $${sizeUsd.toFixed(2)} / sz=${sz}`,
    );
    if (sz <= 0 && sizeUsd >= MIN_ORDER_USD) {
      await notifyOpenSkipped({
        coin,
        reason: `Размер позиции округляется до 0.\nБаланс: $${balance.toFixed(2)} | Цена: $${price} | szDecimals: ${szDecimals}`,
      });
    }
    return { ok: false };
  }

  // ── 3.5. Принудительно ставим 1x cross leverage ──
  try {
    await setLeverage(coin, 1);
  } catch (err) {
    logger.error(
      `[Executor] PROD OPEN #${coin} — setLeverage(1) failed: ${err.message}. Aborting open.`,
    );
    await notifyOpenFailed({
      coin,
      reason: `Не удалось установить leverage 1x:\n<code>${err.message}</code>`,
    });
    return { ok: false };
  }

  // ── 3.7. AI-Advisor gate ─────────────────────
  const verdict = await gate('beforeOpen', { coin, price, apy, sizeUsd });
  if (!verdict.allowed) {
    logger.info(`[Executor] PROD OPEN #${coin} — blocked by hook: ${verdict.vetoReason}`);
    return { ok: false };
  }

  // ── 4. Отправляем ордер ──────────────────────
  logger.info(
    `[Executor] PROD OPEN ${side.toUpperCase()} #${coin} — placing market ${orderLabel} | ` +
      `sz: ${sz} (~$${(sz * price).toFixed(2)}) | markPrice: $${price} | slippage: ${MARKET_SLIPPAGE * 100}%`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () =>
        exchange.custom.marketOpen(
          `${coin}-PERP`,
          isBuy, // is_buy: long=true (BUY), short=false (SELL)
          sz,
          undefined, // px: SDK берёт midPrice
          MARKET_SLIPPAGE,
        ),
      { label: `open-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    // OI cap detection — ловим до общей обработки сетевых ошибок
    if (OI_CAP_REGEX.test(err.message ?? '')) {
      banOiCap(coin);
      logger.warn(
        `[Executor] 🚫 OI CAP BAN #${coin} — exchange rejected (${err.message}). ` +
          `Banned for ${OI_CAP_BAN_TTL_MS / 60_000}min.`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: OI_CAP_BAN_TTL_MS / 60_000 });
      return { ok: false, reason: 'OI_CAP' };
    }

    logger.error(
      `[Executor] PROD OPEN #${coin} — order request failed: ${err.message}`,
    );
    await notifyOpenFailed({
      coin,
      reason: `Ордер не отправлен (сетевая ошибка):\n<code>${err.message}</code>`,
    });
    return { ok: false };
  }

  // ── 5. Парсим ответ ──────────────────────────
  const fill = parseFillResponse(result, "OPEN");

  if (!fill.ok) {
    // OI cap detection — биржа могла "отклонить" вместо throw
    if (OI_CAP_REGEX.test(fill.error ?? '')) {
      banOiCap(coin);
      logger.warn(
        `[Executor] 🚫 OI CAP BAN #${coin} — exchange rejected (${fill.error}). ` +
          `Banned for ${OI_CAP_BAN_TTL_MS / 60_000}min.`,
      );
      if (!silent) await notifyOiCapBan({ coin, banMinutes: OI_CAP_BAN_TTL_MS / 60_000 });
      return { ok: false, reason: 'OI_CAP' };
    }

    logger.error(
      `[Executor] PROD OPEN #${coin} — exchange rejected: ${fill.error}`,
    );

    banRuntime(coin);
    logger.warn(
      `[Executor] #${coin} → runtime blacklist for ${RUNTIME_BAN_TTL_MS / 60_000}min after OPEN REJECTED`,
    );

    // Telegram throttle: не спамим одинаковыми ошибками
    const now = Date.now();
    const lastAlert = getLastRejectedAlert(coin);
    if (!lastAlert || now - lastAlert >= REJECTED_ALERT_TTL_MS) {
      setRejectedAlert(coin);
      await notifyOpenRejected({
        coin, error: fill.error, sz, price,
        banMinutes: RUNTIME_BAN_TTL_MS / 60_000,
      });
    } else {
      logger.debug(
        `[Executor] OPEN REJECTED TG alert for #${coin} throttled (sent ${Math.round((now - lastAlert) / 1000)}s ago)`,
      );
    }

    return { ok: false };
  }

  // ── 6. Slippage guard ────────────────────────
  const slip = checkSlippage(price, fill.avgPx, orderLabel);

  if (slip.ban) {
    banSlippage(coin);
    logger.error(
      `[Executor] 🚫 SLIPPAGE BAN #${coin} ${orderLabel}: ${slip.label} (>${1.5}%) — ` +
        `trading paused for ${SLIPPAGE_BAN_TTL_MS / 60_000}min`,
    );
    await notifySlippageBan({
      coin, slipLabel: slip.label,
      banMinutes: SLIPPAGE_BAN_TTL_MS / 60_000,
    });
  } else if (slip.warn) {
    logger.warn(
      `[Executor] ⚠️ SLIPPAGE #${coin} ${orderLabel}: expected $${price} → fill $${fill.avgPx} (${slip.label})`,
    );
  } else {
    logger.debug(`[Executor] Slippage #${coin} ${orderLabel}: ${slip.label}`);
  }

  // ── 7. Сохраняем в БД ────────────────────────
  const fillUsd = fill.totalSz * fill.avgPx;

  let effectiveLeverage = "N/A";
  try {
    const { equity } = await getAccountSummary();
    if (equity > 0) {
      effectiveLeverage = (fillUsd / equity).toFixed(2) + "x";
    } else {
      effectiveLeverage = "∞ (equity=0)";
    }
  } catch (err) {
    logger.warn(`[Executor] Failed to calc effective leverage: ${err.message}`);
  }

  // entry_apy всегда сохраняется как abs — carry-edge magnitude. Знак заложен в side.
  const id = savePosition({
    coin,
    size_usd: fillUsd,
    entry_price: fill.avgPx,
    entry_apy: Math.abs(apy),
    entry_time: Date.now(),
    mode: "PRODUCTION",
    strategy_id: strategyId,
    entry_equity: entryEquity,
    side,
  });

  logger.info(
    `[Executor] ✅ PROD OPEN ${side.toUpperCase()} #${coin} | Leverage: ${effectiveLeverage} | oid: ${fill.oid} | ` +
      `filled: ${fill.totalSz} @ $${fill.avgPx} ($${fillUsd.toFixed(2)}) | ` +
      `slippage: ${slip.label} | APY: ${apy.toFixed(2)}% | id: ${id}`,
  );

  // ── 8. Reconciliation (fire-and-forget) ──────
  reconcile(coin, "OPEN", { expectPosition: true, expectedSzUsd: fillUsd });

  // ── 9. Telegram + hooks ──────────────────────
  if (!silent) {
    await notifyProductionOpen({
      coin, fillUsd, totalSz: fill.totalSz, avgPx: fill.avgPx,
      markPrice: price, apy, slip, effectiveLeverage,
      oid: fill.oid, dbId: id, side,
    });
  }

  notify('afterOpen', {
    coin, price, apy, sizeUsd: fillUsd,
    positionId: Number(id), fill, mode: 'PRODUCTION',
  });

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
}

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
async function placeHunterTrigger(coin, sz, triggerPx, tpsl, szDecimals) {
  const exchange = getExchange();
  // HL отклоняет цены с >5 значащих цифр / >(6−szDecimals) десятичных.
  // Сырая `entry × 1.02` для низкопрайсовых монет (REZ ~$0.05) даёт 7 sig figs
  // → "Order has invalid price". Округляем здесь явно.
  const px = formatHlPrice(triggerPx, szDecimals);
  const result = await retryWithBackoff(
    () =>
      exchange.exchange.placeOrder({
        coin: `${coin}-PERP`,
        is_buy: true, // закрытие SHORT → BUY reduce_only
        sz,
        // limit_px при isMarket=true игнорируется как цена исполнения, но HL требует поле.
        // Используем triggerPx как безопасный плейсхолдер.
        limit_px: px,
        order_type: { trigger: { triggerPx: px, isMarket: true, tpsl } },
        reduce_only: true,
      }),
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
  const exchange = getExchange();

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

  // Leverage расширяет нотиональный размер позиции: effectiveBalance = balance × leverage.
  // На $100 при util=0.5, lev=3 → $150 поза, маржа всё ещё $50.
  const leverage = config.trading.hunterLeverage;
  const effectiveBalance = balance * leverage;
  const { sizeUsd, sz, tooSmall } = calcSize(effectiveBalance, markPrice, szDecimals, HUNTER_BALANCE_UTILIZATION);
  if (tooSmall) {
    logger.warn(
      `[Executor] [HUNTER SKIP] #${coin} — size $${sizeUsd.toFixed(2)} / sz=${sz} ` +
        `(50% от $${balance.toFixed(2)} × ${leverage}x lev = $${effectiveBalance.toFixed(2)})`,
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
      () => exchange.custom.marketOpen(`${coin}-PERP`, false, sz, undefined, MARKET_SLIPPAGE),
      { label: `hunter-open-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
    );
  } catch (err) {
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — marketOpen failed: ${err.message}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'marketOpen', reason: err.message, rolledBack: false });
    return { ok: false };
  }

  const fill = parseFillResponse(result, 'OPEN');
  if (!fill.ok) {
    logger.error(`[Executor] PROD HUNTER OPEN #${coin} — exchange rejected: ${fill.error}`);
    if (!silent) await notifyHunterOpenFailed({ coin, stage: 'fill', reason: fill.error, rolledBack: false });
    return { ok: false };
  }

  const fillPx  = fill.avgPx;
  const fillSz  = fill.totalSz;
  const fillUsd = fillSz * fillPx;
  const slip    = checkSlippage(markPrice, fillPx, 'SELL');
  const fee     = fillUsd * ONE_LEG;

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
  const exchange = getExchange();

  // Cancel уже поставленных триггеров (если есть)
  for (const oid of triggerOids) {
    try {
      await exchange.exchange.cancelOrder({ coin: `${coin}-PERP`, o: oid });
      logger.info(`[Executor] HUNTER ROLLBACK #${coin} — cancelled trigger oid=${oid}`);
    } catch (err) {
      logger.error(`[Executor] HUNTER ROLLBACK #${coin} — cancel oid=${oid} failed: ${err.message}`);
    }
  }

  // Market close
  let closeResult;
  try {
    closeResult = await retryWithBackoff(
      () => exchange.custom.marketClose(`${coin}-PERP`, sz, undefined, MARKET_SLIPPAGE),
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
  const exchange = getExchange();
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
        exchange.custom.marketClose(
          `${coin}-PERP`,
          undefined, // size: закрыть полностью
          undefined, // px: SDK берёт midPrice
          MARKET_SLIPPAGE,
        ),
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
        if (Number.isFinite(position.entry_equity) && position.entry_equity > 0) {
          estimatedPnl = equity - position.entry_equity;
        }
      } catch { /* PnL неизвестен */ }

      try {
        dbClosePosition(position.id, {
          close_price:  0,
          realized_pnl: estimatedPnl,
          fee_paid:     0,
          reason:       'external_close_detected_on_exit',
        });
        logger.info(
          `[Executor] ✅ DB synced: #${coin} (id=${position.id}) → CLOSED | ` +
            `reason: external_close_detected_on_exit | est. PnL: $${estimatedPnl.toFixed(4)}`,
        );
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
  }

  dbClosePosition(position.id, {
    close_price:  fill.avgPx,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
    exitFeatures,
  });

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
    await notifyProductionClose({
      coin, holdHours, entryPrice: position.entry_price,
      avgPx: fill.avgPx, slip, pricePnl, fundingPnl,
      totalFee, realizedPnl, reason: signal.reason,
      oid: fill.oid, side: posSide,
    });
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

// ─────────────────────────────────────────────────
//  ROTATE
// ─────────────────────────────────────────────────

/**
 * Боевая ротация: закрываем старую позицию → открываем новую.
 *
 * Между close и open биржа освобождает маржу — getBalance() в productionOpen
 * подхватит свежий withdrawable.
 *
 * @param {{ closeCoin, closePrice, openCoin, openPrice, openApy, paybackHours, reason }} signal
 * @param {Object} position — текущая позиция из БД
 * @returns {Promise<{ ok: boolean, closePnl?: number, positionId?: number }>}
 */
export async function productionRotate(signal, position) {
  logger.info(
    `[Executor] PROD ROTATE — ${signal.closeCoin} → ${signal.openCoin} | ` +
      `payback: ${signal.paybackHours}h | reason: ${signal.reason}`,
  );

  // ── Шаг 1: закрываем старую (silent) ─────────
  const closeResult = await productionClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
    true, // silent
  );

  if (!closeResult.ok) {
    logger.error(
      `[Executor] PROD ROTATE — close leg failed, aborting rotation`,
    );
    await notifyRotateFailed({
      closeCoin: signal.closeCoin, openCoin: signal.openCoin,
      closePnl: 0, phase: 'close',
    });
    return { ok: false };
  }

  // ── Гард: close мог триггернуть circuit breaker ──
  const cb = getCircuitBreakerStatus();
  if (cb.broken) {
    logger.warn(
      `[Executor] PROD ROTATE aborted: circuit breaker tripped during close. Bot stays IDLE.`,
    );
    return { ok: true, closePnl: closeResult.pnl };
  }

  // ── Шаг 2: открываем новую (silent) ──────────
  const openResult = await productionOpen(
    signal.openCoin,
    signal.openPrice,
    signal.openApy,
    true, // silent
    signal.strategy_id || 'carry',
    signal.openSide || position.side || 'short',
  );

  if (!openResult.ok) {
    logger.error(
      `[Executor] 🚨 PROD ROTATE — close OK but open FAILED! Bot is NAKED (no position).`,
    );

    // Особый случай: новая нога упала по OI cap. Старая позиция уже закрыта,
    // вернуть её не можем. Шлём отдельное уведомление, бан уже выставлен в productionOpen.
    if (openResult.reason === 'OI_CAP') {
      await notifyOiCapAfterRotate({
        closeCoin: signal.closeCoin, openCoin: signal.openCoin,
        closePnl: closeResult.pnl, banMinutes: OI_CAP_BAN_TTL_MS / 60_000,
      });
    } else {
      await notifyRotateFailed({
        closeCoin: signal.closeCoin, openCoin: signal.openCoin,
        closePnl: closeResult.pnl, phase: 'open',
      });
    }
    return { ok: false, closePnl: closeResult.pnl };
  }

  // ── Шаг 3: ОДНО консолидированное уведомление ─
  await notifyRotate({
    closeCoin: signal.closeCoin, openCoin: signal.openCoin,
    holdHours: closeResult.holdHours, closePnl: closeResult.pnl,
    openSizeUsd: openResult.sizeUsd, openApy: signal.openApy,
    paybackHours: signal.paybackHours, isProd: true,
  });

  notify('afterRotate', {
    closeCoin: signal.closeCoin, openCoin: signal.openCoin,
    closePnl: closeResult.pnl, positionId: openResult.positionId,
  });

  return {
    ok: true,
    closePnl: closeResult.pnl,
    positionId: openResult.positionId,
  };
}
