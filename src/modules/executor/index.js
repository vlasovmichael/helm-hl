// ─────────────────────────────────────────────────
//  Executor — публичный фасад
// ─────────────────────────────────────────────────
// Единственная точка входа. Контракт с index.js не меняется.

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { state as appState } from '../../app/state.js';
import { getAccountSummary } from '../exchange.js';
import { getAccountEquity } from '../wallet.js';
import { checkVolatility } from '../volatility.js';
import { paperOpen, paperClose, hunterPaperOpen, hunterLongPaperOpen } from './paper.js';
import {
  productionOpen, productionClose, productionRotate,
  productionHunterOpen, productionHunterLongOpen,
} from './production.js';
import { productionArmSniper, finalizeProdSniperPartial } from './sniper.js';
import { getExchange } from '../exchange.js';
import {
  notifyRotate, notifyRotateFailed,
  notifyOpenBlocked, notifyDrawdownBreached,
  notifySniperArmed,
} from './notifications.js';
import {
  getCircuitBreakerStatus, checkDrawdown,
  CB_PAUSE_MS, isOiCapBanned, OI_CAP_BAN_TTL_MS,
  armSniper, getSniper, clearSniper, hasSniper,
} from './state.js';
import { SNIPER_SOFT_REASONS, SNIPER_WINDOW_MS } from './math.js';
import { notify } from './hooks.js';

// Re-exports для внешних модулей
export { getRuntimeBlacklist, getStateSnapshot, getOiCapBans } from './state.js';
export { on } from './hooks.js';

// Чтобы не спамить TG алертом о drawdown — флаг на сессию
let drawdownAlertSent = false;

/**
 * Исполняет сигнал от Стратега.
 *
 * @param {{ action: string, [key: string]: any }} signal
 * @param {Object|undefined} activePosition — текущая строка из БД (positions)
 * @returns {Promise<{ ok: boolean, positionId?: number, pnl?: number }>}
 */
export async function execute(signal, activePosition) {
  switch (signal.action) {
    case "OPEN":
      return handleOpen(signal);
    case "CLOSE":
      return handleClose(signal, activePosition);
    case "ROTATE":
      return handleRotate(signal, activePosition);
    case "HOLD":
      return { ok: true };
    default:
      logger.warn(`[Executor] Unknown action: ${signal.action}`);
      return { ok: false };
  }
}

// ── Preflight: Circuit Breaker + Drawdown ──────

/**
 * Защитные проверки перед открытием новой позиции.
 * @param {string} coin
 * @param {number|null} smoothedApy — APY кандидата для Volatility-фильтра. null = пропустить vol check.
 * @returns {Promise<{ allowed: boolean, reason?: string, details?: string }>}
 */
async function preflightChecks(coin, smoothedApy = null) {
  // 1. Circuit Breaker
  const cb = getCircuitBreakerStatus();
  if (cb.broken) {
    const remainMin = Math.ceil(cb.remainMs / 60_000);
    logger.warn(
      `[Executor] ⛔ Circuit breaker active — ${cb.losses} losses, ${remainMin}min remaining`,
    );
    return {
      allowed: false,
      reason: 'Circuit Breaker',
      details: `${cb.losses} убытков подряд. Пауза ещё <b>${remainMin} мин</b>.`,
    };
  }

  // 2. Max Drawdown Guard
  if (appState.sessionStartEquity > 0) {
    let equity = 0;
    try {
      if (config.isProduction) {
        const summary = await getAccountSummary();
        equity = summary.equity;
      } else {
        // accountValue (equity), не withdrawable: открытая позиция занимает маржу,
        // withdrawable падает до ~0 и даёт false-positive drawdown breach.
        equity = await getAccountEquity();
      }
    } catch (err) {
      logger.warn(`[Executor] Drawdown check: failed to get equity: ${err.message}`);
      return { allowed: true };  // не блокируем при ошибке API
    }

    const dd = checkDrawdown(equity, appState.sessionStartEquity);
    if (dd.breached) {
      logger.error(
        `[Executor] ⛔ MAX DRAWDOWN BREACHED: -${dd.drawdownPct.toFixed(2)}% ` +
          `($${appState.sessionStartEquity.toFixed(2)} → $${equity.toFixed(2)})`,
      );

      if (!drawdownAlertSent) {
        drawdownAlertSent = true;
        await notifyDrawdownBreached({
          equity,
          sessionStart: appState.sessionStartEquity,
          drawdownPct: dd.drawdownPct,
        });
      }

      return {
        allowed: false,
        reason: 'Max Drawdown',
        details: `Equity $${equity.toFixed(2)} (-${dd.drawdownPct.toFixed(2)}% от стартового). Бот заморожен до перезапуска.`,
      };
    }
  }

  // 3. OI Cap Ban (из стейта)
  if (isOiCapBanned(coin)) {
    logger.warn(`[Executor] ⛔ OI CAP active for #${coin}`);
    return {
      allowed: false,
      reason: 'OI Cap reached',
      details: `Биржа ранее отказала по OI Cap. Бан на <b>${OI_CAP_BAN_TTL_MS / 60_000} мин</b>.`,
    };
  }

  // 4. Volatility Filter — только если стратегист передал APY кандидата
  if (smoothedApy != null) {
    const vol = await checkVolatility(coin, smoothedApy);
    if (!vol.allowed) {
      return {
        allowed: false,
        reason: 'Volatility',
        details:
          `VolIdx=<b>${vol.volIdx.toFixed(4)}</b>, требовался APY≥<b>${vol.requiredApy.toFixed(0)}%</b>, ` +
          `фактический <b>${smoothedApy.toFixed(1)}%</b>. Монета "пампит" — пропускаем тик.`,
      };
    }
  }

  return { allowed: true };
}


// ── Роутинг paper ↔ production ─────────────────

async function handleOpen(signal) {
  const strategyId = signal.strategy_id || 'carry';

  // Hunter route: отдельный путь, свой размер, SL/TP в БД.
  if (strategyId === 'hunter') {
    // Volatility-filter отключаем (Hunter сам ловит волатильность). Остальные гарды применяются.
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    if (config.isProduction) {
      // Двойной gate: HUNTER_ENABLED=true пускает paper-сигналы, но реальные ордера
      // отправляются только с HUNTER_PROD_ENABLED=true. Защита от случайной активации.
      if (!config.trading.hunterProdEnabled) {
        logger.warn(
          `[Executor] Hunter PROD-путь выключен (HUNTER_PROD_ENABLED=false). Сигнал #${signal.coin} пропущен.`,
        );
        return { ok: false };
      }
      return productionHunterOpen(
        signal.coin, signal.price, signal.spikePct, signal.sl, signal.tp, false, signal.entryFeatures,
      );
    }
    return hunterPaperOpen(
      signal.coin, signal.price, signal.spikePct, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  // Hunter Long route (Iter E.1): PAPER only. PROD путь — Iter E.3.
  if (strategyId === 'hunter_long') {
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    if (config.isProduction) {
      // Двойной gate: HUNTER_LONG_ENABLED=true пускает paper-сигналы, реальные ордера
      // отправляются только с HUNTER_LONG_PROD_ENABLED=true.
      if (!config.trading.hunterLongProdEnabled) {
        logger.warn(
          `[Executor] Hunter Long PROD-путь выключен (HUNTER_LONG_PROD_ENABLED=false). Сигнал #${signal.coin} пропущен.`,
        );
        return { ok: false };
      }
      return productionHunterLongOpen(
        signal.coin, signal.price, signal.dumpPct, signal.sl, signal.tp, false, signal.entryFeatures,
      );
    }
    return hunterLongPaperOpen(
      signal.coin, signal.price, signal.dumpPct, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  const pre = await preflightChecks(signal.coin, signal.apy);
  if (!pre.allowed) {
    await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
    return { ok: false };
  }

  const side = signal.side || 'short';

  if (config.isProduction) {
    return productionOpen(signal.coin, signal.price, signal.apy, false, strategyId, side);
  }
  return paperOpen(signal.coin, signal.price, signal.apy, false, strategyId, side);
}

async function handleClose(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] CLOSE signal but no active position — nothing to do`,
    );
    return { ok: false };
  }

  // ── Sniper routing (soft-причины → maker-only exit) ─────────
  const isSoft = SNIPER_SOFT_REASONS.has(signal.reason);
  const sniperActive = hasSniper();

  if (isSoft) {
    // Dup soft-signal при армированном снайпере → silent skip: снайпер уже работает.
    if (sniperActive) {
      const slot = getSniper();
      if (slot.coin === position.coin) {
        return { ok: true };
      }
      // Разные монеты — странное состояние, но лучше не ломать: снимаем и армимся заново.
      logger.warn(
        `[Executor] Sniper armed on #${slot.coin}, but close signal for #${position.coin} — clearing stale slot`,
      );
      // PROD-слот мог иметь живой ордер — пробуем отменить.
      if (slot.mode === 'PROD' && slot.orderId) {
        try {
          await getExchange().exchange.cancelOrder({ coin: `${slot.coin}-PERP`, o: slot.orderId });
          logger.info(`[Executor] cancelled stale Sniper oid=${slot.orderId} on #${slot.coin}`);
        } catch (err) {
          logger.warn(`[Executor] failed to cancel stale Sniper oid=${slot.orderId}: ${err.message}`);
        }
      }
      clearSniper();
    }

    if (config.isProduction) {
      return productionArmSniper(signal, position);
    }

    // PAPER путь — оставляем как было.
    armSniper({
      positionId: position.id,
      coin:       position.coin,
      reason:     signal.reason,
      armPrice:   signal.price,
      side:       'BUY',
      mode:       'PAPER',
      signal,
    });
    const windowMinutes = Math.round(SNIPER_WINDOW_MS / 60_000);
    logger.info(
      `[Executor] 🎯 Sniper ARMED #${position.coin} @ $${signal.price} ` +
        `(reason: ${signal.reason}) — maker-fill окно ${windowMinutes}мин`,
    );
    await notifySniperArmed({
      coin: position.coin,
      armPrice: signal.price,
      reason: signal.reason,
      windowMinutes,
    });
    return { ok: true };
  }

  // Emergency reason при армированном снайпере → отменяем снайпер, идём в market.
  let emergencySlot = null;
  if (sniperActive) {
    emergencySlot = getSniper();
    logger.warn(
      `[Executor] ⚡ Emergency reason "${signal.reason}" — abort Sniper on #${emergencySlot.coin}`,
    );
    if (emergencySlot.mode === 'PROD' && emergencySlot.orderId) {
      try {
        await getExchange().exchange.cancelOrder({ coin: `${emergencySlot.coin}-PERP`, o: emergencySlot.orderId });
        logger.info(`[Executor] emergency cancel of Sniper oid=${emergencySlot.orderId} on #${emergencySlot.coin}`);
      } catch (err) {
        logger.warn(`[Executor] emergency cancelOrder failed (oid=${emergencySlot.orderId}): ${err.message}`);
      }
    }
    clearSniper();
  }

  // Если был partial-fill PROD-снайпера → используем комбинированную бухгалтерию вместо чистого market.
  if (config.isProduction && emergencySlot?.mode === 'PROD' && (emergencySlot.partialFilledSz ?? 0) > 0) {
    logger.info(
      `[Executor] emergency #${position.coin} с partial-fill (${emergencySlot.partialFilledSz}/${emergencySlot.armSzi}) — combined accounting`,
    );
    return finalizeProdSniperPartial(position, emergencySlot, signal.reason);
  }

  // Hunter PROD: перед market-close снимаем висящие SL/TP триггеры, чтобы они не остались
  // на бирже после закрытия позиции (reduce_only их защищает от двойного fill'а, но это всё
  // равно мусор и потенциальный риск на следующей позиции).
  if (
    config.isProduction &&
    (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long') &&
    position.mode === 'PRODUCTION' &&
    (position.hunter_sl_oid || position.hunter_tp_oid)
  ) {
    const triggerOids = [position.hunter_sl_oid, position.hunter_tp_oid].filter(Boolean);
    for (const oid of triggerOids) {
      try {
        await getExchange().exchange.cancelOrder({ coin: `${position.coin}-PERP`, o: oid });
        logger.info(`[Executor] HUNTER pre-close cancel #${position.coin} trigger oid=${oid}`);
      } catch (err) {
        // Триггер мог уже сработать / быть отменённым reconciler'ом — это OK.
        logger.debug(`[Executor] HUNTER pre-close cancel oid=${oid} failed (likely gone): ${err.message}`);
      }
    }
  }

  if (config.isProduction) {
    return productionClose(signal, position);
  }
  return paperClose(signal, position);
}

async function handleRotate(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] ROTATE signal but no active position — treating as OPEN`,
    );
    return handleOpen({
      action: "OPEN",
      coin: signal.openCoin,
      price: signal.openPrice,
      apy: signal.openApy,
      side: signal.openSide || 'short',
    });
  }

  // Preflight: блокируем только открытие новой ноги. Старую позицию НЕ закрываем,
  // если новую открыть нельзя — ротация теряет смысл.
  const pre = await preflightChecks(signal.openCoin, signal.openApy);
  if (!pre.allowed) {
    await notifyOpenBlocked({ coin: signal.openCoin, reason: pre.reason, details: pre.details });
    return { ok: false };
  }

  if (config.isProduction) {
    return productionRotate(signal, position);
  }
  return paperRotate(signal, position);
}

// ── Paper rotate (inline) ──────────────────────

async function paperRotate(signal, position) {
  const closeResult = await paperClose(
    { price: signal.closePrice, reason: signal.reason },
    position,
    true, // silent
  );

  if (!closeResult.ok) return closeResult;

  // Гард: close мог триггернуть circuit breaker
  const cb = getCircuitBreakerStatus();
  if (cb.broken) {
    logger.warn(
      `[Executor] PAPER ROTATE aborted: circuit breaker tripped during close. Bot stays IDLE.`,
    );
    return { ok: true, closePnl: closeResult.pnl };
  }

  const openResult = await paperOpen(
    signal.openCoin,
    signal.openPrice,
    signal.openApy,
    true, // silent
    signal.strategy_id || 'carry',
    signal.openSide || position.side || 'short',
  );

  if (!openResult.ok) {
    await notifyRotateFailed({
      closeCoin: signal.closeCoin, openCoin: signal.openCoin,
      closePnl: closeResult.pnl, phase: 'open',
    });
    return { ok: false, closePnl: closeResult.pnl };
  }

  await notifyRotate({
    closeCoin: signal.closeCoin, openCoin: signal.openCoin,
    holdHours: closeResult.holdHours, closePnl: closeResult.pnl,
    openSizeUsd: openResult.sizeUsd, openApy: signal.openApy,
    paybackHours: signal.paybackHours, isProd: false,
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
