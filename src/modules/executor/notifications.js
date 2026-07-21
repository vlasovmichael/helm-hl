// ─────────────────────────────────────────────────
//  Executor Notifications — все TG-сообщения
// ─────────────────────────────────────────────────
// Единственная зависимость — sendMessage из reporter.js.

import { sendMessage } from '../reporter.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { recordNotification } from '../../core/notifyLog.js';

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
  return !config.telegram.tradeNotifications;
}

// ── OPEN ───────────────────────────────────────

export async function notifyPaperOpen({ coin, sizeUsd, balance, price, apy, fee, side = 'short' }) {
  if (tradeAlertsOff()) return;
  const fire = apy > 100 ? "🔥🔥🔥 " : "";
  const sideTag = side.toUpperCase();
  await sendMessage(
    `${fire}🟢 <b>[OPEN ${sideTag}] #${coin}</b>\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (${(0.95 * 100).toFixed(0)}% от $${balance.toFixed(2)})\n` +
      `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
      `💵 Цена: $${price}\n` +
      `🏷 Fee: $${fee.toFixed(4)}`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyProductionOpen({ coin, fillUsd, totalSz, avgPx, markPrice, apy, slip, effectiveLeverage, oid, dbId, side = 'short' }) {
  if (tradeAlertsOff()) return;
  const slipWarn = slip.warn ? "⚠️ " : "";
  const fire = apy > 100 ? "🔥🔥🔥 " : "";
  const sideTag = side.toUpperCase();
  await sendMessage(
    `${fire}🟢 <b>[PROD OPEN ${sideTag}] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💰 Размер: <b>$${fillUsd.toFixed(2)}</b> (${totalSz} ${coin})\n` +
      `💵 Fill: <b>$${avgPx}</b> (mark: $${markPrice})\n` +
      `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
      `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
      `⚖️ Leverage: <b>${effectiveLeverage}</b> (1x isolated)\n` +
      `🔑 OID: <code>${oid}</code> | DB: id=${dbId}`,
    false,
    { bypassThrottle: true },
  );
}

// ── CLOSE ──────────────────────────────────────

export async function notifyPaperClose({ coin, holdHours, reason, pnl, fee, side = 'short' }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  const sideTag = side.toUpperCase();
  await sendMessage(
    `🔴 <b>[CLOSE ${sideTag}] #${coin}</b>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
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
      `📈 Причина: <b>${reason}</b>\n` +
      `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → Exit: $${avgPx}\n` +
      `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
      `📊 Price PnL: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)}\n` +
      `💰 Funding PnL: ${fundingPnl >= 0 ? "+" : ""}$${fundingPnl.toFixed(4)}\n` +
      `🏷 Fees: $${totalFee.toFixed(4)}\n` +
      `<b>💎 Итого: ${sign}$${realizedPnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🔑 OID: <code>${oid}</code>`,
    false,
    { bypassThrottle: true },
  );
}

// ── SNIPER-HUNTER (Strategy #3: Volatility Spike Mean-Reversion) ──

export async function notifyHunterOpen({ coin, sizeUsd, balance, price, spikePct, sl, tp, fee }) {
  if (tradeAlertsOff()) return;
  await sendMessage(
    `🎯 <b>[HUNTER OPEN SHORT] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💥 Спайк: <b>+${spikePct.toFixed(2)}%</b> за 2мин\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (50% от $${balance.toFixed(2)})\n` +
      `💵 Entry: <b>$${price}</b>\n` +
      `🛑 SL: $${sl.toFixed(6)} <i>(+2%)</i>\n` +
      `🎯 TP: $${tp.toFixed(6)} <i>(-3%)</i>\n` +
      `🏷 Entry fee: $${fee.toFixed(4)}`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyHunterOpenProd({ coin, sizeUsd, balance, leverage, fillPx, markPrice, spikePct, sl, tp, slOid, tpOid, slipLabel, fee }) {
  if (tradeAlertsOff()) return;
  const levSuffix = leverage > 1 ? ` × <b>${leverage}x</b>` : '';
  await sendMessage(
    `🎯🔫 <b>[HUNTER PROD OPEN SHORT] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💥 Спайк: <b>+${spikePct.toFixed(2)}%</b> за 2мин\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (50% от $${balance.toFixed(2)}${levSuffix})\n` +
      `💵 Mark→Fill: $${markPrice} → <b>$${fillPx}</b> <i>(${slipLabel})</i>\n` +
      `🛑 SL: $${sl.toFixed(6)} <i>(+2%, oid=${slOid})</i>\n` +
      `🎯 TP: $${tp.toFixed(6)} <i>(−3%, oid=${tpOid})</i>\n` +
      `🏷 Entry fee: $${fee.toFixed(4)}\n` +
      `<i>Триггеры стоят на бирже. Бот ждёт fill любого.</i>`,
    true,
  );
}

export async function notifyHunterOpenFailed({ coin, stage, reason, rolledBack, fill = null, rollback = null }) {
  // fill: { sizeUsd, fillPx, sz } — если успели открыться до фейла
  // rollback: { closePx, pnl, fee } — если был market close
  const fillLine = fill
    ? `📥 Open: <b>${fill.sz}</b> @ $${fill.fillPx} ($${fill.sizeUsd.toFixed(2)})\n`
    : '';
  const rbLine = rollback
    ? `📤 Rollback close @ $${rollback.closePx} | PnL: <b>${rollback.pnl >= 0 ? '+' : ''}$${rollback.pnl.toFixed(4)}</b> (fees $${rollback.fee.toFixed(4)})\n`
    : '';
  await sendMessage(
    `🎯⚠️ <b>[HUNTER PROD FAIL] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `Стадия: <b>${stage}</b>\n` +
      `Причина: <code>${reason}</code>\n` +
      fillLine +
      rbLine +
      (rolledBack
        ? `<i>Позиция закрыта по market — без SL остаться нельзя.</i>`
        : `<i>Позиция не открылась — ничего не сделано.</i>`),
    true,
  );
}

export async function notifyHunterSL({ coin, entryPrice, slPrice, pnl, fee, holdMinutes }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯🛑 <b>[HUNTER SL] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → SL: $${slPrice.toFixed(6)}\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      `<i>Цена пошла против шорта — режем убыток.</i>`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyHunterTP({ coin, entryPrice, tpPrice, pnl, fee, holdMinutes }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯✅ <b>[HUNTER TP] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → TP: $${tpPrice.toFixed(6)}\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      `<i>Mean-reversion отработал. Охотник доволен.</i>`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyHunterTrailTp({ coin, entryPrice, closePrice, peakPct, giveBackPct, pnl, fee, holdMinutes, fixedTpPrice }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  const realPct = entryPrice ? ((entryPrice - closePrice) / entryPrice) * 100 : 0;
  const fixedTpPct = (fixedTpPrice && entryPrice) ? ((entryPrice - fixedTpPrice) / entryPrice) * 100 : null;
  const deltaLine = fixedTpPct !== null
    ? `📊 vs fixed TP: <b>+${(realPct - fixedTpPct).toFixed(2)}пп</b> (peak +${peakPct.toFixed(2)}%, дали ${giveBackPct.toFixed(0)}%)\n`
    : `📊 peak: +${peakPct.toFixed(2)}% | дали обратно ${giveBackPct.toFixed(0)}%\n`;
  await sendMessage(
    `🎯🎢 <b>[HUNTER TRAIL TP] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → Close: $${closePrice.toFixed(6)} (+${realPct.toFixed(2)}%)\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      deltaLine +
      `<i>Trailing TP: цена ушла глубже fixed TP, поймали хвост.</i>`,
    false,
    { bypassThrottle: true },
  );
}

// ── HUNTER LONG (Strategy #3 mirror: Long-after-dump, Iter E) ──

export async function notifyHunterLongOpen({ coin, sizeUsd, balance, price, dumpPct, sl, tp, fee }) {
  if (tradeAlertsOff()) return;
  await sendMessage(
    `🎯 <b>[HUNTER OPEN LONG] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📉 Дамп: <b>${dumpPct.toFixed(2)}%</b> за 2мин\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (50% от $${balance.toFixed(2)})\n` +
      `💵 Entry: <b>$${price}</b>\n` +
      `🛑 SL: $${sl.toFixed(6)} <i>(−2%)</i>\n` +
      `🎯 TP: $${tp.toFixed(6)} <i>(+3%)</i>\n` +
      `🏷 Entry fee: $${fee.toFixed(4)}`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyHunterLongOpenProd({ coin, sizeUsd, balance, leverage, fillPx, markPrice, dumpPct, sl, tp, slOid, tpOid, slipLabel, fee }) {
  if (tradeAlertsOff()) return;
  const levSuffix = leverage > 1 ? ` × <b>${leverage}x</b>` : '';
  await sendMessage(
    `🎯🔫 <b>[HUNTER PROD OPEN LONG] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📉 Дамп: <b>${dumpPct.toFixed(2)}%</b> за 2мин\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (50% от $${balance.toFixed(2)}${levSuffix})\n` +
      `💵 Mark→Fill: $${markPrice} → <b>$${fillPx}</b> <i>(${slipLabel})</i>\n` +
      `🛑 SL: $${sl.toFixed(6)} <i>(−2%, oid=${slOid})</i>\n` +
      `🎯 TP: $${tp.toFixed(6)} <i>(+3%, oid=${tpOid})</i>\n` +
      `🏷 Entry fee: $${fee.toFixed(4)}\n` +
      `<i>Триггеры стоят на бирже. Бот ждёт отскок.</i>`,
    true,
  );
}

export async function notifyHunterLongOpenFailed({ coin, stage, reason, rolledBack, fill = null, rollback = null }) {
  const fillLine = fill
    ? `📥 Open: <b>${fill.sz}</b> @ $${fill.fillPx} ($${fill.sizeUsd.toFixed(2)})\n`
    : '';
  const rbLine = rollback
    ? `📤 Rollback close @ $${rollback.closePx} | PnL: <b>${rollback.pnl >= 0 ? '+' : ''}$${rollback.pnl.toFixed(4)}</b> (fees $${rollback.fee.toFixed(4)})\n`
    : '';
  await sendMessage(
    `🎯⚠️ <b>[HUNTER LONG PROD FAIL] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `Стадия: <b>${stage}</b>\n` +
      `Причина: <code>${reason}</code>\n` +
      fillLine +
      rbLine +
      (rolledBack
        ? `<i>Позиция закрыта по market — без SL остаться нельзя.</i>`
        : `<i>Позиция не открылась — ничего не сделано.</i>`),
    true,
  );
}

export async function notifyHunterLongSL({ coin, entryPrice, slPrice, pnl, fee, holdMinutes }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯🛑 <b>[HUNTER LONG SL] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → SL: $${slPrice.toFixed(6)}\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      `<i>Дамп продолжился — ловили нож. Режем.</i>`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyHunterLongTP({ coin, entryPrice, tpPrice, pnl, fee, holdMinutes }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯✅ <b>[HUNTER LONG TP] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → TP: $${tpPrice.toFixed(6)}\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      `<i>Отскок отработал. Купили дно — продали верх.</i>`,
    false,
    { bypassThrottle: true },
  );
}

export async function notifyHunterLongTrailTp({ coin, entryPrice, closePrice, peakPct, giveBackPct, pnl, fee, holdMinutes, fixedTpPrice }) {
  if (tradeAlertsOff()) return;
  const sign = pnl >= 0 ? "+" : "";
  const realPct = entryPrice ? ((closePrice - entryPrice) / entryPrice) * 100 : 0;
  const fixedTpPct = (fixedTpPrice && entryPrice) ? ((fixedTpPrice - entryPrice) / entryPrice) * 100 : null;
  const deltaLine = fixedTpPct !== null
    ? `📊 vs fixed TP: <b>${realPct >= fixedTpPct ? '+' : ''}${(realPct - fixedTpPct).toFixed(2)}пп</b> (peak +${peakPct.toFixed(2)}%, дали ${giveBackPct.toFixed(0)}%)\n`
    : `📊 peak: +${peakPct.toFixed(2)}% | дали обратно ${giveBackPct.toFixed(0)}%\n`;
  await sendMessage(
    `🎯🎢 <b>[HUNTER LONG TRAIL TP] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → Close: $${closePrice.toFixed(6)} (+${realPct.toFixed(2)}%)\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      deltaLine +
      `<i>Trailing TP: отскок ушёл глубже fixed TP, поймали хвост.</i>`,
    false,
    { bypassThrottle: true },
  );
}

// ── ROTATE ─────────────────────────────────────

export async function notifyRotate({ closeCoin, openCoin, holdHours, closePnl, openSizeUsd, openApy, paybackHours, isProd }) {
  if (tradeAlertsOff()) return;
  const prefix = isProd ? "PROD ROTATE" : "ROTATE";
  const sep = isProd ? "═" : "─";
  const closePnlSign = closePnl >= 0 ? "+" : "";
  await sendMessage(
    `🔄 <b>[${prefix}]</b> ${closeCoin} → <b>${openCoin}</b>\n` +
      `<code>${sep.repeat(21)}</code>\n` +
      `🔴 Закрыл: <b>#${closeCoin}</b> (${holdHours.toFixed(1)}ч)\n` +
      `💰 PnL: <b>${closePnlSign}$${closePnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🟢 Открыл: <b>#${openCoin}</b>\n` +
      `💰 Размер: <b>$${openSizeUsd.toFixed(2)}</b>\n` +
      `📊 APY: <b>${openApy.toFixed(2)}%</b>\n` +
      `⏱ Payback: ${paybackHours}h`,
    false,
    { bypassThrottle: true },
  );
}

// ── ERRORS / ALERTS ────────────────────────────

export async function notifyOpenFailed({ coin, reason }) {
  if (shouldThrottle(`${coin}_open_failed`)) return;
  await sendMessage(
    `🚨 <b>[OPEN FAILED] #${coin}</b>\n${reason}`
  );
}

export async function notifyOpenRejected({ coin, error, sz, price, banMinutes }) {
  await sendMessage(
    `🚨 <b>[OPEN REJECTED] #${coin}</b>\n` +
      `Биржа отклонила ордер:\n<code>${error}</code>\n\n` +
      `Запрошено: ${sz} ${coin} (~$${(sz * price).toFixed(2)})\n` +
      `⏱ Бан: ${banMinutes} мин`,
    true,
  );
}

export async function notifyOpenSkipped({ coin, reason }) {
  if (!config.telegram.notifications) return;
  if (shouldThrottle(`${coin}_open_skipped`)) return;
  await sendMessage(
    `⚠️ <b>[OPEN SKIPPED] #${coin}</b>\n${reason}`
  );
}

export async function notifyCloseFailed({ coin, error, positionStillOpen }) {
  const warning = positionStillOpen
    ? `\n\n⚠️ <b>Позиция всё ещё открыта!</b> Закрой вручную!`
    : '';
  await sendMessage(
    `🚨 <b>[CLOSE FAILED] #${coin}</b>\n${error}${warning}`,
    true,
  );
}

export async function notifyCloseRejected({ coin, error }) {
  await sendMessage(
    `🚨 <b>[CLOSE REJECTED] #${coin}</b>\n` +
      `Биржа отклонила ордер:\n<code>${error}</code>\n\n` +
      `⚠️ <b>Позиция всё ещё открыта!</b> Закрой вручную!`,
    true,
  );
}

export async function notifyExternalClose({ coin, sizeUsd, entryPrice, holdHours, estimatedPnl, equity }) {
  const sign = estimatedPnl >= 0 ? '+' : '';
  const emoji = estimatedPnl >= 0 ? '📈' : '📉';
  await sendMessage(
    `⚠️ <b>ВНЕШНЕЕ ЗАКРЫТИЕ ПОЗИЦИИ</b>\n` +
      `<code>═════════════════════</code>\n` +
      `🔍 <b>#${coin}</b> закрыт на стороне биржи\n` +
      `<i>(обнаружено при попытке CLOSE)</i>\n` +
      `<code>─────────────────────</code>\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b>\n` +
      `💵 Entry: <b>$${entryPrice}</b>\n` +
      `⏳ Удержание: <b>${holdHours.toFixed(1)}ч</b>\n` +
      `${emoji} PnL (оценка): <b>${sign}$${estimatedPnl.toFixed(4)}</b>\n` +
      `💰 Equity: <b>$${equity.toFixed(2)}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `🤖 БД синхронизирована. Бот свободен.`,
    true,
  );
}

export async function notifySlippageBan({ coin, slipLabel, banMinutes }) {
  if (!config.telegram.notifications) return;
  if (shouldThrottle(`${coin}_slippage_ban`)) return;
  await sendMessage(
    `🚫 <b>[SLIPPAGE BAN] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📉 Slippage: <b>${slipLabel}</b> (порог: 1.5%)\n` +
      `⏱ Бан: <b>${banMinutes} мин</b>\n` +
      `⚠️ Торговля по ${coin} приостановлена.`,
    true,
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

export async function notifyOpenBlocked({ coin, reason, details }) {
  if (!config.telegram.notifications) return;
  if (shouldThrottle(`${coin}_open_blocked`)) return;
  await sendMessage(
    `⛔ <b>[OPEN BLOCKED] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🛡 Защита: <b>${reason}</b>\n` +
      `${details}`
  );
}

export async function notifyOiCapBan({ coin, banMinutes = 30 }) {
  if (!config.telegram.notifications) return;
  if (shouldThrottle(`${coin}_oicap`)) return;
  await sendMessage(
    `⚠️ <b>[OI CAP BAN] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🚫 Биржа отказала в открытии: <b>open interest at cap</b>\n` +
      `⏱ Бан: <b>${banMinutes} мин</b>\n` +
      `Бот остаётся в текущей позиции.`
  );
}


export async function notifyOiCapAfterRotate({ closeCoin, openCoin, closePnl, banMinutes = 30 }) {
  if (shouldThrottle(`${openCoin}_oicap`)) return;
  const sign = closePnl >= 0 ? "+" : "";
  await sendMessage(
    `🚨 <b>[ROTATE FAILED — OI CAP]</b>\n` +
      `<code>═════════════════════</code>\n` +
      `🔴 Закрыл: <b>#${closeCoin}</b> ✅\n` +
      `💰 PnL: ${sign}$${closePnl.toFixed(4)}\n` +
      `<code>─────────────────────</code>\n` +
      `🟢 Открыть: <b>#${openCoin}</b> ❌ open interest at cap\n` +
      `<code>═════════════════════</code>\n` +
      `🚫 <b>#${openCoin}</b> забанен на <b>${banMinutes} мин</b>\n` +
      `⚠️ Бот остался <b>БЕЗ ПОЗИЦИИ</b>. Подыщет другую в след. тике.`,
    true,
  );
}


export async function notifyDrawdownBreached({ equity, sessionStart, drawdownPct }) {
  await sendMessage(
    `🚨🚨🚨 <b>[MAX DRAWDOWN BREACHED]</b>\n` +
      `<code>═════════════════════</code>\n` +
      `💰 Стартовый equity: <b>$${sessionStart.toFixed(2)}</b>\n` +
      `💰 Текущий equity:   <b>$${equity.toFixed(2)}</b>\n` +
      `📉 Drawdown: <b>-${drawdownPct.toFixed(2)}%</b>\n` +
      `<code>─────────────────────</code>\n` +
      `⛔ Открытие новых позиций <b>ЗАБЛОКИРОВАНО</b>\n` +
      `до перезапуска бота.\n` +
      `Проверь стратегию и рынок.`,
    true,
  );
  // На дашборд (тост+колокольчик) — это уже идёт на телефон (риск-алерт), дублируем
  // в журнал для тоста. recordNotification не шлёт повторно на ntfy.
  try {
    recordNotification({
      title: 'Max drawdown breached',
      message: `equity $${equity.toFixed(2)} · −${drawdownPct.toFixed(2)}% · new opens blocked`,
      tags: ['rotating_light'],
      priority: 5,
    });
  } catch (err) {
    logger.warn(`[Notify] drawdown toast failed: ${err.message}`);
  }
}

export async function notifyRotateFailed({ closeCoin, openCoin, closePnl, phase }) {
  if (phase === 'close') {
    await sendMessage(
      `🚨 <b>[ROTATE ABORTED]</b> ${closeCoin} → ${openCoin}\n` +
        `Close не удался — позиция <b>#${closeCoin}</b> осталась открытой.\n` +
        `Бот продолжает сопровождение.`,
      true,
    );
  } else {
    const sign = closePnl >= 0 ? "+" : "";
    await sendMessage(
      `🚨🚨🚨 <b>[ROTATE FAILED — БОТ БЕЗ ПОЗИЦИИ]</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🔴 Закрыл: <b>#${closeCoin}</b> ✅\n` +
        `💰 PnL: ${sign}$${closePnl.toFixed(4)}\n` +
        `<code>─────────────────────</code>\n` +
        `🟢 Открыть: <b>#${openCoin}</b> ❌ ПРОВАЛ\n` +
        `<code>═════════════════════</code>\n` +
        `⚠️ Бот остался <b>БЕЗ ПОЗИЦИИ</b>!\n` +
        `Средства свободны. Бот попробует войти\n` +
        `в следующем тике автоматически.`,
      true,
    );
  }
}
