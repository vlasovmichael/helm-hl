// ─────────────────────────────────────────────────
//  Production Mode — реальные позиции на Hyperliquid
// ─────────────────────────────────────────────────

import { logger } from '../../core/logger.js';
import { retryWithBackoff } from '../../core/retry.js';
import {
  savePosition,
  closePosition as dbClosePosition,
} from '../../core/database.js';
import {
  getExchange,
  getBalance,
  getAccountSummary,
  getPositions,
  setLeverage,
} from '../exchange.js';
import { resolveAsset, parseFillResponse } from './fill-parser.js';
import { calcSize, calcPnl, checkSlippage, MARKET_SLIPPAGE, MIN_ORDER_USD, FEE_RATE } from './math.js';
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
import {
  notifyProductionOpen, notifyOpenFailed, notifyOpenRejected,
  notifyOpenSkipped, notifySlippageBan,
  notifyProductionClose, notifyCloseRejected, notifyCloseFailed,
  notifyExternalClose,
  notifyRotate, notifyRotateFailed,
  notifyCircuitBreaker,
  notifyOiCapBan, notifyOiCapAfterRotate,
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
export async function productionOpen(coin, price, apy, silent = false) {
  const exchange = getExchange();

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
    `[Executor] PROD OPEN #${coin} — placing market SELL | ` +
      `sz: ${sz} (~$${(sz * price).toFixed(2)}) | markPrice: $${price} | slippage: ${MARKET_SLIPPAGE * 100}%`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () =>
        exchange.custom.marketOpen(
          `${coin}-PERP`,
          false, // is_buy=false → SELL (short)
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
  const slip = checkSlippage(price, fill.avgPx, "SELL");

  if (slip.ban) {
    banSlippage(coin);
    logger.error(
      `[Executor] 🚫 SLIPPAGE BAN #${coin} SELL: ${slip.label} (>${1.5}%) — ` +
        `trading paused for ${SLIPPAGE_BAN_TTL_MS / 60_000}min`,
    );
    await notifySlippageBan({
      coin, slipLabel: slip.label,
      banMinutes: SLIPPAGE_BAN_TTL_MS / 60_000,
    });
  } else if (slip.warn) {
    logger.warn(
      `[Executor] ⚠️ SLIPPAGE #${coin} SELL: expected $${price} → fill $${fill.avgPx} (${slip.label})`,
    );
  } else {
    logger.debug(`[Executor] Slippage #${coin} SELL: ${slip.label}`);
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

  const id = savePosition({
    coin,
    size_usd: fillUsd,
    entry_price: fill.avgPx,
    entry_apy: apy,
    entry_time: Date.now(),
    mode: "PRODUCTION",
  });

  logger.info(
    `[Executor] ✅ PROD OPEN #${coin} | Leverage: ${effectiveLeverage} | oid: ${fill.oid} | ` +
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
      oid: fill.oid, dbId: id,
    });
  }

  notify('afterOpen', {
    coin, price, apy, sizeUsd: fillUsd,
    positionId: Number(id), fill, mode: 'PRODUCTION',
  });

  return { ok: true, positionId: Number(id), sizeUsd: fillUsd };
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

  const holdMs = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;

  logger.info(
    `[Executor] PROD CLOSE #${coin} — reason: ${signal.reason} | ` +
      `held: ${holdHours.toFixed(1)}h | markPrice: $${signal.price}`,
  );

  // ── 0. Снимаем реальный накопленный фандинг ДО закрытия ─
  // После marketClose позиция исчезнет из clearinghouseState и cumFunding пропадёт.
  // Hyperliquid: для shorts sinceOpen отрицателен, когда мы получали фандинг (профит).
  // Знак инвертируется → realFundingUsd = -sinceOpen.
  // Подтверждено эмпирически на PURR: sinceOpen=-0.009869 → +$0.009869 профита.
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
        estimatedPnl = equity - position.size_usd;
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
  const slip = checkSlippage(signal.price, fill.avgPx, "BUY");

  if (slip.ban) {
    banSlippage(coin);
    logger.error(
      `[Executor] 🚫 SLIPPAGE BAN #${coin} BUY: ${slip.label} (>${1.5}%) — ` +
        `trading paused for ${SLIPPAGE_BAN_TTL_MS / 60_000}min`,
    );
    await notifySlippageBan({
      coin, slipLabel: slip.label,
      banMinutes: SLIPPAGE_BAN_TTL_MS / 60_000,
    });
  } else if (slip.warn) {
    logger.warn(
      `[Executor] ⚠️ SLIPPAGE #${coin} BUY: expected $${signal.price} → fill $${fill.avgPx} (${slip.label})`,
    );
  } else {
    logger.debug(`[Executor] Slippage #${coin} BUY: ${slip.label}`);
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
  dbClosePosition(position.id, {
    close_price:  fill.avgPx,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
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
      oid: fill.oid,
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
