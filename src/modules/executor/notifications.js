// ─────────────────────────────────────────────────
//  Executor Notifications — все TG-сообщения
// ─────────────────────────────────────────────────
// Единственная зависимость — sendMessage из reporter.js.

import { sendMessage } from '../reporter.js';

// ── OPEN ───────────────────────────────────────

export async function notifyPaperOpen({ coin, sizeUsd, balance, price, apy, fee }) {
  const fire = apy > 100 ? "🔥🔥🔥 " : "";
  await sendMessage(
    `${fire}🟢 <b>[OPEN] #${coin}</b>\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (${(0.95 * 100).toFixed(0)}% от $${balance.toFixed(2)})\n` +
      `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
      `💵 Цена: $${price}\n` +
      `🏷 Fee: $${fee.toFixed(4)}`,
  );
}

export async function notifyProductionOpen({ coin, fillUsd, totalSz, avgPx, markPrice, apy, slip, effectiveLeverage, oid, dbId }) {
  const slipWarn = slip.warn ? "⚠️ " : "";
  const fire = apy > 100 ? "🔥🔥🔥 " : "";
  await sendMessage(
    `${fire}🟢 <b>[PROD OPEN] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💰 Размер: <b>$${fillUsd.toFixed(2)}</b> (${totalSz} ${coin})\n` +
      `💵 Fill: <b>$${avgPx}</b> (mark: $${markPrice})\n` +
      `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
      `📊 APY: <b>${apy.toFixed(2)}%</b>\n` +
      `⚖️ Leverage: <b>${effectiveLeverage}</b> (1x isolated)\n` +
      `🔑 OID: <code>${oid}</code> | DB: id=${dbId}`,
  );
}

// ── CLOSE ──────────────────────────────────────

export async function notifyPaperClose({ coin, holdHours, reason, pnl, fee }) {
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🔴 <b>[CLOSE] #${coin}</b>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fee: $${fee.toFixed(4)}`,
  );
}

export async function notifyProductionClose({ coin, holdHours, entryPrice, avgPx, slip, pricePnl, fundingPnl, totalFee, realizedPnl, reason, oid }) {
  const slipWarn = slip.warn ? "⚠️ " : "";
  const sign = realizedPnl >= 0 ? "+" : "";
  await sendMessage(
    `🔴 <b>[PROD CLOSE] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `⏳ Удержание: ${holdHours.toFixed(1)}ч\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → Exit: $${avgPx}\n` +
      `${slipWarn}📉 Slippage: <b>${slip.label}</b>\n` +
      `📊 Price PnL: ${pricePnl >= 0 ? "+" : ""}$${pricePnl.toFixed(4)}\n` +
      `💰 Funding PnL: +$${fundingPnl.toFixed(4)}\n` +
      `🏷 Fees: $${totalFee.toFixed(4)}\n` +
      `<b>💎 Итого: ${sign}$${realizedPnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🔑 OID: <code>${oid}</code>`,
  );
}

// ── ROTATE ─────────────────────────────────────

export async function notifyRotate({ closeCoin, openCoin, holdHours, closePnl, openSizeUsd, openApy, paybackHours, isProd }) {
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
  );
}

// ── ERRORS / ALERTS ────────────────────────────

export async function notifyOpenFailed({ coin, reason }) {
  await sendMessage(
    `🚨 <b>[OPEN FAILED] #${coin}</b>\n${reason}`,
    true,
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
  await sendMessage(
    `⚠️ <b>[OPEN SKIPPED] #${coin}</b>\n${reason}`,
    true,
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
  await sendMessage(
    `🚫 <b>[SLIPPAGE BAN] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📉 Slippage: <b>${slipLabel}</b> (порог: 1.5%)\n` +
      `⏱ Бан: <b>${banMinutes} мин</b>\n` +
      `⚠️ Торговля по ${coin} приостановлена.`,
    true,
  );
}

export async function notifyCircuitBreaker({ losses, pauseMinutes, lastCoin, lastPnl }) {
  await sendMessage(
    `🛑 <b>[CIRCUIT BREAKER]</b>\n` +
      `<code>═════════════════════</code>\n` +
      `📉 <b>${losses}</b> убыточных сделки за час\n` +
      `Последняя: <b>#${lastCoin}</b> ($${lastPnl.toFixed(4)})\n` +
      `<code>─────────────────────</code>\n` +
      `⏸ Торговля приостановлена на <b>${pauseMinutes} мин</b>\n` +
      `Бот возобновит работу автоматически.`,
    true,
  );
}

export async function notifyOpenBlocked({ coin, reason, details }) {
  await sendMessage(
    `⛔ <b>[OPEN BLOCKED] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🛡 Защита: <b>${reason}</b>\n` +
      `${details}`,
    true,
  );
}

export async function notifyOiCapBan({ coin, banMinutes = 30 }) {
  await sendMessage(
    `⚠️ <b>[OI CAP BAN] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🚫 Биржа отказала в открытии: <b>open interest at cap</b>\n` +
      `⏱ Бан: <b>${banMinutes} мин</b>\n` +
      `Бот остаётся в текущей позиции.`,
    true,
  );
}

export async function notifyOiCapAfterRotate({ closeCoin, openCoin, closePnl, banMinutes = 30 }) {
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
