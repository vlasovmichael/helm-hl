// ─────────────────────────────────────────────────
//  Executor Notifications — уведомления исполнителя
// ─────────────────────────────────────────────────
// Канал — ntfy. Маршрутизация: critical=true → пуш со звуком мимо тихого часа,
// остальное — строка в лог.
//
// 🚨 Тела notify*-функций не трогать: они в торговом пути. Канал подменён в
// локальном sendMessage() ниже, поэтому разметка в текстах осталась
// телеграмной — теги снимает htmlToPlain.

import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { recordNotification } from '../../core/notifyLog.js';
import { fireNtfy } from '../../core/ntfy.js';

/** Снимает HTML-разметку: ntfy показывает текст как есть. */
function htmlToPlain(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * @param {string} text — размеченный текст
 * @param {boolean} critical — true = риск-алерт → пуш на телефон
 */
async function sendMessage(text, critical = false) {
  const plain = htmlToPlain(text);
  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines[0] || 'Alert';
  const body = lines.slice(1).join('\n');

  if (!critical) {
    logger.info(`[Notify] ${title}${body ? ` — ${lines.slice(1).join(' · ')}` : ''}`);
    return;
  }

  logger.warn(`[Notify] 🚨 ${title}`);
  await fireNtfy({
    title,
    message: body,
    tags: ['rotating_light'],
    urgent: true,
  });
}

// ─────────────────────────────────────────────────
//  Throttle для повторяющихся алертов
// ─────────────────────────────────────────────────
// Бот тикает каждые 15с — без throttle'а Volatility/OI Cap/Circuit Breaker
// заспамят TG. Логика: для конкретного key (coin+reason) шлём в TG не чаще
// раза в 30 мин. В консоль (logger.info) пишем КАЖДЫЙ раз — для traceability.

const ALERT_THROTTLE_MS = 30 * 60_000;
const sentAlertsMap = new Map();

/**
 * Возвращает true, если алерт с таким ключом был отправлен в последние 30 мин.
 * Если false — обновляет timestamp и разрешает отправку.
 */
function shouldThrottle(key) {
  const now = Date.now();
  const last = sentAlertsMap.get(key);
  if (last && now - last < ALERT_THROTTLE_MS) {
    return true;
  }
  sentAlertsMap.set(key, now);
  // Лёгкая периодическая чистка протухших ключей
  if (sentAlertsMap.size > 200) {
    for (const [k, t] of sentAlertsMap) {
      if (now - t > ALERT_THROTTLE_MS) sentAlertsMap.delete(k);
    }
  }
  return false;
}

// Гейт уведомлений о жизненном цикле сделок (open/close/SL/TP). По умолчанию OFF
// (TG_TRADE_NOTIFICATIONS). Не влияет на ошибки/CB/drawdown/внешнее закрытие.
function tradeAlertsOff() {
  return !config.alerts.trade;
}

// ── OPEN ───────────────────────────────────────

// ── CLOSE ──────────────────────────────────────

export async function notifyPaperClose({ coin, holdHours, reason, pnl, fee, side = 'short' }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  const sideTag = side.toUpperCase();
  await sendMessage(
    `🔴 <b>[CLOSE ${sideTag}] #${coin}</b>\n` +
      `📈 Reason: <b>${reason}</b>\n` +
      `⏳ Held: ${holdHours.toFixed(1)}h\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fee: $${fee.toFixed(4)}`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyProductionClose({ coin, holdHours, entryPrice, avgPx, slip, pricePnl, fundingPnl, totalFee, realizedPnl, reason, oid, side = 'short' }) {
  if (tradeAlertsOff()) return;
  const slipWarn = slip.warn ? "⚠️ " : "";
  const sign = realizedPnl >= 0 ? "+" : "";
  const sideTag = side.toUpperCase();
  await sendMessage(
    `🔴 <b>[PROD CLOSE ${sideTag}] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📈 Reason: <b>${reason}</b>\n` +
      `⏳ Held: ${holdHours.toFixed(1)}h\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → Exit: $${avgPx}\n` +
      `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
      `📊 Price PnL: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)}\n` +
      `💰 Funding PnL: ${fundingPnl >= 0 ? "+" : ""}$${fundingPnl.toFixed(4)}\n` +
      `🏷 Fees: $${totalFee.toFixed(4)}\n` +
      `<b>💎 Total: ${sign}$${realizedPnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🔑 OID: <code>${oid}</code>`,
    false,
    { bypassThrottle: true },
  );
}

// ── SNIPER-HUNTER (Strategy #3: Volatility Spike Mean-Reversion) ──

// ── HUNTER LONG (Strategy #3 mirror: Long-after-dump, Iter E) ──

// ── ROTATE ─────────────────────────────────────

// ── ERRORS / ALERTS ────────────────────────────

export async function notifyCloseFailed({ coin, error, positionStillOpen }) {
  const warning = positionStillOpen
    ? `\n\n⚠️ <b>The position is still open!</b> Close it by hand!`
    : '';
  await sendMessage(
    `🚨 <b>[CLOSE FAILED] #${coin}</b>\n${error}${warning}`,
    true,
  );
}

export async function notifyCloseRejected({ coin, error }) {
  await sendMessage(
    `🚨 <b>[CLOSE REJECTED] #${coin}</b>\n` +
      `The exchange rejected the order:\n<code>${error}</code>\n\n` +
      `⚠️ <b>The position is still open!</b> Close it by hand!`,
    true,
  );
}

export async function notifyExternalClose({ coin, sizeUsd, entryPrice, holdHours, estimatedPnl, equity }) {
  const sign = estimatedPnl >= 0 ? '+' : '';
  const emoji = estimatedPnl >= 0 ? '📈' : '📉';
  await sendMessage(
    `⚠️ <b>POSITION CLOSED EXTERNALLY</b>\n` +
      `<code>═════════════════════</code>\n` +
      `🔍 <b>#${coin}</b> was closed on the exchange side\n` +
      `<i>(detected while attempting a CLOSE)</i>\n` +
      `<code>─────────────────────</code>\n` +
      `💰 Size: <b>$${sizeUsd.toFixed(2)}</b>\n` +
      `💵 Entry: <b>$${entryPrice}</b>\n` +
      `⏳ Held: <b>${holdHours.toFixed(1)}h</b>\n` +
      `${emoji} PnL (estimated): <b>${sign}$${estimatedPnl.toFixed(4)}</b>\n` +
      `💰 Equity: <b>$${equity.toFixed(2)}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `🤖 DB synced. The bot is free.`,
    true,
  );
  // Тост на дашборде: ручное закрытие на бирже (external) идёт мимо afterClose,
  // поэтому тост вешаем отдельно здесь. Без телефона (recordNotification).
  try {
    const pnl = Number(estimatedPnl || 0);
    const pnlStr = `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`;
    const parts = [`PnL ${pnlStr}`];
    if (holdHours != null) {
      const m = Math.round(holdHours * 60);
      parts.push(`held ${m < 60 ? `${m}m` : `${holdHours.toFixed(1)}h`}`);
    }
    parts.push('external close');
    recordNotification({
      title: `#${coin} closed`,
      message: parts.join(' · '),
      tags: [pnl >= 0 ? 'white_check_mark' : 'rotating_light'],
      priority: pnl >= 0 ? 3 : 4,
    });
  } catch (err) {
    logger.warn(`[Notify] external-close toast failed: ${err.message}`);
  }
}

export async function notifySlippageBan({ coin, slipLabel, banMinutes }) {
  if (!config.alerts.noisy) return;
  if (shouldThrottle(`${coin}_slippage_ban`)) return;
  await sendMessage(
    `🚫 <b>[SLIPPAGE BAN] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📉 Slippage: <b>${slipLabel}</b> (threshold: 1.5%)\n` +
      `⏱ Ban: <b>${banMinutes} min</b>\n` +
      `⚠️ Trading in ${coin} is paused.`,
    false, // бан по проскальзыванию — рабочий шум, не риск денег
  );
}

export async function notifyCircuitBreaker(payload = {}) {
  // TG-уведомление о circuit breaker убрано по запросу. Само срабатывание CB
  // по-прежнему логируется в paper.js/production.js ([Executor] 🛑 CIRCUIT
  // BREAKER TRIPPED ...) и видно в статусе через getCircuitBreakerStatus().
  // Но на ДАШБОРД (тост+колокольчик, без телефона) выносим — это risk-событие.
  try {
    const { losses, pauseMinutes, lastCoin, lastPnl } = payload;
    const parts = [];
    if (losses != null) parts.push(`${losses} losses in a row`);
    if (pauseMinutes != null) parts.push(`paused ${pauseMinutes}m`);
    if (lastCoin) parts.push(`last #${lastCoin} ${lastPnl >= 0 ? '+' : '−'}$${Math.abs(lastPnl ?? 0).toFixed(2)}`);
    recordNotification({
      title: 'Circuit breaker tripped',
      message: parts.join(' · ') || 'trading paused',
      tags: ['rotating_light'], // → красный danger-тост
      priority: 5,
    });
  } catch (err) {
    logger.warn(`[Notify] CB toast failed: ${err.message}`);
  }
}
