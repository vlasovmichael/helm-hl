// ─────────────────────────────────────────────────
//  Hunter LONG Reconcile (Iter E.3) — детектор срабатывания trigger-ордеров
// ─────────────────────────────────────────────────
// Зеркало hunterReconcile.js для hunter_long PROD-позиций.
// Запускается ПЕРЕД integrityCheck в tick.js.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  getActivePosition,
  closePosition as dbClosePosition,
} from '../core/database.js';
import { getPositionsCached, cancelOrderFor, getOpenOrders } from '../modules/exchange.js';
import { ONE_LEG } from '../modules/executor/math.js';
import { setCooldown } from '../modules/executor/state.js';
import { consumeHunterLongMfeMae } from '../modules/strategistHunterLong.js';
import {
  notifyHunterLongSL,
  notifyHunterLongTP,
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
    logger.info(`[HunterLongRecon] cancelled stale trigger oid=${oid} on #${coin}`);
  } catch (err) {
    logger.warn(`[HunterLongRecon] cancel oid=${oid} failed (likely already gone): ${err.message}`);
  }
}

/**
 * Закрывает hunter_long-позицию в БД после срабатывания триггера.
 * LONG → pricePnl = sz × (close − entry).
 */
async function finalizeHunterLongTrigger(dbPos, which) {
  const isSl = which === 'sl';
  const closePrice = isSl ? dbPos.sl_price : dbPos.tp_price;
  const sz = dbPos.size_usd / dbPos.entry_price;

  const totalFee = dbPos.size_usd * ONE_LEG + sz * closePrice * ONE_LEG;
  // LONG pricePnl: положительный когда close > entry
  const pricePnl = sz * (closePrice - dbPos.entry_price);
  const realizedPnl = pricePnl - totalFee;
  const reason = isSl ? 'hunter_long_sl_external' : 'hunter_long_tp_external';

  const otherOid = isSl ? dbPos.hunter_tp_oid : dbPos.hunter_sl_oid;
  await cancelTriggerSafe(dbPos.coin, otherOid);

  const holdMs = Date.now() - dbPos.entry_time;
  const mm = consumeHunterLongMfeMae(dbPos.id);
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
    logger.error(`[HunterLongRecon] dbClosePosition #${dbPos.coin} failed: ${err.message}`);
    return false;
  }

  const holdMinutes = Math.round(holdMs / 60_000);
  logger.info(
    `[HunterLongRecon] ✅ #${dbPos.coin} ${which.toUpperCase()} EXTERNAL FILL detected | ` +
      `entry $${dbPos.entry_price} → ${which} $${closePrice} | ` +
      `pricePnl $${pricePnl.toFixed(4)} | fees $${totalFee.toFixed(4)} | ` +
      `realized $${realizedPnl.toFixed(4)} | held ${holdMinutes}m`,
  );

  setCooldown(dbPos.coin);

  if (isSl) {
    await notifyHunterLongSL({
      coin:       dbPos.coin,
      entryPrice: dbPos.entry_price,
      slPrice:    closePrice,
      pnl:        realizedPnl,
      fee:        totalFee,
      holdMinutes,
    });
  } else {
    await notifyHunterLongTP({
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
 * @returns {Promise<boolean>} true если что-то закрыли — tick должен пропустить дальше.
 */
export async function hunterLongReconcile() {
  if (!config.isProduction) return false;

  const dbPos = getActivePosition();
  if (!dbPos) return false;
  if (dbPos.strategy_id !== 'hunter_long' || dbPos.mode !== 'PRODUCTION') return false;
  if (!dbPos.hunter_sl_oid && !dbPos.hunter_tp_oid) return false;

  let openOrders, positions;
  try {
    [openOrders, positions] = await Promise.all([
      fetchOpenOrders(),
      getPositionsCached(),
    ]);
  } catch (err) {
    logger.debug(`[HunterLongRecon] fetch failed: ${err.message}`);
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

  if (positionAlive && slOpen && tpOpen) return false;

  // E.3.b: при добавлении trail-arm-cancel вернуть здесь armed-check.

  if (positionAlive && (!slOpen || !tpOpen)) {
    logger.warn(
      `[HunterLongRecon] #${dbPos.coin} position ALIVE but trigger missing ` +
        `(slOpen=${slOpen}, tpOpen=${tpOpen}). Не трогаем — пусть analyzeHunterLong/integrity разберутся.`,
    );
    return false;
  }

  if (!positionAlive && !slOpen && tpOpen) {
    return await finalizeHunterLongTrigger(dbPos, 'sl');
  }
  if (!positionAlive && slOpen && !tpOpen) {
    return await finalizeHunterLongTrigger(dbPos, 'tp');
  }

  if (!positionAlive && !slOpen && !tpOpen) {
    logger.warn(
      `[HunterLongRecon] #${dbPos.coin} position GONE + both triggers gone. ` +
        `Defer to integrityCheck (external_close).`,
    );
    return false;
  }

  return false;
}
