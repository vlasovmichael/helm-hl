import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { formatTaxSummaryForTelegram } from './taxCollector/index.js';

/**
 * Форматирует длительность в минутах в человеко-читаемую строку.
 * 45 → "45 мин", 90 → "1ч 30м", 1500 → "1д 1ч", 10100 → "1н 0д"
 */
export function formatUptime(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
  }
  if (minutes < 10080) {
    const d = Math.floor(minutes / 1440);
    const h = Math.round((minutes % 1440) / 60);
    return h > 0 ? `${d}д ${h}ч` : `${d}д`;
  }
  const w = Math.floor(minutes / 10080);
  const d = Math.round((minutes % 10080) / 1440);
  return d > 0 ? `${w}н ${d}д` : `${w}н`;
}

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
 *
 * По умолчанию: 22:00–09:00 (настраивается через SILENT_START_HOUR / SILENT_END_HOUR).
 * В тихие часы все уведомления (кроме critical) отправляются без звука.
 *
 * Поддерживает перенос через полночь (22–09) и внутри суток (02–06).
 */
function isSilentHour() {
  const hour  = new Date().getHours();
  const start = config.telegram.silentStartHour;
  const end   = config.telegram.silentEndHour;

  // Диапазон с переходом через полночь (например, 22 → 09)
  if (start > end) return hour >= start || hour < end;

  // Диапазон внутри суток (например, 02 → 06)
  return hour >= start && hour < end;
}

/**
 * Базовая отправка HTML-сообщения в Telegram.
 *
 * Тихие часы (по умолчанию 22:00–09:00):
 *   critical=false → disable_notification=true (без звука)
 *   critical=true  → disable_notification=false (со звуком ВСЕГДА)
 *
 * Правила critical:
 *   ✅ CRITICAL (всегда со звуком):
 *     - ROTATE FAILED (бот без позиции)
 *     - CLOSE/OPEN FAILED (ордер не прошёл, ошибка API)
 *     - RECONCILE ошибка
 *     - SLIPPAGE BAN
 *     - Sync mismatch / опасные настройки leverage
 *     - Anomaly APY (падение >30% за тик)
 *
 *   ❌ НЕ critical (тишина ночью):
 *     - Штатные OPEN / CLOSE / ROTATE
 *     - Startup / Shutdown
 *     - Status / Daily summary
 *     - FOMO alert
 *
 * Антиспам: идентичные (по первым 120 символам) сообщения
 * отправляются не чаще раза в час. Critical и bypassThrottle обходят throttle.
 *
 * @param {string}  text
 * @param {boolean} [critical=false]       — аварийное: всегда со звуком, без throttle
 * @param {object}  [opts]
 * @param {boolean} [opts.bypassThrottle]  — пропустить throttle (для trade-событий),
 *                                            silent-hour при этом сохраняется
 */
export async function sendMessage(text, critical = false, opts = {}) {
  if (!TG_API || !config.telegram.chatId) return;

  const bypassThrottle = opts.bypassThrottle === true;

  // ── Throttle check (critical обходит, а также системные уведомления) ──
  const isLifecycle = text.includes('[SYSTEM]') || text.includes('[SYNC]') || text.includes('запущен');

  if (!critical && !isLifecycle && !bypassThrottle) {
    const key = text.slice(0, THROTTLE_KEY_LEN);
    const lastSent = throttleCache.get(key);
    const now = Date.now();

    if (lastSent && now - lastSent < THROTTLE_COOLDOWN_MS) {
      logger.warn(
        `[Reporter] Throttled — same message sent ${Math.round((now - lastSent) / 1000)}s ago | preview: ${text.slice(0, 60).replace(/\n/g, ' ')}`,
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
 * PnL Alert: unrealized PnL превысил порог ±3% от депозита.
 *
 * @param {{ coin: string, markPrice: number, entryPrice: number, unrealizedPnl: number, pnlPct: number, equity: number }} data
 */
export async function sendPnlAlert(data) {
  const { coin, markPrice, entryPrice, unrealizedPnl, pnlPct, equity } = data;
  const sign   = unrealizedPnl >= 0 ? '+' : '';
  const emoji  = unrealizedPnl >= 0 ? '🟢' : '🔴';
  const dir    = unrealizedPnl >= 0 ? '📈' : '📉';

  logger.info(
    `[Reporter] PnL Alert #${coin}: ${sign}$${unrealizedPnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}% of equity)`,
  );

  await sendMessage(
    `${emoji} <b>PnL Alert #${coin}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💵 Entry: <b>$${entryPrice}</b>\n` +
      `🏷 Mark: <b>$${markPrice}</b>\n` +
      `${dir} PnL: <b>${sign}$${unrealizedPnl.toFixed(4)}</b> (${sign}${pnlPct.toFixed(1)}%)\n` +
      `💰 Equity: <b>$${equity.toFixed(2)}</b>`,
  );
}

/**
 * Daily Recap (21:00) — сводка за день.
 * Отправляется только если за сутки была хотя бы одна закрытая сделка.
 *
 * @param {{ totalTrades, winTrades, totalPnl, totalFees, bestTrade, activePosition, equity, sessionProfit, sessionStartEquity }} stats
 */
export async function sendDailySummary(stats) {
  const { totalTrades, winTrades, totalPnl, totalFees, bestTrade, activePosition, equity,
    sessionProfit = 0, sessionStartEquity = 0 } = stats;

  // Нет сделок за день — не спамим
  if (totalTrades === 0) {
    logger.info('[Reporter] Daily Recap skipped — no trades today');
    return;
  }

  const winRate  = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : '0.0';
  const pnlSign  = totalPnl >= 0 ? '+' : '';
  const pnlEmoji = totalPnl >= 0 ? '📈' : '📉';
  const netSign  = (totalPnl - totalFees) >= 0 ? '+' : '';
  const net      = totalPnl - totalFees;

  let posLine = '💤 нет';
  if (activePosition) {
    const heldH = ((Date.now() - activePosition.entry_time) / 3_600_000).toFixed(1);
    posLine = `<b>#${activePosition.coin}</b> ${activePosition.entry_apy.toFixed(2)}% / ${heldH}ч`;
  }

  let bestLine = '—';
  if (bestTrade) {
    const s = bestTrade.realized_pnl >= 0 ? '+' : '';
    bestLine = `<b>#${bestTrade.coin}</b> ${s}$${bestTrade.realized_pnl.toFixed(4)}`;
  }

  const balanceLine = equity > 0
    ? `💰 Баланс: <b>$${equity.toFixed(2)}</b>\n`
    : '';

  // Session Profit
  const spSign  = sessionProfit >= 0 ? '+' : '';
  const spEmoji = sessionProfit >= 0 ? '💚' : '❤️';
  const spPct   = sessionStartEquity > 0
    ? ` (${spSign}${((sessionProfit / sessionStartEquity) * 100).toFixed(2)}%)`
    : '';
  const sessionLine = sessionStartEquity > 0
    ? `${spEmoji} Session Profit: <b>${spSign}$${sessionProfit.toFixed(4)}</b>${spPct}\n`
    : '';

  logger.info(
    `[Reporter] Daily Recap: trades=${totalTrades} PnL=${pnlSign}$${totalPnl.toFixed(4)} ` +
      `net=${netSign}$${net.toFixed(4)} session=${spSign}$${sessionProfit.toFixed(4)}`,
  );

  await sendMessageWithButton(
    `📅 <b>Daily Recap</b>\n` +
    `<code>─────────────────────</code>\n` +
    `🔁 Сделок: <b>${totalTrades}</b>  |  Win-rate: <b>${winRate}%</b>\n` +
    `${pnlEmoji} PnL: <b>${pnlSign}$${totalPnl.toFixed(4)}</b>\n` +
    `🏷 Комиссии: <b>$${totalFees.toFixed(4)}</b>\n` +
    `💎 Чистый доход: <b>${netSign}$${net.toFixed(4)}</b>\n` +
    `<code>─────────────────────</code>\n` +
    `${balanceLine}` +
    `${sessionLine}` +
    `🏆 Лучшая: ${bestLine}\n` +
    `📌 Позиция: ${posLine}`,
  );
}

/**
 * Сводка за период (неделя/месяц).
 *
 * @param {{ label: string, trades: Array, equity: number }} stats
 */
export async function sendPeriodSummary({ label, trades, equity }) {
  if (!trades || trades.length === 0) {
    logger.info(`[Reporter] ${label} recap skipped — no trades in period`);
    return;
  }

  const totalTrades = trades.length;
  const winTrades   = trades.filter((t) => t.realized_pnl > 0).length;
  const totalPnl    = trades.reduce((s, t) => s + t.realized_pnl, 0);
  const totalFees   = trades.reduce((s, t) => s + t.fee_paid, 0);
  const net         = totalPnl - totalFees;
  const winRate     = ((winTrades / totalTrades) * 100).toFixed(1);
  const pnlSign     = totalPnl >= 0 ? '+' : '';
  const netSign     = net >= 0 ? '+' : '';
  const pnlEmoji    = totalPnl >= 0 ? '📈' : '📉';

  const carryTrades = trades.filter((t) => (t.strategy_id || 'carry') === 'carry').length;
  const fadeTrades  = trades.filter((t) => t.strategy_id === 'fade').length;
  const stratLine   = fadeTrades > 0
    ? `🏷 Carry: <b>${carryTrades}</b> | Fade: <b>${fadeTrades}</b>\n`
    : '';

  const bestTrade = trades.reduce(
    (best, t) => (!best || t.realized_pnl > best.realized_pnl ? t : best),
    null,
  );
  const bestSign = bestTrade && bestTrade.realized_pnl >= 0 ? '+' : '';
  const bestLine = bestTrade
    ? `<b>#${bestTrade.coin}</b> ${bestSign}$${bestTrade.realized_pnl.toFixed(4)}`
    : '—';

  const balanceLine = equity > 0
    ? `💰 Баланс: <b>$${equity.toFixed(2)}</b>\n`
    : '';

  logger.info(
    `[Reporter] ${label} recap: trades=${totalTrades} PnL=${pnlSign}$${totalPnl.toFixed(4)} net=${netSign}$${net.toFixed(4)}`,
  );

  await sendMessage(
    `${label} <b>Сводка</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🔁 Сделок: <b>${totalTrades}</b>  |  Win-rate: <b>${winRate}%</b>\n` +
      `${stratLine}` +
      `${pnlEmoji} PnL: <b>${pnlSign}$${totalPnl.toFixed(4)}</b>\n` +
      `🏷 Комиссии: <b>$${totalFees.toFixed(4)}</b>\n` +
      `💎 Чистый: <b>${netSign}$${net.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `${balanceLine}` +
      `🏆 Лучшая: ${bestLine}`,
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
    `🚀 <b>${config.mode} запущен</b>${config.aggressive ? ' ⚡️ AGGRESSIVE' : ''}\n` +
    `<code>─────────────────────</code>\n` +
    `💵 Баланс: <b>$${balance.toFixed(2)}</b>\n` +
    `🎯 Цель: APY &gt; <b>${config.trading.entryApy}%</b>\n` +
    `🛡 Выход: APY &lt; <b>${config.trading.minApy - config.trading.exitBuffer}%</b>\n` +
    `💸 Round-trip: <b>${(config.trading.roundTrip * 100).toFixed(2)}%</b>\n` +
    `<code>─────────────────────</code>\n` +
    `${posLine}`,
    // critical=false: startup — штатная операция, тишина ночью
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
  // Если вызов от кнопки — подтверждаем callback (иначе кнопка зависнет)
  // Если вызов от /status команды — callbackQueryId будет null, пропускаем
  if (callbackQueryId) {
    try {
      await axios.post(`${TG_BASE}/answerCallbackQuery`, {
        callback_query_id: callbackQueryId,
        text: 'Собираю данные…',
      });
    } catch {
      // не критично
    }
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
      const markStr = status.markPrice != null
        ? `$${status.markPrice}`
        : 'N/A';
      posLine =
        `📌 <b>#${p.coin}</b>\n` +
        `💰 $${p.size_usd.toFixed(2)} @ $${p.entry_price}\n` +
        `📊 APY: ${p.entry_apy.toFixed(2)}%\n` +
        `🏷 Mark Price: <b>${markStr}</b>\n` +
        `⏳ Удержание: ${heldH}ч`;
    }

    const uPnlSign = status.unrealizedPnl >= 0 ? '+' : '';
    const uPnlEmoji = status.unrealizedPnl >= 0 ? '📈' : '📉';
    const rPnlSign = status.realizedPnl >= 0 ? '+' : '';
    const totalTrades = status.openTrades + status.closedTrades;

    // Session Profit (true PnL с начала сессии)
    const sp     = status.sessionProfit ?? 0;
    const spSign = sp >= 0 ? '+' : '';
    const spEmoji = sp >= 0 ? '💚' : '❤️';
    const spPct  = status.sessionStartEquity > 0
      ? ` (${spSign}${((sp / status.sessionStartEquity) * 100).toFixed(2)}%)`
      : '';

    await sendMessageWithButton(
      `📊 <b>Статус бота</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📡 Режим: <b>${config.mode}</b>\n` +
      `⏱ Uptime: <b>${formatUptime(status.uptimeMin)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `💰 Эквити: <b>$${status.equity.toFixed(2)}</b>\n` +
      `💵 Доступно: <b>$${status.available.toFixed(2)}</b>\n` +
      `${spEmoji} Session Profit: <b>${spSign}$${sp.toFixed(4)}</b>${spPct}\n` +
      `<code>─────────────────────</code>\n` +
      `${posLine}\n` +
      `${uPnlEmoji} Unrealized PnL: <b>${uPnlSign}$${status.unrealizedPnl.toFixed(4)}</b>\n` +
      `<code>─────────────────────</code>\n` +
      `🔁 Сделок: <b>${totalTrades}</b> (открытых: ${status.openTrades} | закрытых: ${status.closedTrades})\n` +
      `💰 Realized PnL: <b>${rPnlSign}$${status.realizedPnl.toFixed(4)}</b>`,
    );
  } catch (err) {
    logger.error(`[Reporter] Status callback failed: ${err.message}`);
    await sendMessage(`⚠️ Ошибка сбора статуса: <code>${err.message}</code>`);
  }
}

/**
 * Запускает polling Telegram getUpdates для обработки:
 *  - callback_query (нажатие кнопки "📊 Статус")
 *  - message        (текстовая команда /status)
 *
 * Вызывается при старте бота.
 */
export function startCallbackPolling() {
  if (!TG_BASE || !config.telegram.chatId) {
    logger.info('[Reporter] Telegram not configured — callback polling disabled');
    return;
  }

  logger.info('[Reporter] Starting callback & command polling (/status button + command)');

  pollingTimer = setInterval(async () => {
    try {
      const { data } = await axios.get(`${TG_BASE}/getUpdates`, {
        params: {
          offset:          lastUpdateId + 1,
          timeout:         0,
          allowed_updates: JSON.stringify(['callback_query', 'message']),
        },
        timeout: 10_000,
      });

      if (!data?.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // ── Кнопка "📊 Статус" ──────────────────
        const cb = update.callback_query;
        if (cb?.data === 'bot_status') {
          logger.info(`[Reporter] Status button pressed by ${cb.from?.username ?? cb.from?.id}`);
          await handleStatusCallback(cb.id);
          continue;
        }

        // ── Текстовая команда /status ────────────
        const msg = update.message;
        if (msg?.text?.startsWith('/status')) {
          // Игнорируем сообщения не из нашего чата
          if (String(msg.chat.id) !== String(config.telegram.chatId)) continue;

          logger.info(`[Reporter] /status command from ${msg.from?.username ?? msg.from?.id}`);
          await handleStatusCallback(null); // null = нет callback_query_id, просто шлём ответ
          continue;
        }

        // ── Текстовая команда /tax [year] ────────
        if (msg?.text?.startsWith('/tax')) {
          if (String(msg.chat.id) !== String(config.telegram.chatId)) continue;

          logger.info(`[Reporter] /tax command from ${msg.from?.username ?? msg.from?.id}`);

          // /tax 2025 — опциональный год
          const parts = msg.text.trim().split(/\s+/);
          const year  = parts[1] ? parseInt(parts[1], 10) : null;

          try {
            const text = await formatTaxSummaryForTelegram(year || undefined);
            await sendMessage(text);
          } catch (err) {
            logger.warn(`[Reporter] /tax handler failed: ${err.message}`);
            await sendMessage(`⚠️ Tax summary error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.debug(`[Reporter] Polling error: ${err.message}`);
    }
  }, POLLING_INTERVAL_MS);

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
