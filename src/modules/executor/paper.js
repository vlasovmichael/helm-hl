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
import { consumeTrendFollowMfeMae } from '../strategistTrendFollow.js';
import {
  consumeFaderMfeMae, clearFaderPositionState, recordFaderLoss, setFaderCooldown,
} from '../strategistFader.js';
import { setHunterCrossCooldown } from '../hunterCrossCooldown.js';
import { resolveAsset } from './fill-parser.js';
import { resolveEntrySize } from './sizing.js';
import { getVirtualEquity, applyVirtualPnl } from '../chillBoyVirtualEquity.js';
import { getFaderVirtualEquity, applyFaderVirtualPnl } from '../faderVirtualEquity.js';
import { getCandyGirlVirtualEquity, applyCandyGirlVirtualPnl } from '../candyGirlVirtualEquity.js';

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
 * szDecimals монеты из общего universe-кеша. Нужен calcSize'у, чтобы
 * округление sz в PAPER совпадало с PROD (zero hardcoded → монеты дороже
 * размера позиции молча округлялись в sz=0 и скипались). null → монета
 * не в universe, открывать нельзя.
 */
function resolvePaperSzDecimals(coin) {
  try {
    return resolveAsset(coin).szDecimals;
  } catch (err) {
    logger.warn(`[Executor] PAPER #${coin} — resolveAsset failed: ${err.message}`);
    return null;
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

  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = calcSize(balance, price, szDecimals, effectiveUtilization);

  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `order size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} minimum`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(`[Executor] [SKIP] PAPER #${coin} — ${why}`);
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
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'Hunter', equity: balance, capBase: balance,
    capUtil: util, price, sl, szDecimals,
  });

  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(
      `[Executor] [HUNTER SKIP] #${coin} — ${why} (${(util * 100).toFixed(0)}% баланса $${balance.toFixed(2)})`,
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
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'HunterLong', equity: balance, capBase: balance,
    capUtil: util, price, sl, szDecimals,
  });

  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(
      `[Executor] [HUNTER_LONG SKIP] #${coin} — ${why} (${(util * 100).toFixed(0)}% баланса $${balance.toFixed(2)})`,
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
  const virtualMode = config.trading.chillBoyPaperVirtualBalance > 0;
  const balance = virtualMode ? getVirtualEquity() : await getPaperBalance();
  if (balance <= 0) {
    logger.warn(`[Executor] [ChillBoy] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }
  const balanceTag = virtualMode ? `virtual $${balance.toFixed(2)}` : `real $${balance.toFixed(2)}`;

  const utilization = virtualMode
    ? config.trading.chillBoyPaperVirtualUtil
    : config.trading.chillBoyBalanceUtil;
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'ChillBoy', equity: balance, capBase: balance,
    capUtil: utilization, price, sl, szDecimals,
  });
  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(
      `[Executor] [ChillBoy SKIP] #${coin} — ${why} (${(utilization * 100).toFixed(0)}% ${balanceTag})`,
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
    `[Executor] 🎯 ChillBoy OPEN ${direction} #${coin} | $${sizeUsd.toFixed(2)} (of ${balanceTag}) @ $${price} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'trend_follow',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Candy Girl (Iter 2 paper-слот).
 *
 * Зеркало trendFollowPaperOpen: virtual sandbox (candyGirlVirtualEquity) когда
 * CANDY_GIRL_PAPER_VIRTUAL_BALANCE>0, иначе реальный paper-баланс. SL/TP заданы
 * детектором (свинг отката / R:R). strategy_id='candy_girl'. PAPER-only.
 *
 * @param {string} coin
 * @param {number} price
 * @param {'LONG'|'SHORT'} direction
 * @param {number} sl
 * @param {number} tp
 * @param {boolean} [silent=false]
 * @param {Object} [entryFeatures=null]
 */
export async function candyPaperOpen(coin, price, direction, sl, tp, silent = false, entryFeatures = null) {
  const virtualMode = config.trading.candyGirlPaperVirtualBalance > 0;
  const balance = virtualMode ? getCandyGirlVirtualEquity() : await getPaperBalance();
  if (balance <= 0) {
    logger.warn(`[Executor] [CandyGirl] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }
  const balanceTag = virtualMode ? `virtual $${balance.toFixed(2)}` : `real $${balance.toFixed(2)}`;

  const utilization = virtualMode
    ? config.trading.candyGirlPaperVirtualUtil
    : config.trading.candyGirlBalanceUtil;
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'CandyGirl', equity: balance, capBase: balance,
    capUtil: utilization, price, sl, szDecimals,
  });
  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(
      `[Executor] [CandyGirl SKIP] #${coin} — ${why} (${(utilization * 100).toFixed(0)}% ${balanceTag})`,
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
    strategy_id: 'candy_girl',
    side,
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 🍬 CandyGirl OPEN ${direction} #${coin} | $${sizeUsd.toFixed(2)} (of ${balanceTag}) @ $${price} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'candy_girl',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Vapor (Exhaustion Short, Трек A).
 * Short-only, risk-based размер от реального paper-баланса (util из config).
 * SL/TP заданы детектором. strategy_id='vapor'. PAPER-only.
 *
 * @param {string} coin
 * @param {number} price
 * @param {'SHORT'} direction
 * @param {number} sl
 * @param {number} tp
 * @param {boolean} [silent=false]
 * @param {Object} [entryFeatures=null]
 */
export async function vaporPaperOpen(coin, price, direction, sl, tp, silent = false, entryFeatures = null) {
  const balance = await getPaperBalance();
  if (balance <= 0) {
    logger.warn(`[Executor] [Vapor] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }
  const utilization = config.trading.vaporBalanceUtil;
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'Vapor', equity: balance, capBase: balance,
    capUtil: utilization, price, sl, szDecimals,
  });
  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(`[Executor] [Vapor SKIP] #${coin} — ${why} (${(utilization * 100).toFixed(0)}% real $${balance.toFixed(2)})`);
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
    mode:        'PAPER',
    strategy_id: 'vapor',
    side,
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 💨 Vapor OPEN ${direction} #${coin} | $${sizeUsd.toFixed(2)} (of real $${balance.toFixed(2)}) @ $${price} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'vapor',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Hot Movers paper (торгует вердикт карточки).
 * LONG или SHORT (side из direction), risk-based размер от реального paper-баланса
 * (util из config). SL/TP заданы детектором. strategy_id='hotmovers'. PAPER-only.
 *
 * @param {string} coin
 * @param {number} price
 * @param {'LONG'|'SHORT'} direction
 * @param {number} sl
 * @param {number} tp
 * @param {boolean} [silent=false]
 * @param {Object} [entryFeatures=null]
 */
export async function hotMoversPaperOpen(coin, price, direction, sl, tp, silent = false, entryFeatures = null) {
  const balance = await getPaperBalance();
  if (balance <= 0) {
    logger.warn(`[Executor] [HotMovers] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }
  const utilization = config.trading.hotMoversPaperBalanceUtil;
  const leverage = config.trading.hotMoversPaperLeverage;
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'HotMovers', equity: balance, capBase: balance * leverage,
    capUtil: utilization, price, sl, szDecimals,
  });
  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(`[Executor] [HotMovers SKIP] #${coin} — ${why} (${(utilization * 100).toFixed(0)}% real $${balance.toFixed(2)})`);
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
    mode:        'PAPER',
    strategy_id: 'hotmovers',
    side,
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 👀 HotMovers OPEN ${direction} #${coin} | $${sizeUsd.toFixed(2)} (${leverage}x of real $${balance.toFixed(2)}) @ $${price} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'hotmovers',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Setup Swing paper (вердикт карточки Swing).
 * LONG или SHORT (side из direction), risk-based размер от реального paper-баланса
 * (util из config). SL/TP = план карточки. strategy_id='swing'. PAPER-only.
 *
 * @param {string} coin
 * @param {number} price
 * @param {'LONG'|'SHORT'} direction
 * @param {number} sl
 * @param {number} tp
 * @param {boolean} [silent=false]
 * @param {Object} [entryFeatures=null]
 */
export async function swingPaperOpen(coin, price, direction, sl, tp, silent = false, entryFeatures = null) {
  const balance = await getPaperBalance();
  if (balance <= 0) {
    logger.warn(`[Executor] [Swing] Cannot open — balance is $${balance.toFixed(2)}`);
    return { ok: false };
  }
  const utilization = config.trading.swingPaperBalanceUtil;
  const leverage = config.trading.swingPaperLeverage;
  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };
  const { sizeUsd, sz, tooSmall } = resolveEntrySize({
    coin, tag: 'Swing', equity: balance, capBase: balance * leverage,
    capUtil: utilization, price, sl, szDecimals,
  });
  if (tooSmall) {
    const why = sizeUsd < MIN_ORDER_USD
      ? `size $${sizeUsd.toFixed(2)} < $${MIN_ORDER_USD} min`
      : `sz=${sz} rounds to 0 (szDecimals=${szDecimals}, price $${price})`;
    logger.warn(`[Executor] [Swing SKIP] #${coin} — ${why} (${(utilization * 100).toFixed(0)}% real $${balance.toFixed(2)})`);
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
    mode:        'PAPER',
    strategy_id: 'swing',
    side,
    sl_price:    sl,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 📐 Swing OPEN ${direction} #${coin} | $${sizeUsd.toFixed(2)} (${leverage}x of real $${balance.toFixed(2)}) @ $${price} ` +
      `| SL $${sl.toFixed(6)} / TP $${tp.toFixed(6)} | fee $${fee.toFixed(4)} | id: ${id}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd, positionId: Number(id), mode: 'PAPER', strategy: 'swing',
  });

  return { ok: true, positionId: Number(id), sizeUsd };
}

/**
 * Открывает виртуальную позицию для Strategy #5 Fader.
 *
 * Fader — paper-only contrarian scalper. Размер позиции = NOMINAL × LEVERAGE
 * (фикс notional, по умолч. $50 × 2 = $100). Берётся из faderVirtualEquity
 * (не из реального баланса) — это отдельный compound-sandbox. Не использует
 * resolveEntrySize, т.к. сайз фиксированный, не risk-based.
 *
 * @param {string} coin
 * @param {number} price
 * @param {'LONG'|'SHORT'} direction
 * @param {number} tp
 * @param {Object} [entryFeatures=null]
 */
export async function faderPaperOpen(coin, price, direction, tp, silent = false, entryFeatures = null) {
  const virtualBalance = getFaderVirtualEquity();
  const nominal  = config.trading.faderNominalUsd;
  const leverage = config.trading.faderLeverage;
  const notional = nominal * leverage;

  if (virtualBalance < nominal) {
    logger.warn(
      `[Executor] [Fader] Cannot open — virtual balance $${virtualBalance.toFixed(2)} < nominal $${nominal}`,
    );
    return { ok: false };
  }

  const szDecimals = resolvePaperSzDecimals(coin);
  if (szDecimals == null) return { ok: false };

  // Fader не использует resolveEntrySize (нет SL → нет risk-based size).
  // Считаем sz напрямую от notional. tooSmall если notional < MIN_ORDER_USD.
  if (notional < MIN_ORDER_USD) {
    logger.warn(`[Executor] [Fader SKIP] #${coin} — notional $${notional} < $${MIN_ORDER_USD}`);
    return { ok: false };
  }

  const side = direction === 'LONG' ? 'long' : 'short';
  const id = savePosition({
    coin,
    size_usd:    notional,
    entry_price: price,
    entry_apy:   0,
    entry_time:  Date.now(),
    mode:        'PAPER',
    strategy_id: 'fader',
    side,
    sl_price:    null,
    tp_price:    tp,
    ...(entryFeatures || {}),
  });

  logger.info(
    `[Executor] 🪞 FADER OPEN ${direction} #${coin} | notional $${notional.toFixed(2)} ` +
      `(nominal $${nominal} × ${leverage}x) @ $${price} | TP $${tp.toFixed(6)} | id: ${id} | virtual $${virtualBalance.toFixed(2)}`,
  );

  notify('afterOpen', {
    coin, price, sizeUsd: notional, positionId: Number(id), mode: 'PAPER', strategy: 'fader',
  });

  return { ok: true, positionId: Number(id), sizeUsd: notional };
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
  } else if (position.strategy_id === 'trend_follow' || position.strategy_id === 'candy_girl' || position.strategy_id === 'vapor') {
    const isLong = (position.side || '').toLowerCase() === 'long';
    pricePnl = isLong
      ? (position.size_usd * (closePrice - position.entry_price)) / position.entry_price
      : (position.size_usd * (position.entry_price - closePrice)) / position.entry_price;
  } else if (position.strategy_id === 'fader') {
    // Fader paper PnL = pricePnl − modelled fees+slippage (нет funding).
    // baseRealized (funding−fees) НЕ применяется: Fader не carry, и его fee-модель
    // фиксированная ($0.19/round по дефолту), а не % от size.
    const isLong = (position.side || '').toLowerCase() === 'long';
    pricePnl = isLong
      ? (position.size_usd * (closePrice - position.entry_price)) / position.entry_price
      : (position.size_usd * (position.entry_price - closePrice)) / position.entry_price;
  }
  // Fader: переопределяем realized = pricePnl − fader-fees (игнорим baseRealized).
  let realizedPnl;
  let totalFeeOverride = null;
  if (position.strategy_id === 'fader') {
    const feePct  = config.trading.faderFeeRoundtripPct;  // % notional
    const fee     = (feePct * 0.01) * position.size_usd;
    const slip    = config.trading.faderSlippageRoundtripUsd;
    totalFeeOverride = fee + slip;
    realizedPnl = pricePnl - totalFeeOverride;
  } else {
    realizedPnl = baseRealized + pricePnl;
  }

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
  } else if (position.strategy_id === 'trend_follow') {
    const mm = consumeTrendFollowMfeMae(position.id);
    exitFeatures = {
      mfe_usd:      mm?.mfeUsd ?? null,
      mae_usd:      mm?.maeUsd ?? null,
      mfe_pct:      mm?.mfePct ?? null,
      mae_pct:      mm?.maePct ?? null,
      hold_seconds: Math.round(holdMs / 1000),
    };
  } else if (position.strategy_id === 'fader') {
    const mm = consumeFaderMfeMae(position.id);
    exitFeatures = {
      mfe_usd:      mm?.mfeUsd ?? null,
      mae_usd:      mm?.maeUsd ?? null,
      mfe_pct:      mm?.mfePct ?? null,
      mae_pct:      mm?.maePct ?? null,
      hold_seconds: Math.round(holdMs / 1000),
    };
  } else if (position.strategy_id === 'vapor') {
    // Iter 1: MFE/MAE-трекинг не делаем, но hold_seconds полезен для оценки.
    exitFeatures = { hold_seconds: Math.round(holdMs / 1000) };
  }

  const finalFee = totalFeeOverride ?? totalFee;
  dbClosePosition(position.id, {
    close_price:  closePrice,
    realized_pnl: realizedPnl,
    fee_paid:     finalFee,
    reason:       signal.reason,
    exitFeatures,
  });

  // Compound sandbox: ChillBoy paper virtual equity tracks net P&L over time.
  if (
    position.strategy_id === 'trend_follow' &&
    position.mode === 'PAPER' &&
    config.trading.chillBoyPaperVirtualBalance > 0
  ) {
    applyVirtualPnl(realizedPnl - totalFee, { coin: position.coin, reason: signal.reason });
  }

  // Compound sandbox: Candy Girl paper virtual equity (Iter 2).
  if (
    position.strategy_id === 'candy_girl' &&
    position.mode === 'PAPER' &&
    config.trading.candyGirlPaperVirtualBalance > 0
  ) {
    applyCandyGirlVirtualPnl(realizedPnl - totalFee, { coin: position.coin, reason: signal.reason });
  }

  // Fader virtual equity — net pnl уже включает modelled fees+slip.
  if (
    position.strategy_id === 'fader' &&
    position.mode === 'PAPER' &&
    config.trading.faderVirtualBalance > 0
  ) {
    applyFaderVirtualPnl(realizedPnl, { coin: position.coin, reason: signal.reason });
    setFaderCooldown(position.coin);
    clearFaderPositionState(position.id);
    if (realizedPnl < 0) recordFaderLoss();
  }

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
      `| held: ${holdHours.toFixed(1)}h | PnL: ${sign}$${realizedPnl.toFixed(4)} | fees: $${finalFee.toFixed(4)}`,
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

  // Circuit breaker: фиксируем убыток только для реальных стратегий.
  // trend_follow (ChillBoy) и candy_girl торгуют в виртуальных sandbox-слотах —
  // их PAPER убытки не должны блокировать реальные Hunter сделки.
  const virtualSandbox = position.strategy_id === 'trend_follow' || position.strategy_id === 'candy_girl';
  if (realizedPnl < 0 && !virtualSandbox) {
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
