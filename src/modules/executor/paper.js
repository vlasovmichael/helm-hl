// ─────────────────────────────────────────────────
//  Paper Mode — виртуальные позиции
// ─────────────────────────────────────────────────

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  savePosition,
  closePosition as dbClosePosition,
} from '../../core/database.js';
import { getAvailableBalance } from '../wallet.js';
import {
  calcSize, calcPaperClose, calcVolSizeMultiplier,
  ONE_LEG, MIN_ORDER_USD,
} from './math.js';
import {
  setCooldown, REENTRY_COOLDOWN_MS,
  recordLoss, CB_PAUSE_MS,
} from './state.js';
import { notify } from './hooks.js';
import {
  notifyPaperOpen, notifyPaperClose, notifyCircuitBreaker,
  notifyHunterOpen, notifyHunterSL, notifyHunterTP, notifyHunterTrailTp,
  notifyHunterLongOpen, notifyHunterLongSL, notifyHunterLongTP, notifyHunterLongTrailTp,
} from './notifications.js';
import { consumeHunterMfeMae, clearHunterTrailState, getHunterPeakPct } from '../strategistSniper.js';
import {
  consumeHunterLongMfeMae, clearHunterLongTrailState, getHunterLongPeakPct,
} from '../strategistHunterLong.js';
import { setHunterCrossCooldown } from '../hunterCrossCooldown.js';

/**
 * Определяет баланс для расчёта размера позиции.
 * PAPER + FAKE_BALANCE: виртуальный баланс (для тестов без реальных денег).
 * PAPER без FAKE_BALANCE: реальный withdrawable с биржи.
 */
async function getPaperBalance() {
  const fake = config.trading.fakeBalance;
  if (fake != null && fake > 0) {
    logger.info(`[Executor] Using FAKE_BALANCE: $${fake.toFixed(2)}`);
    return fake;
  }
  try {
    return await getAvailableBalance();
  } catch (err) {
    logger.error(`[Executor] PAPER getPaperBalance failed: ${err.message}`);
    return 0;
  }
}

/**
 * Открывает виртуальную позицию.
 *
 * @param {string}  coin
 * @param {number}  price
 * @param {number}  apy
 * @param {boolean} [silent=false]
 * @returns {Promise<{ ok: boolean, positionId?: number, sizeUsd?: number }>}
 */
export async function paperOpen(coin, price, apy, silent = false, strategyId = 'carry', side = 'short', volIdx = 0) {
  const balance = await getPaperBalance();

  if (balance <= 0) {
    logger.warn(`[Executor] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  // Vol-based sizing: на high-vol монетах режем размер carry-позиции.
  const volMult = strategyId === 'carry'
    ? calcVolSizeMultiplier(volIdx, config.trading.carryVolSizePenalty, config.trading.carryVolSizeMinMult)
    : 1;
  const effectiveUtilization = 0.95 * volMult;

  const { sizeUsd, tooSmall } = calcSize(balance, price, 0, effectiveUtilization);

  if (tooSmall) {
    logger.warn(
      `[Executor] [SKIP] PAPER #${coin} — order size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} minimum`,
    );
    return { ok: false };
  }

  if (volMult < 1) {
    logger.info(
      `[Sizing] #${coin} volIdx=${volIdx.toFixed(4)} → ×${volMult.toFixed(2)} → size $${sizeUsd.toFixed(2)} (base $${(balance * 0.95).toFixed(2)})`,
    );
  }

  const fee = sizeUsd * ONE_LEG;

  // entry_apy всегда сохраняется как abs — carry-edge magnitude. Знак заложен в side.
  const id = savePosition({
    coin,
    size_usd: sizeUsd,
    entry_price: price,
    entry_apy: Math.abs(apy),
    entry_time: Date.now(),
    mode: "PAPER",
    strategy_id: strategyId,
    side,
  });

  logger.info(
    `[Executor] PAPER OPEN ${side.toUpperCase()} #${coin} | $${sizeUsd.toFixed(2)} (of $${balance.toFixed(2)}) @ $${price} | APY: ${apy.toFixed(2)}% | fee: $${fee.toFixed(4)} | id: ${id}`,
  );

  if (!silent) {
    await notifyPaperOpen({ coin, sizeUsd, balance, price, apy, fee, side });
  }

  notify('afterOpen', { coin, price, apy, sizeUsd, positionId: Number(id), mode: 'PAPER' });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Sniper-Hunter (Strategy #3).
 *
 * Отличия от paperOpen:
 *  - Размер = HUNTER_BALANCE_UTILIZATION × баланс (env-настраиваемо), не 95%.
 *  - Записывает sl_price / tp_price в БД (триггеры симулируются в strategistSniper.analyzeHunter).
 *  - strategy_id = 'hunter', entry_apy = 0 (Hunter не получает funding).
 *  - Направление в Iter A — всегда SHORT (short-after-pump).
 *
 * Telegram-нотификация появится в Iter A.4.
 *
 * @param {string} coin
 * @param {number} price — цена входа
 * @param {number} spikePct — величина пампа на входе (для лога/аналитики)
 * @param {number} sl — stop-loss price (для SHORT: > price)
 * @param {number} tp — take-profit price (для SHORT: < price)
 * @param {boolean} [silent=false]
 * @returns {Promise<{ ok: boolean, positionId?: number, sizeUsd?: number }>}
 */
export async function hunterPaperOpen(coin, price, spikePct, sl, tp, silent = false, entryFeatures = null) {
  const balance = await getPaperBalance();

  if (balance <= 0) {
    logger.warn(`[Executor] [HUNTER] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  const util = config.trading.hunterBalanceUtil;
  const { sizeUsd, tooSmall } = calcSize(balance, price, 0, util);

  if (tooSmall) {
    logger.warn(
      `[Executor] [HUNTER SKIP] #${coin} — size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min (${(util * 100).toFixed(0)}% баланса $${balance.toFixed(2)})`,
    );
    return { ok: false };
  }

  const fee = sizeUsd * ONE_LEG;

  const id = savePosition({
    coin,
    size_usd:    sizeUsd,
    entry_price: price,
    entry_apy:   0,                // Hunter не funding-based
    entry_time:  Date.now(),
    mode:        "PAPER",
    strategy_id: 'hunter',
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 🎯 HUNTER OPEN SHORT #${coin} | $${sizeUsd.toFixed(2)} (of $${balance.toFixed(2)}) @ $${price} ` +
      `| spike +${spikePct.toFixed(2)}% | SL $${sl.toFixed(4)} / TP $${tp.toFixed(4)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  if (!silent) {
    await notifyHunterOpen({ coin, sizeUsd, balance, price, spikePct, sl, tp, fee });
  }

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'hunter',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную LONG-позицию для Hunter Long (Strategy #3, Iter E.1).
 *
 * Зеркало hunterPaperOpen:
 *  - Размер = HUNTER_LONG_BALANCE_UTILIZATION × баланс (env, по умолч. 50%).
 *  - strategy_id='hunter_long', side='long', entry_apy=0.
 *  - SL/TP инвертированы относительно SHORT: sl < entry < tp.
 *  - Iter E.1: только PAPER. Notification reuse'им notifyPaperOpen с side='long'.
 *
 * @param {string} coin
 * @param {number} price — цена входа
 * @param {number} dumpPct — величина дампа на входе (отрицательное число, для лога/аналитики)
 * @param {number} sl — stop-loss (для LONG: < price)
 * @param {number} tp — take-profit (для LONG: > price)
 * @param {boolean} [silent=false]
 * @param {Object} [entryFeatures=null]
 */
export async function hunterLongPaperOpen(coin, price, dumpPct, sl, tp, silent = false, entryFeatures = null) {
  const balance = await getPaperBalance();

  if (balance <= 0) {
    logger.warn(`[Executor] [HUNTER_LONG] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  const util = config.trading.hunterLongBalanceUtil;
  const { sizeUsd, tooSmall } = calcSize(balance, price, 0, util);

  if (tooSmall) {
    logger.warn(
      `[Executor] [HUNTER_LONG SKIP] #${coin} — size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min (${(util * 100).toFixed(0)}% баланса $${balance.toFixed(2)})`,
    );
    return { ok: false };
  }

  const fee = sizeUsd * ONE_LEG;

  const id = savePosition({
    coin,
    size_usd:    sizeUsd,
    entry_price: price,
    entry_apy:   0,
    entry_time:  Date.now(),
    mode:        "PAPER",
    strategy_id: 'hunter_long',
    side:        'long',
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 🎯 HUNTER_LONG OPEN LONG #${coin} | $${sizeUsd.toFixed(2)} (of $${balance.toFixed(2)}) @ $${price} ` +
      `| dump ${dumpPct.toFixed(2)}% | SL $${sl.toFixed(4)} / TP $${tp.toFixed(4)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  if (!silent) {
    await notifyHunterLongOpen({ coin, sizeUsd, balance, price, dumpPct, sl, tp, fee });
  }

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'hunter_long',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Strategy #4 trend_follow (Chill Boy).
 *
 * Отличия:
 *  - Размер = CHILL_BOY_BALANCE_UTILIZATION (default 50%).
 *  - strategy_id='trend_follow', side зависит от direction.
 *  - SL/TP — в ATR-единицах от entry (расчёт в strategist'е).
 *
 * @param {string} coin
 * @param {number} price
 * @param {'LONG'|'SHORT'} direction
 * @param {number} sl
 * @param {number} tp
 * @param {boolean} [silent=false]
 * @param {Object} [entryFeatures=null]
 */
export async function trendFollowPaperOpen(coin, price, direction, sl, tp, silent = false, entryFeatures = null) {
  const balance = await getPaperBalance();
  if (balance <= 0) {
    logger.warn(`[Executor] [ChillBoy] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }

  const utilization = config.trading.chillBoyBalanceUtil;
  const { sizeUsd, tooSmall } = calcSize(balance, price, 0, utilization);
  if (tooSmall) {
    logger.warn(
      `[Executor] [ChillBoy SKIP] #${coin} — size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min (${(utilization * 100).toFixed(0)}% баланса $${balance.toFixed(2)})`,
    );
    return { ok: false };
  }

  const fee  = sizeUsd * ONE_LEG;
  const side = direction === 'LONG' ? 'long' : 'short';

  const id = savePosition({
    coin,
    size_usd:    sizeUsd,
    entry_price: price,
    entry_apy:   0,
    entry_time:  Date.now(),
    mode:        "PAPER",
    strategy_id: 'trend_follow',
    side,
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 🎯 ChillBoy OPEN ${direction} #${coin} | $${sizeUsd.toFixed(2)} (of $${balance.toFixed(2)}) @ $${price} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'trend_follow',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Закрывает виртуальную позицию.
 *
 * Paper PnL = fundingPnl − fees (без pricePnl, т.к. нет реального fill).
 * Fee по умолчанию = size_usd × ONE_LEG × 2 (taker+slippage на обе ноги).
 *
 * opts используется Sniper-симуляцией (Iter 2): при maker-fill exit идёт
 * по MAKER_FEE_RATE без slippage, close_price = armPrice (наш limit).
 *
 * @param {{ price: number, reason: string }} signal
 * @param {Object} position — строка из БД
 * @param {boolean} [silent=false]
 * @param {Object} [opts]
 * @param {number} [opts.closePrice] — override signal.price (например, armPrice Sniper)
 * @param {number} [opts.exitFeeRate] — override ставки комиссии выхода (default: ONE_LEG)
 * @returns {Promise<{ ok: boolean, pnl: number, holdHours: number }>}
 */
export async function paperClose(signal, position, silent = false, opts = {}) {
  const holdMs    = Date.now() - position.entry_time;
  const holdHours = holdMs / 3_600_000;
  const closePrice = opts.closePrice ?? signal.price;
  const exitFeeRate = opts.exitFeeRate ?? ONE_LEG;

  const { fundingPnl, totalFee, realizedPnl: baseRealized } = calcPaperClose(
    position, holdHours, exitFeeRate,
  );

  // Для hunter-позиций закрытие идёт по SL/TP уровню — это реальная цена fill'а,
  // значит pricePnl имеет смысл (в отличие от carry/fade, где close_price условен).
  // Hunter SHORT: pricePnl = (entry − close)/entry × size.
  // Hunter LONG  (Iter E.1): pricePnl = (close − entry)/entry × size (зеркально).
  let pricePnl = 0;
  if (position.strategy_id === 'hunter') {
    pricePnl = (position.size_usd * (position.entry_price - closePrice)) / position.entry_price;
  } else if (position.strategy_id === 'hunter_long') {
    pricePnl = (position.size_usd * (closePrice - position.entry_price)) / position.entry_price;
  } else if (position.strategy_id === 'trend_follow') {
    const isLong = (position.side || '').toLowerCase() === 'long';
    pricePnl = isLong
      ? (position.size_usd * (closePrice - position.entry_price)) / position.entry_price
      : (position.size_usd * (position.entry_price - closePrice)) / position.entry_price;
  }
  const realizedPnl = baseRealized + pricePnl;

  // Hunter / Hunter Long: подмешиваем MFE/MAE из tick-трекера + hold_seconds.
  // Для carry/fade — exitFeatures null (поля в history останутся NULL).
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
  }

  dbClosePosition(position.id, {
    close_price:  closePrice,
    realized_pnl: realizedPnl,
    fee_paid:     totalFee,
    reason:       signal.reason,
    exitFeatures,
  });

  // Cross-strategy cooldown: на любом close Hunter-позиции бьём общий cooldown.
  // Покрывает и external/reconcile closes, не только strategist-инициированные.
  if (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long') {
    setHunterCrossCooldown(position.coin);
  }

  // Re-entry cooldown (paper mode тоже)
  setCooldown(position.coin);
  logger.info(
    `[Executor] ⏳ Re-entry cooldown set: #${position.coin} → ${REENTRY_COOLDOWN_MS / 60_000}min`,
  );

  const sign = realizedPnl >= 0 ? "+" : "";
  logger.info(
    `[Executor] PAPER CLOSE #${position.coin} | reason: ${signal.reason} ` +
      `| held: ${holdHours.toFixed(1)}h | PnL: ${sign}$${realizedPnl.toFixed(4)} | fees: $${totalFee.toFixed(4)}`,
  );

  if (!silent) {
    // Hunter-закрытие по SL/TP имеет собственный формат с entry→level + hold в минутах.
    if (position.strategy_id === 'hunter' && signal.reason === 'hunter_sl') {
      await notifyHunterSL({
        coin:        position.coin,
        entryPrice:  position.entry_price,
        slPrice:     closePrice,
        pnl:         realizedPnl,
        fee:         totalFee,
        holdMinutes: Math.round(holdHours * 60),
      });
    } else if (position.strategy_id === 'hunter' && signal.reason === 'hunter_tp') {
      await notifyHunterTP({
        coin:        position.coin,
        entryPrice:  position.entry_price,
        tpPrice:     closePrice,
        pnl:         realizedPnl,
        fee:         totalFee,
        holdMinutes: Math.round(holdHours * 60),
      });
    } else if (position.strategy_id === 'hunter' && signal.reason === 'hunter_trail_tp') {
      await notifyHunterTrailTp({
        coin:         position.coin,
        entryPrice:   position.entry_price,
        closePrice,
        peakPct:      signal.peakPct ?? exitFeatures?.trail_peak_pct ?? 0,
        giveBackPct:  signal.giveBackPct ?? exitFeatures?.trail_give_back_pct ?? 0,
        pnl:          realizedPnl,
        fee:          totalFee,
        holdMinutes:  Math.round(holdHours * 60),
        fixedTpPrice: position.tp_price,
      });
    } else if (position.strategy_id === 'hunter_long' && signal.reason === 'hunter_long_sl') {
      await notifyHunterLongSL({
        coin:        position.coin,
        entryPrice:  position.entry_price,
        slPrice:     closePrice,
        pnl:         realizedPnl,
        fee:         totalFee,
        holdMinutes: Math.round(holdHours * 60),
      });
    } else if (position.strategy_id === 'hunter_long' && signal.reason === 'hunter_long_tp') {
      await notifyHunterLongTP({
        coin:        position.coin,
        entryPrice:  position.entry_price,
        tpPrice:     closePrice,
        pnl:         realizedPnl,
        fee:         totalFee,
        holdMinutes: Math.round(holdHours * 60),
      });
    } else if (position.strategy_id === 'hunter_long' && signal.reason === 'hunter_long_trail_tp') {
      await notifyHunterLongTrailTp({
        coin:         position.coin,
        entryPrice:   position.entry_price,
        closePrice,
        peakPct:      signal.peakPct ?? exitFeatures?.trail_peak_pct ?? 0,
        giveBackPct:  signal.giveBackPct ?? exitFeatures?.trail_give_back_pct ?? 0,
        pnl:          realizedPnl,
        fee:          totalFee,
        holdMinutes:  Math.round(holdHours * 60),
        fixedTpPrice: position.tp_price,
      });
    } else {
      await notifyPaperClose({
        coin: position.coin, holdHours,
        reason: signal.reason,
        pnl: realizedPnl, fee: totalFee,
        side: position.side || 'short',
      });
    }
  }

  // Circuit breaker: фиксируем убыток
  if (realizedPnl < 0) {
    const tripped = recordLoss(position.coin, realizedPnl);
    if (tripped) {
      logger.error(
        `[Executor] 🛑 CIRCUIT BREAKER TRIPPED after PAPER loss #${position.coin} ($${realizedPnl.toFixed(4)})`,
      );
      await notifyCircuitBreaker({
        losses: 3,
        pauseMinutes: CB_PAUSE_MS / 60_000,
        lastCoin: position.coin,
        lastPnl: realizedPnl,
      });
    }
  }

  notify('afterClose', {
    coin: position.coin, pnl: realizedPnl, holdHours,
    reason: signal.reason, mode: 'PAPER',
  });

  return { ok: true, pnl: realizedPnl, fee: totalFee, holdHours };
}
