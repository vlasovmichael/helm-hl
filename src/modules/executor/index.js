// ─────────────────────────────────────────────────
//  Executor — публичный фасад
// ─────────────────────────────────────────────────
// Единственная точка входа. Контракт с index.js не меняется.

import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { state as appState } from '../../app/state.js';
import { getAccountSummary } from '../exchange.js';
import { invalidateAccountState } from '../../core/accountState.js';
import { getAccountEquity } from '../wallet.js';
import { checkVolatility } from '../volatility.js';
import {
  paperClose, hunterPaperOpen, hunterLongPaperOpen,
  vaporPaperOpen, hotMoversPaperOpen, swingPaperOpen, fadeHotPaperOpen,
} from './paper.js';
import { productionClose } from './close.js';
import {
  productionHunterOpen, productionHunterLongOpen,
} from './hunterOpen.js';
import { cancelOrderFor } from '../exchange.js';
import {
  notifyOpenBlocked, notifyDrawdownBreached,
} from './notifications.js';
import {
  getCircuitBreakerStatus, checkDrawdown,
  CB_PAUSE_MS, isOiCapBanned, getOiCapBanRemainMs,
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
      return afterMutation(handleOpen(signal));
    case "CLOSE":
      return afterMutation(handleClose(signal, activePosition));
    case "HOLD":
      return { ok: true };
    default:
      logger.warn(`[Executor] Unknown action: ${signal.action}`);
      return { ok: false };
  }
}

// После любой сделки бота сбрасываем коалесцированный срез аккаунта: cold-
// читатели (дашборд/integrity) тут же видят новые позиции/equity, а не висят
// на дотрейдовом снапшоте до истечения TTL. Сбрасываем независимо от исхода —
// частичный успех/ошибка тоже могли изменить состояние на бирже.
async function afterMutation(resultPromise) {
  try {
    return await resultPromise;
  } finally {
    invalidateAccountState("positions", "balance");
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
    const remainMin = Math.ceil(getOiCapBanRemainMs(coin) / 60_000);
    logger.warn(`[Executor] ⛔ OI CAP active for #${coin} (${remainMin} мин до снятия)`);
    return {
      allowed: false,
      reason: 'OI Cap reached',
      details: `Биржа ранее отказала по OI Cap. Осталось <b>${remainMin} мин</b> до снятия бана.`,
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
    return { allowed: true, volIdx: vol.volIdx };
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
    // Двойной gate: HUNTER_ENABLED=true пускает сигнал, но реальные ордера идут
    // только с HUNTER_PROD_ENABLED=true. Без него — PAPER (даже в isProduction),
    // иначе стратегия не набирает paper-данные перед PROD-активацией.
    if (config.isProduction && config.trading.hunterProdEnabled) {
      return productionHunterOpen(
        signal.coin, signal.price, signal.spikePct, signal.sl, signal.tp, false, signal.entryFeatures,
      );
    }
    if (config.isProduction) {
      logger.info(
        `[Executor] Hunter PROD-путь выключен (HUNTER_PROD_ENABLED=false) — сигнал #${signal.coin} идёт в PAPER.`,
      );
    }
    return hunterPaperOpen(
      signal.coin, signal.price, signal.spikePct, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  // Vapor (Exhaustion Short, Трек A) route: PAPER-only shadow-слот. PROD-пути нет —
  // open всегда виртуальный. Carry-guard'ы (CB/drawdown/OI) применяем.
  if (strategyId === 'vapor') {
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    return vaporPaperOpen(
      signal.coin, signal.price, signal.direction, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  // Hot Movers paper route: PAPER-only shadow-слот, торгует вердикт карточки 1:1
  // (LONG/SHORT). PROD-пути нет — open всегда виртуальный. Carry-guard'ы (CB/
  // drawdown/OI) применяем, как у vapor.
  if (strategyId === 'hotmovers') {
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    return hotMoversPaperOpen(
      signal.coin, signal.price, signal.direction, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  // Setup Swing paper route: PAPER-only shadow-слот, вердикт карточки Swing 1:1
  // (LONG/SHORT, план SL/TP от карточки). PROD-пути нет. Carry-guard'ы применяем.
  if (strategyId === 'swing') {
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    return swingPaperOpen(
      signal.coin, signal.price, signal.direction, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  // Fade-high-ER paper route: PAPER-only shadow-слот, fade выдохшегося хвоста.
  // PROD-пути нет — open всегда виртуальный. Только защитный SL (tp=null).
  if (strategyId === 'fadehot') {
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    return fadeHotPaperOpen(
      signal.coin, signal.price, signal.direction, signal.sl, false, signal.entryFeatures,
    );
  }

  // Hunter Long route (Iter E.1): PAPER only. PROD путь — Iter E.3.
  if (strategyId === 'hunter_long') {
    const pre = await preflightChecks(signal.coin, null);
    if (!pre.allowed) {
      await notifyOpenBlocked({ coin: signal.coin, reason: pre.reason, details: pre.details });
      return { ok: false };
    }
    // Двойной gate: HUNTER_LONG_ENABLED=true пускает сигнал, реальные ордера идут
    // только с HUNTER_LONG_PROD_ENABLED=true. Без него — PAPER (даже в isProduction).
    if (config.isProduction && config.trading.hunterLongProdEnabled) {
      return productionHunterLongOpen(
        signal.coin, signal.price, signal.dumpPct, signal.sl, signal.tp, false, signal.entryFeatures,
      );
    }
    if (config.isProduction) {
      logger.info(
        `[Executor] Hunter Long PROD-путь выключен (HUNTER_LONG_PROD_ENABLED=false) — сигнал #${signal.coin} идёт в PAPER.`,
      );
    }
    return hunterLongPaperOpen(
      signal.coin, signal.price, signal.dumpPct, signal.sl, signal.tp, false, signal.entryFeatures,
    );
  }

  // Carry удалён (2026-06-17) — это была единственная стратегия, попадавшая в
  // этот fallthrough. Любой неизвестный strategy_id теперь — баг диспетчера, а
  // не молчаливый carry-открытие реального ордера.
  logger.warn(`[Executor] Неизвестный strategy_id="${strategyId}" для #${signal.coin} — open пропущен.`);
  return { ok: false };
}

async function handleClose(signal, position) {
  if (!position) {
    logger.warn(
      `[Executor] CLOSE signal but no active position — nothing to do`,
    );
    return { ok: false };
  }

  // Shadow-paper позиция в PROD-боте (напр. shadow-стратегия до PROD-активации)
  // закрывается строго виртуально и не отправляет реальный market-ордер.
  if (config.isProduction && position.mode === 'PAPER') {
    return paperClose(signal, position);
  }

  // Hunter PROD: перед market-close снимаем висящие SL/TP триггеры, чтобы они не остались
  // на бирже после закрытия позиции (reduce_only их защищает от двойного fill'а, но это всё
  // равно мусор и потенциальный риск на следующей позиции).
  if (
    config.isProduction &&
    (position.strategy_id === 'hunter' || position.strategy_id === 'hunter_long' || position.strategy_id === 'adopt') &&
    position.mode === 'PRODUCTION' &&
    (position.hunter_sl_oid || position.hunter_tp_oid)
  ) {
    const triggerOids = [position.hunter_sl_oid, position.hunter_tp_oid].filter(Boolean);
    for (const oid of triggerOids) {
      try {
        await cancelOrderFor(position.coin, oid);
        logger.info(`[Executor] HUNTER pre-close cancel #${position.coin} trigger oid=${oid}`);
      } catch (err) {
        // Триггер мог уже сработать / быть отменённым reconciler'ом — это OK.
        logger.debug(`[Executor] HUNTER pre-close cancel oid=${oid} failed (likely gone): ${err.message}`);
      }
    }
  }

  // Маршрут по mode позиции, а не по config.isProduction: бумажная позиция
  // (shadow-стратегия в проде) должна закрываться виртуально, иначе productionClose
  // отправит реальный market-ордер на монету, которой бот не владеет.
  if (position.mode === 'PRODUCTION') {
    return productionClose(signal, position);
  }
  return paperClose(signal, position);
}
