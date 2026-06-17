// ─────────────────────────────────────────────────
//  Hunter Reconcile — детектор срабатывания trigger-ордеров (Iter C)
// ─────────────────────────────────────────────────
// На каждом тике для активной hunter PROD-позиции:
//   1. Читает open orders + getPositions().
//   2. Если позиция исчезла + один из триггеров пропал из open orders →
//      этот триггер сработал. Cancel'им второй, закрываем в БД с
//      reason 'hunter_sl_external'/'hunter_tp_external'.
//   3. Иные расхождения логируем, deferим к existing integrityCheck.
//
// Запускается ПЕРЕД integrityCheck в tick.js — успевает закрыть штатно
// до того как integrity подхватит "external_close" с потерей деталей.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  getActivePosition,
  closePosition as dbClosePosition,
} from '../core/database.js';
import { getPositionsCached, cancelOrderFor, getOpenOrders } from '../modules/exchange.js';
import { ONE_LEG } from '../modules/executor/math.js';
import { setCooldown } from '../modules/executor/state.js';
import { recordHunterSlExternal, consumeHunterMfeMae, isHunterArmed } from '../modules/strategistHunter.js';
import {
  notifyHunterSL,
  notifyHunterTP,
} from '../modules/executor/notifications.js';

function isSameCoin(apiCoin, targetCoin) {
  if (!apiCoin || !targetCoin) return false;
  const a = apiCoin.toLowerCase();
  const t = targetCoin.toLowerCase();
  return a === t || a === `${t}-perp` || a === `@${t}` || a.replace('-perp', '') === t;
}

async function fetchOpenOrders() {
  return getOpenOrders();
}

async function cancelTriggerSafe(coin, oid) {
  if (!oid) return;
  try {
    await cancelOrderFor(coin, oid);
    logger.info(`[HunterRecon] cancelled stale trigger oid=${oid} on #${coin}`);
  } catch (err) {
    logger.warn(`[HunterRecon] cancel oid=${oid} failed (likely already gone): ${err.message}`);
  }
}

/**
 * Закрывает hunter-позицию в БД после срабатывания триггера на бирже.
 * Cancel'ит "другой" триггер, шлёт уведомление, ставит post-SL cooldown.
 *
 * @param {Object} dbPos — строка позиции из БД
 * @param {'sl'|'tp'} which — какой триггер сработал
 */
async function finalizeHunterTrigger(dbPos, which) {
  const isSl = which === 'sl';
  const closePrice = isSl ? dbPos.sl_price : dbPos.tp_price;
  const sz = dbPos.size_usd / dbPos.entry_price;

  // Trigger-market fill = taker. Открытие тоже было taker (market).
  const totalFee = dbPos.size_usd * ONE_LEG + sz * closePrice * ONE_LEG;
  // Hunter SHORT: pricePnl = sz × (entry − close).
  const pricePnl = sz * (dbPos.entry_price - closePrice);
  const realizedPnl = pricePnl - totalFee;
  const reason = isSl ? 'hunter_sl_external' : 'hunter_tp_external';

  // Cancel "другой" триггер — он мог остаться висящим
  const otherOid = isSl ? dbPos.hunter_tp_oid : dbPos.hunter_sl_oid;
  await cancelTriggerSafe(dbPos.coin, otherOid);

  const holdMs = Date.now() - dbPos.entry_time;
  const mm = consumeHunterMfeMae(dbPos.id);
  const exitFeatures = {
    mfe_usd:      mm?.mfeUsd ?? null,
    mae_usd:      mm?.maeUsd ?? null,
    mfe_pct:      mm?.mfePct ?? null,
    mae_pct:      mm?.maePct ?? null,
    hold_seconds: Math.round(holdMs / 1000),
  };

  try {
    dbClosePosition(dbPos.id, {
      close_price:  closePrice,
      realized_pnl: realizedPnl,
      fee_paid:     totalFee,
      reason,
      exitFeatures,
    });
  } catch (err) {
    logger.error(`[HunterRecon] dbClosePosition #${dbPos.coin} failed: ${err.message}`);
    return false;
  }

  const holdMinutes = Math.round((Date.now() - dbPos.entry_time) / 60_000);
  logger.info(
    `[HunterRecon] ✅ #${dbPos.coin} ${which.toUpperCase()} EXTERNAL FILL detected | ` +
      `entry $${dbPos.entry_price} → ${which} $${closePrice} | ` +
      `pricePnl $${pricePnl.toFixed(4)} | fees $${totalFee.toFixed(4)} | ` +
      `realized $${realizedPnl.toFixed(4)} | held ${holdMinutes}m`,
  );

  setCooldown(dbPos.coin);

  if (isSl) {
    recordHunterSlExternal(dbPos.coin);
    await notifyHunterSL({
      coin:       dbPos.coin,
      entryPrice: dbPos.entry_price,
      slPrice:    closePrice,
      pnl:        realizedPnl,
      fee:        totalFee,
      holdMinutes,
    });
  } else {
    await notifyHunterTP({
      coin:       dbPos.coin,
      entryPrice: dbPos.entry_price,
      tpPrice:    closePrice,
      pnl:        realizedPnl,
      fee:        totalFee,
      holdMinutes,
    });
  }

  return true;
}

/**
 * @returns {Promise<boolean>} true если что-то закрыли (tick должен пропустить
 *   дальнейшую логику, аналогично integrityCheck'у).
 */
export async function hunterReconcile() {
  if (!config.isProduction) return false;

  const dbPos = getActivePosition();
  if (!dbPos) return false;
  if (dbPos.strategy_id !== 'hunter' || dbPos.mode !== 'PRODUCTION') return false;
  // Iter C открытие записывает оба oid'а. Если их нет — позиция от старого пути / paper-режима.
  if (!dbPos.hunter_sl_oid && !dbPos.hunter_tp_oid) return false;

  let openOrders, positions;
  try {
    [openOrders, positions] = await Promise.all([
      fetchOpenOrders(),
      getPositionsCached(),
    ]);
  } catch (err) {
    logger.debug(`[HunterRecon] fetch failed: ${err.message}`);
    return false;
  }

  const oidSet = new Set((openOrders || []).map(o => o.oid));
  const slOpen = dbPos.hunter_sl_oid ? oidSet.has(dbPos.hunter_sl_oid) : false;
  const tpOpen = dbPos.hunter_tp_oid ? oidSet.has(dbPos.hunter_tp_oid) : false;

  const positionAlive = (positions || []).some(ap => {
    const p = ap?.position ?? ap;
    const apiCoin = p?.coin ?? '';
    const szi = parseFloat(p?.szi ?? '0');
    return isSameCoin(apiCoin, dbPos.coin) && szi !== 0;
  });

  // Healthy: позиция жива, оба триггера висят
  if (positionAlive && slOpen && tpOpen) return false;

  // Iter D: если бот сам отменил TP-trigger при ARM (trail-режим), позиция жива
  // + SL висит + TP пропал — это ОЖИДАЕМОЕ состояние. Не варн, не fire.
  const armed = isHunterArmed(dbPos.id);
  if (positionAlive && slOpen && !tpOpen && armed) {
    return false;
  }

  // Position alive но триггер пропал — аномалия (оператор отменил вручную? или race?)
  if (positionAlive && (!slOpen || !tpOpen)) {
    logger.warn(
      `[HunterRecon] #${dbPos.coin} position ALIVE but trigger missing ` +
        `(slOpen=${slOpen}, tpOpen=${tpOpen}, armed=${armed}). Не трогаем — пусть analyzeHunter/integrity разберутся.`,
    );
    return false;
  }

  // Position gone, SL fired (TP всё ещё висит — успели) → SL hit
  if (!positionAlive && !slOpen && tpOpen) {
    return await finalizeHunterTrigger(dbPos, 'sl');
  }
  // Position gone, TP fired
  if (!positionAlive && slOpen && !tpOpen) {
    return await finalizeHunterTrigger(dbPos, 'tp');
  }

  // Position gone, оба триггера пропали — амбигуэно (race: TP fill закрыл позу,
  // SL biржей auto-cancelled т.к. reduce_only невозможен на пустой позиции; или наоборот).
  // Эвристика: если последняя цена ближе к TP → TP сработал, иначе SL.
  if (!positionAlive && !slOpen && !tpOpen) {
    logger.warn(
      `[HunterRecon] #${dbPos.coin} position GONE + both triggers gone. ` +
        `Defer to integrityCheck (external_close).`,
    );
    return false;
  }

  return false;
}
