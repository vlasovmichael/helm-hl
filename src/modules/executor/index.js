// ─────────────────────────────────────────────────
//  Executor — публичный фасад
// ─────────────────────────────────────────────────
// Единственная точка входа. Контракт с index.js не меняется.

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { state as appState } from '../../app/state.js';
import { getAccountSummary } from '../exchange.js';
import { getAvailableBalance } from '../wallet.js';
import { checkVolatility } from '../volatility.js';
import { paperOpen, paperClose } from './paper.js';
import { productionOpen, productionClose, productionRotate } from './production.js';
import {
  notifyRotate, notifyRotateFailed,
  notifyOpenBlocked, notifyDrawdownBreached,
} from './notifications.js';
import {
  getCircuitBreakerStatus, checkDrawdown,
  CB_PAUSE_MS, isOiCapBanned, OI_CAP_BAN_TTL_MS,
} from './state.js';
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
        equity = await getAvailableBalance();
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
  const pre = await preflightChecks(signal.coin, signal.apy);
  if (!pre.allowed) {
    await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
    return { ok: false };
  }

  const strategyId = signal.strategy_id || 'carry';
  if (config.isProduction) {
    return productionOpen(signal.coin, signal.price, signal.apy, false, strategyId);
  }
  return paperOpen(signal.coin, signal.price, signal.apy, false, strategyId);
}

async function handleClose(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] CLOSE signal but no active position — nothing to do`,
    );
    return { ok: false };
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
