// ─────────────────────────────────────────────────
//  Toast Bridge — события бота → тост на дашборде (БЕЗ телефона)
// ─────────────────────────────────────────────────
// Жизненный цикл реальных сделок (afterOpen/afterClose) + breadth-flush пишем
// прямо в журнал уведомлений через recordNotification — это кормит колокольчик и
// тост на дашборде по WS. НЕ через fireNtfy: телефон (ntfy) и почта не трогаются,
// «сделки молчат» на ntfy остаётся в силе. Чисто дашбордный слой.
//
// Только PRODUCTION-позиции. Paper-стратегии (hunter paper, hunter_long, fadehot)
// — это симуляции, на дашбордный тост их не выносим (шум).

import { on } from '../modules/executor/hooks.js';
import { recordNotification } from '../core/notifyLog.js';
import { logger } from '../core/logger.js';

const SIDE_BY_STRATEGY = { hunter: 'short', hunter_long: 'long' };

function sideWord(ctx) {
  const s = ctx.side || SIDE_BY_STRATEGY[ctx.strategy] || null;
  return s ? String(s).toUpperCase() : '';
}

// Держим короче суток → минуты; дольше → часы с одним знаком.
function fmtHold(hours) {
  if (hours == null || !isFinite(hours)) return '';
  const m = Math.round(hours * 60);
  return m < 60 ? `${m}m` : `${hours.toFixed(1)}h`;
}

// Breadth-flush тикает каждые 15с, пока держится режим → edge-trigger + кулдаун,
// чтобы не заспамить тост. Пускаем только по ВХОДУ в flush и не чаще раза в 20 мин.
const FLUSH_COOLDOWN_MS = 20 * 60_000;
let flushActive = false;
let lastFlushToastAt = 0;

/** Регистрирует мост. Возвращает функцию отписки (для симметрии; в проде не зовём). */
export function startToastBridge() {
  on('afterOpen', (ctx) => {
    if (ctx.mode !== 'PRODUCTION') return;
    try {
      const side = sideWord(ctx);
      const prefix = side ? `${side} ` : '';
      const parts = [`size $${Number(ctx.sizeUsd).toFixed(2)}`];
      if (ctx.price) parts.push(`entry $${ctx.price}`);
      recordNotification({
        title: `${prefix}#${ctx.coin} opened`,
        message: parts.join(' · '),
        // green_circle/red_circle → иконка-тренд ↗/↘ на тосте (см. notifications.js)
        tags: [side === 'LONG' ? 'green_circle' : side === 'SHORT' ? 'red_circle' : 'bell'],
        priority: 2, // тихий инфо-вход
      });
    } catch (err) {
      logger.warn(`[ToastBridge] afterOpen failed: ${err.message}`);
    }
  });

  on('afterClose', (ctx) => {
    if (ctx.mode !== 'PRODUCTION') return;
    try {
      const side = sideWord(ctx);
      const prefix = side ? `${side} ` : '';
      const pnl = Number(ctx.pnl || 0);
      const pnlStr = `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`;
      const parts = [`PnL ${pnlStr}`];
      const hold = fmtHold(ctx.holdHours);
      if (hold) parts.push(`held ${hold}`);
      if (ctx.reason) parts.push(String(ctx.reason));
      recordNotification({
        title: `${prefix}#${ctx.coin} closed`,
        message: parts.join(' · '),
        // Профит → зелёный (ok), убыток → красный (danger) через priority≥4.
        tags: [pnl >= 0 ? 'white_check_mark' : 'rotating_light'],
        priority: pnl >= 0 ? 3 : 4,
      });
    } catch (err) {
      logger.warn(`[ToastBridge] afterClose failed: ${err.message}`);
    }
  });
}

/**
 * Вызывать из места расчёта breadth-flush каждый тик с текущим состоянием.
 * Тост только по фронту (вход в flush) и не чаще кулдауна.
 * @param {{active:boolean, dir:'up'|'down'|null, share:number, n:number}} flush
 */
export function reportBreadthFlush(flush) {
  const active = !!flush?.active;
  if (!active) { flushActive = false; return; }
  if (flushActive) return; // уже в режиме — молчим до выхода и повторного входа
  flushActive = true;

  const now = Date.now();
  if (now - lastFlushToastAt < FLUSH_COOLDOWN_MS) return;
  lastFlushToastAt = now;

  const down = flush.dir === 'down';
  const arrow = down ? '▼' : '▲';
  const sharePct = flush.share != null ? Math.round(flush.share * 100) : null;
  try {
    recordNotification({
      title: `Breadth flush ${arrow}`,
      message:
        (sharePct != null ? `${sharePct}% монет ${down ? 'валятся' : 'летят'}` : 'широкий сдвиг') +
        ` · ${down ? 'risk-off' : 'risk-on'} · будильник`,
      tags: ['snowflake'], // → янтарный warn-тост
      priority: 3,
    });
  } catch (err) {
    logger.warn(`[ToastBridge] flush toast failed: ${err.message}`);
  }
}
