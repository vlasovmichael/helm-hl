// ─────────────────────────────────────────────────
//  Executor Hooks — точки расширения (gate / notify)
// ─────────────────────────────────────────────────
// EventEmitter для AI-Advisor, NBP Accounting, Dashboard.
// Без подписчиков — zero overhead.

import { EventEmitter } from 'node:events';
import { logger } from '../../core/logger.js';

const emitter = new EventEmitter();

// ── Подписка ───────────────────────────────────

/**
 * Регистрирует хук. Возвращает функцию отписки.
 * @param {string} event
 * @param {Function} handler
 * @returns {() => void}
 */
export function on(event, handler) {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}

// ── Gate (блокирующий, ПЕРЕД действием) ────────

/**
 * Все подписчики вызываются последовательно.
 * Если любой вернёт { allow: false, reason }, действие отменяется.
 * Ошибка в хуке логируется, но НЕ блокирует торговлю.
 *
 * @param {string} event
 * @param {Object} context
 * @returns {Promise<{ allowed: boolean, vetoReason?: string }>}
 */
export async function gate(event, context) {
  const handlers = emitter.listeners(event);

  for (const handler of handlers) {
    try {
      const result = await handler(context);
      if (result && result.allow === false) {
        logger.info(
          `[Hooks] ${event} vetoed by handler: ${result.reason ?? 'no reason'}`,
        );
        return { allowed: false, vetoReason: result.reason ?? 'vetoed' };
      }
    } catch (err) {
      logger.error(`[Hooks] ${event} handler threw: ${err.message}`);
    }
  }

  return { allowed: true };
}

// ── Notify (fire-and-forget, ПОСЛЕ действия) ──

/**
 * Не блокирует executor. Async-хуки ловят rejection в фоне.
 *
 * @param {string} event
 * @param {Object} context
 */
export function notify(event, context) {
  const handlers = emitter.listeners(event);

  for (const handler of handlers) {
    try {
      const result = handler(context);
      if (result?.catch) {
        result.catch((err) =>
          logger.error(`[Hooks] ${event} async handler failed: ${err.message}`),
        );
      }
    } catch (err) {
      logger.error(`[Hooks] ${event} handler threw: ${err.message}`);
    }
  }
}

// ── Перечень событий ───────────────────────────
//
// Gate (блокирующие):
//   "beforeOpen"   — { coin, price, apy, sizeUsd }
//
// Notify (fire-and-forget):
//   "afterOpen"    — { coin, price, apy, sizeUsd, positionId, fill?, mode }
//   "afterClose"   — { coin, pnl, holdHours, reason, fill?, mode }
//   "afterRotate"  — { closeCoin, openCoin, closePnl, positionId }
//   "onError"      — { operation, coin, error }
//   "stateChange"  — { type, coin, data }
