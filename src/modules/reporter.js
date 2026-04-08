import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const TG_BASE = config.telegram.token
  ? `https://api.telegram.org/bot${config.telegram.token}`
  : null;
const TG_API = TG_BASE ? `${TG_BASE}/sendMessage` : null;

// ID последнего обработанного update (для polling)
let lastUpdateId = 0;
let pollingTimer  = null;
const POLLING_INTERVAL_MS = 5_000; // проверяем callback-кнопки раз в 5с

// ── Throttle: антиспам для повторяющихся ошибок ──
// Ключ = первые 120 символов текста → timestamp последней отправки.
// Одинаковые сообщения отправляются не чаще раза в THROTTLE_COOLDOWN_MS.
const THROTTLE_COOLDOWN_MS = 60 * 60_000; // 1 час
const throttleCache = new Map();
const THROTTLE_KEY_LEN = 120;

/**
 * Возвращает true, если сейчас "тихие часы".
 * Поддерживает перенос через полночь (23–08) и внутри суток (02–06).
 */
function isSilentHour() {
  const hour  = new Date().getHours();
  const start = config.telegram.silentStartHour;
  const end   = config.telegram.silentEndHour;

  // Диапазон с переходом через полночь (например, 23 → 08)
  if (start > end) return hour >= start || hour < end;

  // Диапазон внутри суток (например, 02 → 06)
  return hour >= start && hour < end;
}

/**
 * Базовая отправка HTML-сообщения в Telegram.
 *
 * Антиспам: идентичные (по первым 120 символам) сообщения
 * отправляются не чаще раза в час. Уникальные сообщения и
 * critical-алерты проходят всегда.
 *
 * @param {string}  text
 * @param {boolean} [critical=false] — критичное: всегда со звуком, без throttle
 */
export async function sendMessage(text, critical = false) {
  if (!TG_API || !config.telegram.chatId) return;

  // ── Throttle check (critical обходит) ──────────
  if (!critical) {
    const key = text.slice(0, THROTTLE_KEY_LEN);
    const lastSent = throttleCache.get(key);
    const now = Date.now();

    if (lastSent && now - lastSent < THROTTLE_COOLDOWN_MS) {
      logger.debug(
        `[Reporter] Throttled — same message sent ${Math.round((now - lastSent) / 1000)}s ago`,
      );
      return;
    }
    throttleCache.set(key, now);

    // Чистим старые записи чтобы Map не рос бесконечно (макс ~200 ключей)
    if (throttleCache.size > 200) {
      for (const [k, ts] of throttleCache) {
        if (now - ts > THROTTLE_COOLDOWN_MS) throttleCache.delete(k);
      }
    }
  }

  const silent = !critical && isSilentHour();

  try {
    await axios.post(TG_API, {
      chat_id:              config.telegram.chatId,
      text,
      parse_mode:           'HTML',
      disable_notification: silent,
    });
  } catch (err) {
    const detail = err.response?.data?.description ?? err.message;
    logger.error(`[Reporter] Telegram send failed: ${detail}`);
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
    true, // critical — будит даже ночью
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

  await sendMessageWithButton(
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

// ─────────────────────────────────────────────────
//  Сообщение с inline-кнопкой "Статус"
// ─────────────────────────────────────────────────

/**
 * Отправляет сообщение с inline-кнопкой "📊 Статус".
 * Используется для startup, shutdown и daily summary — чтобы кнопка
 * всегда была доступна в последнем сообщении.
 *
 * @param {string}  text
 * @param {boolean} [critical=false]
 */
async function sendMessageWithButton(text, critical = false) {
  if (!TG_BASE || !config.telegram.chatId) return;

  const silent = !critical && isSilentHour();

  try {
    await axios.post(`${TG_BASE}/sendMessage`, {
      chat_id:              config.telegram.chatId,
      text,
      parse_mode:           'HTML',
      disable_notification: silent,
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Статус', callback_data: 'bot_status' },
        ]],
      },
    });
  } catch (err) {
    const detail = err.response?.data?.description ?? err.message;
    logger.error(`[Reporter] Telegram sendWithButton failed: ${detail}`);
  }
}

// ─────────────────────────────────────────────────
//  Startup notification
// ─────────────────────────────────────────────────

/**
 * Отправляет уведомление о старте бота с балансом и настройками.
 *
 * @param {{ balance: number, activePosition: Object|null }} info
 */
export async function sendStartupNotification({ balance, activePosition }) {
  let posLine = '💤 Нет открытых позиций';
  if (activePosition) {
    const heldH = ((Date.now() - activePosition.entry_time) / 3_600_000).toFixed(1);
    posLine =
      `📌 Позиция: <b>#${activePosition.coin}</b>\n` +
      `💰 $${activePosition.size_usd.toFixed(2)} @ $${activePosition.entry_price}\n` +
      `📊 APY: ${activePosition.entry_apy.toFixed(2)}%\n` +
      `⏳ Удержание: ${heldH}ч`;
  }

  await sendMessageWithButton(
    `🚀 <b>${config.mode} запущен</b>\n` +
    `<code>─────────────────────</code>\n` +
    `💵 Баланс: <b>$${balance.toFixed(2)}</b>\n` +
    `🎯 Цель: APY &gt; <b>${config.trading.entryApy}%</b>\n` +
    `🛡 Выход: APY &lt; <b>${config.trading.minApy - config.trading.exitBuffer}%</b>\n` +
    `<code>─────────────────────</code>\n` +
    `${posLine}`,
    true, // critical — всегда со звуком
  );
}

// ─────────────────────────────────────────────────
//  Callback query polling (кнопка "Статус")
// ─────────────────────────────────────────────────

// Функция, которая собирает статус — устанавливается из index.js
let statusCollector = null;

/**
 * Регистрирует функцию-коллектор статуса.
 * Вызывается из index.js при старте.
 *
 * @param {Function} fn — async () => { balance, activePosition, uptime, ... }
 */
export function setStatusCollector(fn) {
  statusCollector = fn;
}

/**
 * Обрабатывает нажатие кнопки "📊 Статус".
 * Собирает свежие данные и отправляет ответ.
 */
async function handleStatusCallback(callbackQueryId) {
  // Сначала ответим на callback — иначе кнопка зависнет
  try {
    await axios.post(`${TG_BASE}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: 'Собираю данные…',
    });
  } catch {
    // не критично
  }

  if (!statusCollector) {
    await sendMessage('⚠️ Статус недоступен — бот ещё инициализируется.');
    return;
  }

  try {
    const status = await statusCollector();

    let posLine = '💤 Нет открытых позиций';
    if (status.activePosition) {
      const p     = status.activePosition;
      const heldH = ((Date.now() - p.entry_time) / 3_600_000).toFixed(1);
      posLine =
        `📌 <b>#${p.coin}</b>\n` +
        `💰 $${p.size_usd.toFixed(2)} @ $${p.entry_price}\n` +
        `📊 APY: ${p.entry_apy.toFixed(2)}%\n` +
        `⏳ Удержание: ${heldH}ч`;
    }

    await sendMessageWithButton(
      `📊 <b>Статус бота</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📡 Режим: <b>${config.mode}</b>\n` +
      `⏱ Uptime: <b>${status.uptimeMin} мин</b>\n` +
      `💵 Баланс: <b>$${status.balance.toFixed(2)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `${posLine}\n` +
      `<code>─────────────────────</code>\n` +
      `🔁 Сделок всего: <b>${status.totalTrades}</b>\n` +
      `💰 PnL: <b>${status.totalPnl >= 0 ? '+' : ''}$${status.totalPnl.toFixed(4)}</b>`,
    );
  } catch (err) {
    logger.error(`[Reporter] Status callback failed: ${err.message}`);
    await sendMessage(`⚠️ Ошибка сбора статуса: <code>${err.message}</code>`);
  }
}

/**
 * Запускает polling Telegram getUpdates для обработки callback_query.
 * Вызывается при старте бота.
 */
export function startCallbackPolling() {
  if (!TG_BASE || !config.telegram.chatId) {
    logger.info('[Reporter] Telegram not configured — callback polling disabled');
    return;
  }

  logger.info('[Reporter] Starting callback button polling');

  pollingTimer = setInterval(async () => {
    try {
      const { data } = await axios.get(`${TG_BASE}/getUpdates`, {
        params: {
          offset:          lastUpdateId + 1,
          timeout:         0,           // non-blocking
          allowed_updates: JSON.stringify(['callback_query']),
        },
        timeout: 10_000,
      });

      if (!data?.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;

        const cb = update.callback_query;
        if (cb?.data === 'bot_status') {
          logger.info(`[Reporter] Status button pressed by ${cb.from?.username ?? cb.from?.id}`);
          await handleStatusCallback(cb.id);
        }
      }
    } catch (err) {
      // Не спамим логи если Telegram лежит
      logger.debug(`[Reporter] Polling error: ${err.message}`);
    }
  }, POLLING_INTERVAL_MS);

  // Не мешаем Node.js завершиться
  if (pollingTimer.unref) pollingTimer.unref();
}

/**
 * Останавливает callback polling (для graceful shutdown).
 */
export function stopCallbackPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    logger.info('[Reporter] Callback polling stopped');
  }
}
