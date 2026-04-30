// ─────────────────────────────────────────────────
//  Executor Notifications — все TG-сообщения
// ─────────────────────────────────────────────────
// Единственная зависимость — sendMessage из reporter.js.

import { sendMessage } from '../reporter.js';
import { logger } from '../../core/logger.js';

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

// ── SNIPER (maker-only exits, PAPER) ──────────

export async function notifySniperArmed({ coin, armPrice, reason, windowMinutes }) {
  await sendMessage(
    `🎯 <b>[SNIPER ARMED] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📍 Limit @ <b>$${armPrice}</b>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `⏱ Окно: <b>${windowMinutes}мин</b>\n` +
      `<i>Ждём maker-fill. Если не зальётся — fallback на market.</i>`
  );
}

export async function notifySniperFilled({ coin, armPrice, waitMinutes, reason, pnl, fee, feeSavedVsMarket }) {
  const sign = pnl >= 0 ? "+" : "";
  const savedSign = feeSavedVsMarket >= 0 ? "+" : "";
  await sendMessage(
    `🎯✅ <b>[SNIPER FILLED] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `📍 Fill @ $${armPrice} (waited ${waitMinutes}мин)\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fee: $${fee.toFixed(4)}\n` +
      `💎 Saved vs market: <b>${savedSign}$${feeSavedVsMarket.toFixed(4)}</b>`
  );
}

export async function notifySniperTimeout({ coin, armPrice, fallbackPrice, reason, pnl, fee }) {
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯⏰ <b>[SNIPER TIMEOUT → MARKET] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `📍 Arm @ $${armPrice} → fallback @ $${fallbackPrice}\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fee: $${fee.toFixed(4)}\n` +
      `<i>Maker-limit не залился за 15мин — ушли в market.</i>`
  );
}

// ── SNIPER (PROD — реальный Alo на бирже, Iter 3) ──

export async function notifySniperArmedProd({ coin, armPrice, orderId, sz, reason, windowMinutes }) {
  await sendMessage(
    `🎯 <b>[PROD SNIPER ARMED] #${coin}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `📍 Alo BUY reduce_only @ <b>$${armPrice}</b>\n` +
      `📦 Size: ${sz} ${coin}\n` +
      `🔑 OID: <code>${orderId}</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `⏱ Окно: <b>${windowMinutes}мин</b>\n` +
      `<i>Maker-only post. Если зальётся — экономим taker fee + slippage.\n` +
      `Если нет — fallback на market.</i>\n` +
      `<code>─────────────────────</code>\n` +
      `⚠️ <b>Если хочешь закрыть руками — сначала отмени ордер <code>${orderId}</code> в Hyperliquid UI</b>, иначе бот запишет в БД неправильный PnL (думая что наш Alo залился по $${armPrice}).`,
    true,
  );
}

export async function notifySniperFilledProd({
  coin, armPrice, fillPx, waitMinutes, reason, holdHours,
  pricePnl, fundingPnl, fee, pnl, fundingSource, feeSavedVsMarket,
}) {
  const sign = pnl >= 0 ? '+' : '';
  const fSign = fundingPnl >= 0 ? '+' : '';
  const pSign = pricePnl >= 0 ? '+' : '';
  const sSign = feeSavedVsMarket >= 0 ? '+' : '';
  await sendMessage(
    `🎯✅ <b>[PROD SNIPER FILLED] #${coin}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `📍 Arm $${armPrice} → Fill <b>$${fillPx}</b>\n` +
      `⏱ Wait: ${waitMinutes}мин | Hold: ${holdHours.toFixed(1)}ч\n` +
      `<code>─────────────────────</code>\n` +
      `📊 Price PnL: ${pSign}$${pricePnl.toFixed(4)}\n` +
      `💰 Funding PnL: ${fSign}$${fundingPnl.toFixed(4)} (${fundingSource})\n` +
      `🏷 Fee (entry taker + exit maker): $${fee.toFixed(4)}\n` +
      `<b>💎 Итого: ${sign}$${pnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💎 Saved vs market: <b>${sSign}$${feeSavedVsMarket.toFixed(4)}</b>`,
    true,
  );
}

export async function notifySniperTimeoutProd({ coin, armPrice, fallbackPrice, reason, pnl, holdHours }) {
  const sign = pnl >= 0 ? '+' : '';
  await sendMessage(
    `🎯⏰ <b>[PROD SNIPER TIMEOUT → MARKET] #${coin}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `📍 Arm $${armPrice} → fallback @ $${fallbackPrice}\n` +
      `⏳ Hold: ${holdHours.toFixed(1)}ч\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `<i>Maker-limit не залился за окно — ушли в market.</i>`,
    true,
  );
}

export async function notifySniperAdverseAbort({
  coin, armPrice, currentPrice, driftBps, reason, waitMinutes, pnl, isProd,
}) {
  const sign = pnl >= 0 ? '+' : '';
  const tag = isProd ? 'PROD SNIPER ADVERSE' : 'SNIPER ADVERSE';
  await sendMessage(
    `🎯📉 <b>[${tag} → MARKET] #${coin}</b>\n` +
      `<code>═════════════════════</code>\n` +
      `📈 Причина: <b>${reason}</b>\n` +
      `📍 Arm $${armPrice} → mark $${currentPrice}\n` +
      `📊 Drift: <b>+${driftBps.toFixed(1)}bps</b> (порог ${30}bps)\n` +
      `⏱ Wait: ${waitMinutes}мин\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `<i>Цена ушла против шорта — режем maker-окно, идём в market не дожидаясь таймаута.</i>`,
    true,
  );
}

export async function notifySniperArmFailed({ coin, reason }) {
  await sendMessage(
    `⚠️ <b>[PROD SNIPER ARM FAILED] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `Причина: <code>${reason}</code>\n` +
      `<i>Откатываюсь на market-close (productionClose).</i>`,
    true,
  );
}

// ── SNIPER-HUNTER (Strategy #3: Volatility Spike Mean-Reversion) ──

export async function notifyHunterOpen({ coin, sizeUsd, balance, price, spikePct, sl, tp, fee }) {
  await sendMessage(
    `🎯 <b>[HUNTER OPEN SHORT] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💥 Спайк: <b>+${spikePct.toFixed(2)}%</b> за 2мин\n` +
      `💰 Размер: <b>$${sizeUsd.toFixed(2)}</b> (50% от $${balance.toFixed(2)})\n` +
      `💵 Entry: <b>$${price}</b>\n` +
      `🛑 SL: $${sl.toFixed(6)} <i>(+2%)</i>\n` +
      `🎯 TP: $${tp.toFixed(6)} <i>(-3%)</i>\n` +
      `🏷 Entry fee: $${fee.toFixed(4)}`
  );
}

export async function notifyHunterSL({ coin, entryPrice, slPrice, pnl, fee, holdMinutes }) {
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯🛑 <b>[HUNTER SL] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → SL: $${slPrice.toFixed(6)}\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      `<i>Цена пошла против шорта — режем убыток.</i>`
  );
}

export async function notifyHunterTP({ coin, entryPrice, tpPrice, pnl, fee, holdMinutes }) {
  const sign = pnl >= 0 ? "+" : "";
  await sendMessage(
    `🎯✅ <b>[HUNTER TP] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: $${entryPrice} → TP: $${tpPrice.toFixed(6)}\n` +
      `⏳ Hold: <b>${holdMinutes}мин</b>\n` +
      `💰 PnL: <b>${sign}$${pnl.toFixed(4)}</b>\n` +
      `🏷 Fees: $${fee.toFixed(4)}\n` +
      `<i>Mean-reversion отработал. Охотник доволен.</i>`
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
  if (shouldThrottle(`${coin}_open_blocked`)) return;
  await sendMessage(
    `⛔ <b>[OPEN BLOCKED] #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🛡 Защита: <b>${reason}</b>\n` +
      `${details}`
  );
}

export async function notifyOiCapBan({ coin, banMinutes = 30 }) {
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
