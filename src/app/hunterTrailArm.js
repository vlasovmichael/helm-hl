// ─────────────────────────────────────────────────
//  Hunter Trail ARM — tick-time side-effect (Iter D2)
// ─────────────────────────────────────────────────
// Когда checkHunterExit обнаружил, что peak пересёк ARM_PCT впервые на
// PROD hunter позиции, он выставляет ARM request в hunterArmRequestMap.
// Этот модуль consume'ит флаг и выполняет cancel exchange TP-trigger,
// после чего бот сам управляет выходом (trailing CLOSE через market).
//
// Вызывается из tick.js после coordinate() для всех hunter PROD позиций.
// SL-trigger остаётся на бирже как floor downside-защиты.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getPositionsCached, cancelOrderFor, getOpenOrders } from '../modules/exchange.js';
import { getActivePosition, updateHunterTriggerOids } from '../core/database.js';
import { placeHunterTrigger } from '../modules/executor/hunterOpen.js';
import { resolveAsset } from '../modules/executor/fill-parser.js';
import {
  consumeHunterArmRequest,
  setHunterArmed,
  isHunterArmed,
  requestHunterArm,
  clearHunterArmed,
} from '../modules/strategistHunter.js';

export async function processHunterTrailArm(position) {
  if (!config.isProduction) return;
  if (!position) return;
  if (position.strategy_id !== 'hunter') return;
  if (position.mode !== 'PRODUCTION') return;
  if (!position.hunter_tp_oid) return;
  if (isHunterArmed(position.id)) return;

  if (!consumeHunterArmRequest(position.id)) return;

  try {
    await cancelOrderFor(position.coin, position.hunter_tp_oid);
    setHunterArmed(position.id);
    logger.info(
      `[HunterTrail] 🔫 ARMED #${position.coin} (id=${position.id}): cancelled exchange TP oid=${position.hunter_tp_oid}. ` +
        `Bot now drives close via trailing.`,
    );
  } catch (err) {
    // Возвращаем request, чтобы следующий тик попытался снова.
    requestHunterArm(position.id);
    logger.warn(
      `[HunterTrail] ARM failed for #${position.coin} oid=${position.hunter_tp_oid}: ${err.message}. Retry on next tick.`,
    );
  }
}

// ─────────────────────────────────────────────────
//  Restart recovery — restore exchange TP if armed at shutdown
// ─────────────────────────────────────────────────
// При перезапуске in-memory state (peak, armed-flag) теряется. Эвристика:
// если активная hunter PROD позиция жива на бирже, SL-trigger висит, а
// TP-trigger отсутствует — значит мы сами его отменили при ARM перед
// shutdown. Безопаснее всего: вернуть TP-trigger по оригинальной tp_price
// и не возобновлять trailing (peak потерян). Бот продолжит как обычный Hunter.

function isSameCoin(apiCoin, targetCoin) {
  if (!apiCoin || !targetCoin) return false;
  const a = apiCoin.toLowerCase();
  const t = targetCoin.toLowerCase();
  return a === t || a === `${t}-perp` || a === `@${t}` || a.replace('-perp', '') === t;
}

export async function restoreHunterTrailIfNeeded() {
  if (!config.isProduction) return;
  const dbPos = getActivePosition();
  if (!dbPos) return;
  if (dbPos.strategy_id !== 'hunter' || dbPos.mode !== 'PRODUCTION') return;
  if (!dbPos.hunter_tp_oid || !dbPos.hunter_sl_oid) return;

  let openOrders, positions;
  try {
    [openOrders, positions] = await Promise.all([
      getOpenOrders(),
      getPositionsCached(),
    ]);
  } catch (err) {
    logger.warn(`[HunterTrail] restore: fetch failed (${err.message}). Skipping.`);
    return;
  }

  const oidSet = new Set((openOrders || []).map(o => o.oid));
  const slOpen = oidSet.has(dbPos.hunter_sl_oid);
  const tpOpen = oidSet.has(dbPos.hunter_tp_oid);
  const positionAlive = (positions || []).some(ap => {
    const p = ap?.position ?? ap;
    const szi = parseFloat(p?.szi ?? '0');
    return isSameCoin(p?.coin, dbPos.coin) && szi !== 0;
  });

  if (!(positionAlive && slOpen && !tpOpen)) return;

  // Это сигнатура "armed-at-shutdown". Восстанавливаем TP.
  const sz = dbPos.size_usd / dbPos.entry_price;
  let szDecimals;
  try {
    ({ szDecimals } = resolveAsset(dbPos.coin));
  } catch (err) {
    logger.error(`[HunterTrail] restore: resolveAsset(#${dbPos.coin}) failed: ${err.message}`);
    return;
  }

  try {
    const newTpOid = await placeHunterTrigger(dbPos.coin, sz, dbPos.tp_price, 'tp', szDecimals);
    updateHunterTriggerOids(dbPos.id, { hunter_sl_oid: dbPos.hunter_sl_oid, hunter_tp_oid: newTpOid });
    clearHunterArmed(dbPos.id);
    logger.info(
      `[HunterTrail] 🔄 RESTORED #${dbPos.coin} TP-trigger @ $${dbPos.tp_price} oid=${newTpOid} ` +
        `(was armed at shutdown). Resuming as standard Hunter.`,
    );
  } catch (err) {
    logger.error(
      `[HunterTrail] ❌ restore TP-trigger failed for #${dbPos.coin}: ${err.message}. ` +
        `Position has only SL protection until next ARM or manual fix.`,
    );
  }
}
