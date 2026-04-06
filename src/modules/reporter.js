import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const TG_API = config.telegram.token
  ? `https://api.telegram.org/bot${config.telegram.token}/sendMessage`
  : null;

/**
 * Базовая отправка HTML-сообщения в Telegram.
 * При ошибке — логирует, не бросает исключение.
 */
export async function sendMessage(text) {
  if (!TG_API || !config.telegram.chatId) return;

  try {
    await axios.post(TG_API, {
      chat_id:    config.telegram.chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.error(`[Reporter] Telegram send failed: ${err.message}`);
  }
}

/**
 * Аномалия: APY текущей позиции резко упал за один тик.
 *
 * @param {string} coin
 * @param {number} oldApy  — APY прошлого тика
 * @param {number} newApy  — APY текущего тика
 */
export async function sendAnomalyAlert(coin, oldApy, newApy) {
  const drop = oldApy - newApy;
  const dropPct = oldApy > 0 ? (drop / oldApy) * 100 : 0;

  logger.warn(`[Reporter] Anomaly on ${coin}: APY ${oldApy.toFixed(2)}% → ${newApy.toFixed(2)}% (−${dropPct.toFixed(1)}%)`);

  await sendMessage(
    `⚠️ <b>Аномалия APY</b>\n\n` +
    `#${coin}\n` +
    `📉 <b>${oldApy.toFixed(2)}%</b> → <b>${newApy.toFixed(2)}%</b>\n` +
    `Падение: <b>−${dropPct.toFixed(1)}%</b> за 1 тик`,
  );
}

/**
 * FOMO-алерт: есть монета лучше, но ротация пока невыгодна.
 *
 * @param {string} currentCoin   — монета в позиции
 * @param {string} bestCoin      — лучший кандидат
 * @param {number} currentApy
 * @param {number} bestApy
 * @param {number} paybackHours  — сколько часов до окупаемости ротации
 */
export async function sendFomoAlert(currentCoin, bestCoin, currentApy, bestApy, paybackHours) {
  const uplift = ((bestApy - currentApy) / currentApy * 100).toFixed(1);

  logger.info(`[Reporter] FOMO: ${bestCoin} ${bestApy.toFixed(2)}% vs ${currentCoin} ${currentApy.toFixed(2)}% | payback: ${paybackHours.toFixed(1)}h`);

  await sendMessage(
    `👀 <b>FOMO Alert</b>\n\n` +
    `Держим <b>#${currentCoin}</b> @ ${currentApy.toFixed(2)}%\n` +
    `Лучший кандидат: <b>#${bestCoin}</b> @ <b>${bestApy.toFixed(2)}%</b>\n` +
    `Разница: +${uplift}% | Payback: <b>${paybackHours.toFixed(1)}ч</b>\n` +
    `<i>Ротация невыгодна — ждём.</i>`,
  );
}

/**
 * Ежедневная сводка.
 *
 * @param {{ totalTrades, winTrades, totalPnl, totalFees, bestTrade, activePosition }} stats
 */
export async function sendDailySummary(stats) {
  const { totalTrades, winTrades, totalPnl, totalFees, bestTrade, activePosition } = stats;
  const winRate  = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : '0.0';
  const pnlSign  = totalPnl >= 0 ? '+' : '';
  const netSign  = (totalPnl - totalFees) >= 0 ? '+' : '';
  const net      = totalPnl - totalFees;

  let posLine = '<i>нет</i>';
  if (activePosition) {
    const heldH = ((Date.now() - activePosition.entry_time) / 3_600_000).toFixed(1);
    posLine = `<b>#${activePosition.coin}</b> ${activePosition.entry_apy.toFixed(2)}% / ${heldH}ч`;
  }

  let bestLine = '<i>нет сделок</i>';
  if (bestTrade) {
    const s = bestTrade.realized_pnl >= 0 ? '+' : '';
    bestLine = `<b>#${bestTrade.coin}</b> ${s}$${bestTrade.realized_pnl.toFixed(4)}`;
  }

  logger.info(`[Reporter] Daily summary: trades=${totalTrades} PnL=${pnlSign}$${totalPnl.toFixed(4)} net=${netSign}$${net.toFixed(4)}`);

  await sendMessage(
    `📅 <b>Дневная сводка</b>\n` +
    `<code>─────────────────────</code>\n` +
    `🔁 Сделок: <b>${totalTrades}</b>  |  Win-rate: <b>${winRate}%</b>\n` +
    `💰 PnL: <b>${pnlSign}$${totalPnl.toFixed(4)}</b>\n` +
    `🏷 Комиссии: <b>$${totalFees.toFixed(4)}</b>\n` +
    `📊 Чистый доход: <b>${netSign}$${net.toFixed(4)}</b>\n` +
    `<code>─────────────────────</code>\n` +
    `🏆 Лучшая сделка: ${bestLine}\n` +
    `📌 Позиция: ${posLine}`,
  );
}
