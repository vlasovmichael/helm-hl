// ─────────────────────────────────────────────────
//  Sniper Mode — maker-only exits на soft-причинах
// ─────────────────────────────────────────────────
// PAPER: симулируем maker-fill через scout цены. Окно SNIPER_WINDOW_MS,
// если scout-цена опустилась до armPrice → fill по armPrice + MAKER_FEE_RATE.
//
// PROD (Iter 3): реальный post-only Alo-ордер на бирже:
//   • Берём bestBid из L2 → ставим reduce_only buy limit на bestBid (post-only).
//   • Каждый тик: getPositions() → если позиция исчезла → ордер залился, фиксируем DB.
//   • Окно истекло → cancelOrder + market fallback (productionClose).
//   • Emergency reason при армированном слоте → cancel + market (handled in handleClose).

import { logger } from '../../core/logger.js';
import { getActivePosition, closePosition as dbClosePosition } from '../../core/database.js';
import { paperClose } from './paper.js';
import { productionClose } from './production.js';
import {
  getExchange, getPositions, getMarkPrice,
} from '../exchange.js';
import { retryWithBackoff } from '../../core/retry.js';
import {
  armSniper, getSniper, updateSniper, clearSniper, setCooldown,
  REENTRY_COOLDOWN_MS,
} from './state.js';
import {
  SNIPER_WINDOW_MS, MAKER_FEE_RATE, ONE_LEG, FEE_RATE,
  SNIPER_ADVERSE_DRIFT_BPS,
  roundDown,
} from './math.js';
import { resolveAsset, parseFillResponse } from './fill-parser.js';
import { calcPnl, MARKET_SLIPPAGE } from './math.js';
import {
  notifySniperFilled, notifySniperTimeout,
  notifySniperArmedProd, notifySniperFilledProd, notifySniperTimeoutProd,
  notifySniperArmFailed, notifySniperAdverseAbort,
} from './notifications.js';

/**
 * Чистая проверка adverse drift для шорта: для buy-to-close рост цены = убыток.
 * @returns {{ adverse: boolean, driftBps: number }}
 */
export function checkAdverseDrift(currentPrice, armPrice) {
  if (!(currentPrice > 0) || !(armPrice > 0)) return { adverse: false, driftBps: 0 };
  const driftBps = ((currentPrice - armPrice) / armPrice) * 10_000;
  return { adverse: driftBps > SNIPER_ADVERSE_DRIFT_BPS, driftBps };
}

// ─────────────────────────────────────────────────
//  PAPER — pure decision + side-effect wrapper
// ─────────────────────────────────────────────────

/**
 * Чистая функция решения для PAPER-снайпера.
 * @returns {{kind:'idle'|'no-position'|'timeout'|'fill'|'wait', price?:number, elapsed?:number}}
 */
export function decideSniperAction(slot, position, scoutData, now) {
  if (!slot) return { kind: 'idle' };
  if (!position || position.coin !== slot.coin) return { kind: 'no-position' };

  const elapsed = now - slot.armedAt;
  const scoutItem = scoutData?.find((x) => x.coin === slot.coin) ?? null;

  if (elapsed >= SNIPER_WINDOW_MS) {
    const price = scoutItem?.price ?? slot.armPrice;
    return { kind: 'timeout', price, elapsed };
  }

  if (!scoutItem) return { kind: 'wait', elapsed };

  if (scoutItem.price <= slot.armPrice) {
    return { kind: 'fill', price: slot.armPrice, elapsed };
  }

  const drift = checkAdverseDrift(scoutItem.price, slot.armPrice);
  if (drift.adverse) {
    return { kind: 'adverse-abort', price: scoutItem.price, driftBps: drift.driftBps, elapsed };
  }

  return { kind: 'wait', elapsed };
}

async function tickPaperSniper(scoutData) {
  const slot = getSniper();
  const position = slot ? getActivePosition() : null;
  const action = decideSniperAction(slot, position, scoutData, Date.now());

  switch (action.kind) {
    case 'idle': return null;

    case 'no-position':
      logger.warn(`[Sniper PAPER] Position #${slot.coin} gone (external close?) — clearing armed slot`);
      clearSniper();
      return action;

    case 'timeout': {
      logger.warn(
        `[Sniper PAPER] ⏰ TIMEOUT #${slot.coin} after ${Math.round(action.elapsed / 60_000)}min — ` +
          `fallback market close @ $${action.price}`,
      );
      clearSniper();
      const result = await paperClose(
        { price: action.price, reason: `${slot.reason}_sniper_timeout` },
        position, true,
      );
      if (result.ok) {
        await notifySniperTimeout({
          coin: slot.coin, armPrice: slot.armPrice, fallbackPrice: action.price,
          reason: slot.reason, pnl: result.pnl, fee: result.fee,
        });
      }
      return action;
    }

    case 'fill': {
      logger.info(
        `[Sniper PAPER] ✅ FILL #${slot.coin} @ $${slot.armPrice} ` +
          `(waited ${Math.round(action.elapsed / 60_000)}min, reason: ${slot.reason})`,
      );
      clearSniper();
      const result = await paperClose(
        { price: slot.armPrice, reason: slot.reason },
        position, true,
        { closePrice: slot.armPrice, exitFeeRate: MAKER_FEE_RATE },
      );
      if (result.ok) {
        const feeSavedVsMarket = position.size_usd * (ONE_LEG - MAKER_FEE_RATE);
        await notifySniperFilled({
          coin: slot.coin, armPrice: slot.armPrice,
          waitMinutes: Math.round(action.elapsed / 60_000),
          reason: slot.reason, pnl: result.pnl, fee: result.fee,
          feeSavedVsMarket,
        });
      }
      return action;
    }

    case 'adverse-abort': {
      logger.warn(
        `[Sniper PAPER] 📉 ADVERSE DRIFT abort #${slot.coin}: ` +
          `arm $${slot.armPrice} → mark $${action.price} (+${action.driftBps.toFixed(1)}bps > ${SNIPER_ADVERSE_DRIFT_BPS}bps) — market exit`,
      );
      clearSniper();
      const result = await paperClose(
        { price: action.price, reason: `${slot.reason}_sniper_adverse` },
        position, true,
      );
      if (result.ok) {
        await notifySniperAdverseAbort({
          coin: slot.coin, armPrice: slot.armPrice, currentPrice: action.price,
          driftBps: action.driftBps, reason: slot.reason,
          waitMinutes: Math.round(action.elapsed / 60_000),
          pnl: result.pnl, isProd: false,
        });
      }
      return action;
    }

    case 'wait': return action;

    default:
      logger.error(`[Sniper PAPER] unknown action kind: ${action.kind}`);
      return null;
  }
}

// ─────────────────────────────────────────────────
//  PROD — реальный Alo placeOrder + polling
// ─────────────────────────────────────────────────

/**
 * Армит реальный post-only Alo reduce_only buy limit на bestBid.
 * Если что-то пошло не так на любом этапе — fallback в productionClose (market).
 *
 * @param {{price:number, reason:string}} signal
 * @param {Object} position — строка из БД
 */
export async function productionArmSniper(signal, position) {
  const exchange = getExchange();
  const coin = position.coin;

  // ── 1. Verify position alive on exchange ──
  let exPositions;
  try {
    exPositions = await getPositions();
  } catch (err) {
    logger.error(
      `[Sniper PROD] getPositions failed for #${coin}: ${err.message} — fallback to market`,
    );
    await notifySniperArmFailed({ coin, reason: `getPositions: ${err.message}` });
    return productionClose(signal, position);
  }

  const ourPos = exPositions.find((ap) => (ap?.position?.coin) === coin);
  if (!ourPos) {
    logger.warn(
      `[Sniper PROD] #${coin} position not on exchange — skipping arm, going through market path для DB-sync`,
    );
    return productionClose(signal, position);
  }

  // ── 2. Get bestBid from L2 book ──
  let bestBid;
  try {
    const book = await retryWithBackoff(
      () => exchange.info.getL2Book(`${coin}-PERP`),
      { label: `sniper-l2-${coin}`, maxRetries: 2, baseDelayMs: 800 },
    );
    const bids = book?.levels?.[0];
    if (!Array.isArray(bids) || bids.length === 0) throw new Error('empty bids');
    bestBid = parseFloat(bids[0].px);
    if (!Number.isFinite(bestBid) || bestBid <= 0) {
      throw new Error(`bad bestBid: ${bids[0].px}`);
    }
  } catch (err) {
    logger.error(
      `[Sniper PROD] getL2Book failed for #${coin}: ${err.message} — fallback to market`,
    );
    await notifySniperArmFailed({ coin, reason: `L2 book: ${err.message}` });
    return productionClose(signal, position);
  }

  // ── 3. Compute sz from real position szi ──
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(coin));
  } catch (err) {
    logger.error(
      `[Sniper PROD] resolveAsset failed for #${coin}: ${err.message} — fallback to market`,
    );
    await notifySniperArmFailed({ coin, reason: `resolveAsset: ${err.message}` });
    return productionClose(signal, position);
  }

  const szi = parseFloat(ourPos.position.szi);
  const sz = roundDown(Math.abs(szi), szDecimals);
  if (!(sz > 0)) {
    logger.error(
      `[Sniper PROD] computed sz=${sz} (szi=${szi}, szDecimals=${szDecimals}) — fallback to market`,
    );
    await notifySniperArmFailed({ coin, reason: `bad sz: ${sz}` });
    return productionClose(signal, position);
  }

  // ── 4. Place Alo reduce_only buy ──
  logger.info(
    `[Sniper PROD] Placing Alo BUY reduce_only #${coin} sz=${sz} @ $${bestBid} (bestBid)`,
  );

  let result;
  try {
    result = await retryWithBackoff(
      () =>
        exchange.exchange.placeOrder({
          coin: `${coin}-PERP`,
          is_buy: true,
          sz,
          limit_px: bestBid,
          order_type: { limit: { tif: 'Alo' } },
          reduce_only: true,
        }),
      { label: `sniper-arm-${coin}`, maxRetries: 2, baseDelayMs: 1000 },
    );
  } catch (err) {
    logger.error(
      `[Sniper PROD] placeOrder failed for #${coin}: ${err.message} — fallback to market`,
    );
    await notifySniperArmFailed({ coin, reason: `placeOrder: ${err.message}` });
    return productionClose(signal, position);
  }

  const statuses = result?.response?.data?.statuses;
  const status = statuses?.[0];

  if (!status) {
    logger.error(
      `[Sniper PROD] empty statuses for #${coin}: ${JSON.stringify(result).slice(0, 200)} — fallback to market`,
    );
    await notifySniperArmFailed({ coin, reason: 'empty statuses' });
    return productionClose(signal, position);
  }

  if (typeof status === 'string' || status.error) {
    const errMsg = typeof status === 'string' ? status : status.error;
    logger.error(`[Sniper PROD] order rejected for #${coin}: ${errMsg} — fallback to market`);
    await notifySniperArmFailed({ coin, reason: errMsg });
    return productionClose(signal, position);
  }

  if (status.filled) {
    // Race: maker fill случился сразу (bestBid сместился между read и post).
    const avgPx = parseFloat(status.filled.avgPx);
    logger.info(
      `[Sniper PROD] ⚡ Immediate maker fill #${coin} @ $${avgPx} (oid=${status.filled.oid})`,
    );
    await finalizeProdSniperFill(position, slot_immediate(coin, signal.reason, avgPx, bestBid), 0);
    return { ok: true, pnl: 0 };
  }

  if (status.resting) {
    const orderId = status.resting.oid;
    armSniper({
      positionId: position.id,
      coin: position.coin,
      reason: signal.reason,
      armPrice: bestBid,
      side: 'BUY',
      mode: 'PROD',
      orderId,
      sz,
      armSzi: sz,                  // исходный размер для partial-fill detection
      partialFilledSz: 0,          // running total maker-залитой части
      lastCumFundingUsd: parseCumFunding(ourPos),
      signal,
    });
    const windowMinutes = Math.round(SNIPER_WINDOW_MS / 60_000);
    logger.info(
      `[Sniper PROD] 🎯 ARMED #${coin} @ $${bestBid} oid=${orderId} ` +
        `(window ${windowMinutes}min, reason: ${signal.reason})`,
    );
    await notifySniperArmedProd({
      coin, armPrice: bestBid, orderId, sz,
      reason: signal.reason, windowMinutes,
    });
    return { ok: true };
  }

  logger.error(
    `[Sniper PROD] unknown status shape for #${coin}: ${JSON.stringify(status).slice(0, 200)} — fallback to market`,
  );
  await notifySniperArmFailed({ coin, reason: `unknown status: ${JSON.stringify(status).slice(0,80)}` });
  return productionClose(signal, position);
}

// Лёгкая обёртка чтобы не создавать slot для immediate-fill пути.
function slot_immediate(coin, reason, fillPx, armPrice) {
  return { coin, reason, armPrice, mode: 'PROD', armedAt: Date.now(), _fillPx: fillPx };
}

function parseCumFunding(exPos) {
  const sinceOpen = parseFloat(exPos?.position?.cumFunding?.sinceOpen);
  return Number.isFinite(sinceOpen) ? -sinceOpen : null;
}

/**
 * Финализирует maker-fill: считает PnL по фактической цене, закрывает в БД,
 * шлёт PROD-уведомление, выставляет re-entry cooldown.
 */
async function finalizeProdSniperFill(position, slot, elapsedMs) {
  const fillPx = slot._fillPx ?? slot.armPrice;
  const holdHours = (Date.now() - position.entry_time) / 3_600_000;
  const realFundingUsd = slot.lastCumFundingUsd ?? null;

  const { pricePnl, fundingPnl, totalFee, realizedPnl, fundingSource } =
    calcPnl(position, fillPx, holdHours, realFundingUsd, MAKER_FEE_RATE);

  dbClosePosition(position.id, {
    close_price: fillPx,
    realized_pnl: realizedPnl,
    fee_paid: totalFee,
    reason: slot.reason,
  });

  setCooldown(position.coin);

  // Saved vs market: market exit стоил бы position.size_usd * (FEE_RATE + SLIPPAGE).
  // Maker exit: position.size_usd * MAKER_FEE_RATE. Разница:
  const feeSavedVsMarket = position.size_usd * (ONE_LEG - MAKER_FEE_RATE);

  await notifySniperFilledProd({
    coin: position.coin,
    armPrice: slot.armPrice,
    fillPx,
    waitMinutes: Math.round(elapsedMs / 60_000),
    reason: slot.reason,
    holdHours,
    pricePnl, fundingPnl, fee: totalFee,
    pnl: realizedPnl,
    fundingSource,
    feeSavedVsMarket,
  });
}

/**
 * Финализирует partial-fill сценарий: часть закрылась maker'ом @ armPrice,
 * остаток нужно закрыть market'ом. Считает PnL/fee комбинированно и закрывает DB.
 *
 * Используется только в timeout/adverse-abort путях, когда `slot.partialFilledSz > 0`.
 * Caller обязан был сделать cancelOrder ДО вызова.
 *
 * @param {Object} position — DB row
 * @param {Object} slot — sniper slot с partialFilledSz, armSzi, armPrice, lastCumFundingUsd
 * @param {string} reason — причина закрытия (с суффиксом _sniper_timeout / _sniper_adverse)
 * @returns {Promise<{ ok: boolean, pnl?: number, holdHours?: number, marketAvgPx?: number }>}
 */
export async function finalizeProdSniperPartial(position, slot, reason) {
  const exchange = getExchange();
  const coin = position.coin;
  const holdHours = (Date.now() - position.entry_time) / 3_600_000;

  const makerSz  = slot.partialFilledSz;
  const remainSz = slot.armSzi - makerSz;

  // ── Market-close оставшейся доли ──
  let marketFill = null;
  if (remainSz > 0) {
    let result;
    try {
      result = await retryWithBackoff(
        () =>
          exchange.custom.marketClose(
            `${coin}-PERP`,
            undefined,           // size: закрыть полностью что осталось
            undefined,           // px: SDK берёт midPrice
            MARKET_SLIPPAGE,
          ),
        { label: `sniper-partial-close-${coin}`, maxRetries: 2, baseDelayMs: 1500 },
      );
    } catch (err) {
      logger.error(
        `[Sniper PROD partial] marketClose remainder failed for #${coin}: ${err.message} — позиция всё ещё открыта на остаток!`,
      );
      // Не закрываем DB — оставим reconciler / следующий тик попробует.
      return { ok: false };
    }
    marketFill = parseFillResponse(result, 'CLOSE');
    if (!marketFill.ok) {
      logger.error(
        `[Sniper PROD partial] marketClose remainder rejected for #${coin}: ${marketFill.error}`,
      );
      return { ok: false };
    }
  }

  // ── Комбинированный расчёт PnL ──
  const entryPx       = position.entry_price;
  const makerNotional = makerSz  * slot.armPrice;
  const marketNotional= marketFill ? marketFill.totalSz * marketFill.avgPx : 0;

  const pricePnlMaker  = makerSz  * (entryPx - slot.armPrice);
  const pricePnlMarket = marketFill ? marketFill.totalSz * (entryPx - marketFill.avgPx) : 0;
  const pricePnl       = pricePnlMaker + pricePnlMarket;

  // Funding — на всю позицию (cumFunding кэшировался в slot)
  let fundingPnl, fundingSource;
  if (slot.lastCumFundingUsd != null && Number.isFinite(slot.lastCumFundingUsd)) {
    fundingPnl = slot.lastCumFundingUsd;
    fundingSource = 'cumFunding';
  } else {
    const hourlyRate = position.entry_apy / 100 / 365 / 24;
    fundingPnl = position.size_usd * hourlyRate * holdHours;
    fundingSource = 'estimate';
  }

  // Fees: entry полностью taker (был при OPEN), exit разделён.
  const entryFee     = position.size_usd * FEE_RATE;
  const exitFeeMaker = makerNotional  * MAKER_FEE_RATE;
  const exitFeeMarket= marketNotional * FEE_RATE;
  const totalFee     = entryFee + exitFeeMaker + exitFeeMarket;

  const realizedPnl = pricePnl + fundingPnl - totalFee;

  // Average close price (для записи в БД) — взвешенная по notional.
  const totalNotional = makerNotional + marketNotional;
  const avgClosePx = totalNotional > 0
    ? totalNotional / (makerSz + (marketFill?.totalSz ?? 0))
    : (marketFill?.avgPx ?? slot.armPrice);

  dbClosePosition(position.id, {
    close_price: avgClosePx,
    realized_pnl: realizedPnl,
    fee_paid: totalFee,
    reason,
  });

  setCooldown(coin);

  // Saved vs market (только за maker-долю): makerNotional × (ONE_LEG − MAKER_FEE_RATE)
  const feeSavedVsMarket = makerNotional * (ONE_LEG - MAKER_FEE_RATE);

  logger.info(
    `[Sniper PROD partial] #${coin} closed | maker ${makerSz}@$${slot.armPrice} ($${makerNotional.toFixed(2)}) ` +
      `+ market ${marketFill?.totalSz ?? 0}@$${marketFill?.avgPx ?? '-'} ($${marketNotional.toFixed(2)}) | ` +
      `pricePnl ${pricePnl.toFixed(4)} | funding ${fundingPnl.toFixed(4)} (${fundingSource}) | ` +
      `fee ${totalFee.toFixed(4)} | total ${realizedPnl.toFixed(4)} | saved $${feeSavedVsMarket.toFixed(4)}`,
  );

  return {
    ok: true,
    pnl: realizedPnl,
    holdHours,
    marketAvgPx: marketFill?.avgPx,
    pricePnl, fundingPnl, totalFee, fundingSource, feeSavedVsMarket,
    makerSz, makerNotional, marketSz: marketFill?.totalSz ?? 0, marketNotional,
  };
}

async function tickProductionSniper(slot) {
  const exchange = getExchange();
  const coin = slot.coin;
  const elapsed = Date.now() - slot.armedAt;

  // ── Polling: жива ли позиция на бирже? ──
  let exPositions;
  try {
    exPositions = await getPositions();
  } catch (err) {
    logger.warn(`[Sniper PROD] poll getPositions failed: ${err.message} — retry next tick`);
    return { kind: 'wait', elapsed };
  }

  const ourPos = exPositions.find((ap) => (ap?.position?.coin) === coin);

  // ── Позиция исчезла → maker fill (или внешнее закрытие) ──
  if (!ourPos) {
    logger.info(
      `[Sniper PROD] ✅ FILL detected for #${coin} (position gone) @ $${slot.armPrice} ` +
        `after ${Math.round(elapsed / 60_000)}min`,
    );
    clearSniper();

    const position = getActivePosition();
    if (!position) {
      logger.warn(
        `[Sniper PROD] fill detected but no DB position for #${coin} — already reconciled?`,
      );
      return { kind: 'fill-no-db' };
    }

    await finalizeProdSniperFill(position, slot, elapsed);
    return { kind: 'fill', elapsed };
  }

  // ── Кэшируем cumFunding для точного PnL когда зальётся ──
  const cumF = parseCumFunding(ourPos);
  if (cumF != null) updateSniper({ lastCumFundingUsd: cumF });

  // ── Partial-fill detection: szi уменьшилось → часть залилась maker'ом ──
  const currentSzi = Math.abs(parseFloat(ourPos.position.szi));
  if (Number.isFinite(currentSzi) && currentSzi < slot.armSzi) {
    const newPartialSz = slot.armSzi - currentSzi;
    if (newPartialSz > (slot.partialFilledSz ?? 0)) {
      const delta = newPartialSz - (slot.partialFilledSz ?? 0);
      logger.info(
        `[Sniper PROD] 📊 PARTIAL fill #${coin}: +${delta} (cum ${newPartialSz}/${slot.armSzi} = ${(newPartialSz / slot.armSzi * 100).toFixed(1)}%) @ $${slot.armPrice}`,
      );
      updateSniper({ partialFilledSz: newPartialSz });
      slot.partialFilledSz = newPartialSz;  // local sync для остального кода тика
    }
  }

  // ── Adverse drift abort: для шорта рост цены = убыток ──
  let markPx = null;
  try {
    markPx = await getMarkPrice(coin);
  } catch { /* fallback ниже */ }

  if (markPx != null && markPx > 0) {
    const drift = checkAdverseDrift(markPx, slot.armPrice);
    if (drift.adverse) {
      logger.warn(
        `[Sniper PROD] 📉 ADVERSE DRIFT abort #${coin}: ` +
          `arm $${slot.armPrice} → mark $${markPx} (+${drift.driftBps.toFixed(1)}bps > ${SNIPER_ADVERSE_DRIFT_BPS}bps) — ` +
          `cancel oid=${slot.orderId} + market`,
      );

      try {
        await exchange.exchange.cancelOrder({ coin: `${coin}-PERP`, o: slot.orderId });
        logger.info(`[Sniper PROD] adverse-cancel OK for #${coin} oid=${slot.orderId}`);
      } catch (err) {
        logger.warn(
          `[Sniper PROD] adverse-cancel failed (oid=${slot.orderId}): ${err.message} — proceeding to market`,
        );
      }

      clearSniper();

      const position = getActivePosition();
      if (!position) {
        logger.warn(`[Sniper PROD] adverse-abort but no DB position for #${coin}`);
        return { kind: 'adverse-abort-no-db', driftBps: drift.driftBps };
      }

      const adverseReason = `${slot.reason}_sniper_adverse`;
      const result = (slot.partialFilledSz ?? 0) > 0
        ? await finalizeProdSniperPartial(position, slot, adverseReason)
        : await productionClose({ price: markPx, reason: adverseReason }, position, true);

      if (result.ok) {
        await notifySniperAdverseAbort({
          coin, armPrice: slot.armPrice, currentPrice: markPx,
          driftBps: drift.driftBps, reason: slot.reason,
          waitMinutes: Math.round(elapsed / 60_000),
          pnl: result.pnl, isProd: true,
        });
      }
      return { kind: 'adverse-abort', driftBps: drift.driftBps, elapsed };
    }
  }

  // ── Окно истекло → cancel + market fallback ──
  if (elapsed >= SNIPER_WINDOW_MS) {
    logger.warn(
      `[Sniper PROD] ⏰ TIMEOUT #${coin} after ${Math.round(elapsed / 60_000)}min — ` +
        `cancelling oid=${slot.orderId} + market fallback`,
    );

    // Cancel — игнорируем ошибки (ордер мог уже быть исполнен/отменён).
    try {
      await exchange.exchange.cancelOrder({
        coin: `${coin}-PERP`,
        o: slot.orderId,
      });
      logger.info(`[Sniper PROD] cancelOrder OK for #${coin} oid=${slot.orderId}`);
    } catch (err) {
      logger.warn(
        `[Sniper PROD] cancelOrder failed for #${coin} oid=${slot.orderId}: ${err.message} — proceeding to market`,
      );
    }

    clearSniper();

    // Свежая markPrice для market-сигнала
    let markPrice = slot.armPrice;
    try {
      const px = await getMarkPrice(coin);
      if (px > 0) markPrice = px;
    } catch { /* fallback на armPrice */ }

    const position = getActivePosition();
    if (!position) {
      logger.warn(`[Sniper PROD] timeout but no DB position for #${coin}`);
      return { kind: 'timeout-no-db' };
    }

    const timeoutReason = `${slot.reason}_sniper_timeout`;
    const result = (slot.partialFilledSz ?? 0) > 0
      ? await finalizeProdSniperPartial(position, slot, timeoutReason)
      : await productionClose({ price: markPrice, reason: timeoutReason }, position, true);

    if (result.ok) {
      await notifySniperTimeoutProd({
        coin,
        armPrice: slot.armPrice,
        fallbackPrice: result.marketAvgPx ?? markPrice,
        reason: slot.reason,
        pnl: result.pnl,
        holdHours: result.holdHours,
      });
    }
    return { kind: 'timeout', elapsed };
  }

  return { kind: 'wait', elapsed };
}

// ─────────────────────────────────────────────────
//  Public — вызывается из app/tick.js
// ─────────────────────────────────────────────────

/**
 * Главный poll-метод снайпера. Роутит PAPER/PROD по slot.mode.
 * @param {Array<{coin:string,price:number}>} scoutData
 */
export async function tickSniper(scoutData) {
  const slot = getSniper();
  if (!slot) return null;

  if (slot.mode === 'PROD') {
    return tickProductionSniper(slot);
  }
  return tickPaperSniper(scoutData);
}
