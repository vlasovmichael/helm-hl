import { readFile } from 'fs/promises';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, closePosition as dbClosePosition } from '../core/database.js';
import { sendMessage } from './reporter.js';
import { checkAccountLeverage } from './exchange.js';
import { restoreCircuitBreaker, restoreSniper, restoreOiCapBans } from './executor/state.js';
import { hlInfo } from '../core/hlClient.js';

import { state as appState } from '../app/state.js';

const BOT_STATE_PATH = 'data/bot_state.json';

// ─────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────

/**
 * Читает и валидирует bot_state.json.
 *
 * Проверяет:
 *  - наличие файла (ENOENT → первый запуск, не ошибка)
 *  - корректность JSON (SyntaxError → файл повреждён при записи)
 *  - наличие обязательных полей (saved_at, mode)
 *  - свежесть стейта (предупреждение если > 24ч)
 *
 * @returns {Object|null}
 */
async function loadBotState() {
  logger.info(`[Sync] Loading state file: ${BOT_STATE_PATH}…`);

  let raw;
  try {
    raw = await readFile(BOT_STATE_PATH, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.info('[Sync] ℹ️  No bot_state.json — first launch or clean environment');
    } else {
      logger.warn(`[Sync] ⚠️  Cannot read bot_state.json: ${err.message}`);
    }
    return null;
  }

  // JSON integrity
  let state;
  try {
    state = JSON.parse(raw);
  } catch (parseErr) {
    logger.error(
      `[Sync] ❌ bot_state.json is corrupted (JSON parse failed): ${parseErr.message}. ` +
      `File will be ignored — run will continue without state.`,
    );
    return null;
  }

  // Schema validation — минимально необходимые поля
  const REQUIRED_FIELDS = ['saved_at', 'mode', 'reason'];
  const missing = REQUIRED_FIELDS.filter((f) => state[f] == null);
  if (missing.length > 0) {
    logger.warn(
      `[Sync] ⚠️  bot_state.json is missing required fields: [${missing.join(', ')}]. ` +
      `State will be ignored.`,
    );
    return null;
  }

  // Staleness check
  const ageSec  = Math.round((Date.now() - state.saved_at) / 1000);
  const ageStr  = ageSec < 60
    ? `${ageSec}s`
    : ageSec < 3600
      ? `${Math.round(ageSec / 60)}m`
      : `${(ageSec / 3600).toFixed(1)}h`;

  const posInfo = state.active_position
    ? `position=#${state.active_position.coin} held=${state.active_position.held_minutes}min`
    : 'no position';

  logger.info(
    `[Sync] ✅ State loaded — age: ${ageStr} | mode: ${state.mode} | reason: ${state.reason} | ${posInfo}`,
  );

  if (ageSec > 86_400) {
    logger.warn(
      `[Sync] ⚠️  State is ${(ageSec / 3600).toFixed(1)}h old — data may be stale. ` +
      `Exchange sync will resolve any discrepancies.`,
    );
  }

  // Восстанавливаем Smart Alerts состояние (предотвращает повторный Recap/FOMO на рестарте)
  if (state.daily_recap_sent_date) {
    appState.dailyRecapSentDate = state.daily_recap_sent_date;
    logger.info(`[Sync] Restored dailyRecapSentDate: ${appState.dailyRecapSentDate}`);
  }
  if (state.last_fomo_alert) {
    appState.lastFomoAlert = state.last_fomo_alert;
    logger.info(`[Sync] Restored lastFomoAlert: ${new Date(appState.lastFomoAlert).toLocaleTimeString()}`);
  }

  return state;
}

/**
 * Запрашивает открытые позиции на Hyperliquid через clearinghouseState.
 *
 * Ответ содержит assetPositions — массив объектов:
 * {
 *   type: "oneWay",
 *   position: {
 *     coin: "ETH",
 *     szi: "0.5",           // size с знаком (- = short)
 *     entryPx: "3500.0",
 *     positionValue: "1750.0",
 *     unrealizedPnl: "10.5",
 *     liquidationPx: "2800.0",
 *     cumFunding: { allTime: "5.2", sinceOpen: "2.1", sinceChange: "0.5" }
 *   }
 * }
 *
 * @returns {Promise<Array<{ coin, szi, entryPx, positionValue, unrealizedPnl }>>}
 */
export async function fetchExchangePositions() {
  const wallet = config.wallet.address;
  logger.info(`[Sync] Querying clearinghouseState for ${wallet.slice(0, 8)}…`);

  const t0 = Date.now();
  try {
    const data = await hlInfo(
      { type: 'clearinghouseState', user: wallet },
      { label: 'sync/clearinghouse' },
    );
    const rtt = Date.now() - t0;

    const assetPositions = data?.assetPositions;

    if (!Array.isArray(assetPositions)) {
      logger.warn(
        `[Sync] ❌ Unexpected clearinghouseState shape (RTT: ${rtt}ms): ` +
        JSON.stringify(data).slice(0, 200),
      );
      return [];
    }

    // Фильтруем позиции с ненулевым размером
    const positions = [];
    for (const ap of assetPositions) {
      const pos = ap?.position;
      if (!pos) continue;

      const szi = parseFloat(pos.szi ?? '0');
      if (szi === 0) continue;

      positions.push({
        coin:          pos.coin,
        szi,
        entryPx:       parseFloat(pos.entryPx      ?? '0'),
        positionValue: parseFloat(pos.positionValue ?? '0'),
        unrealizedPnl: parseFloat(pos.unrealizedPnl ?? '0'),
        liquidationPx: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
      });
    }

    const total = assetPositions.filter((ap) => ap?.position).length;
    logger.info(
      `[Sync] ✅ Exchange response in ${rtt}ms — ` +
      `${total} total slots, ${positions.length} open` +
      (positions.length > 0
        ? `: [${positions.map((p) => `${p.coin}(${p.szi > 0 ? '+' : ''}${p.szi})`).join(', ')}]`
        : ''),
    );

    return positions;
  } catch (err) {
    const rtt = Date.now() - t0;
    logger.error(`[Sync] ❌ Exchange fetch failed (RTT: ${rtt}ms): ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────
//  Сценарии синхронизации
// ─────────────────────────────────────────────────

/**
 * Match: позиция есть и локально, и на бирже.
 */
async function handleMatch(dbPosition, exchangePos) {
  const heldH = ((Date.now() - dbPosition.entry_time) / 3_600_000).toFixed(1);

  logger.info(
    `[Sync] ✅ MATCH — #${dbPosition.coin} | ` +
    `DB entry: $${dbPosition.entry_price} | Exchange entry: $${exchangePos.entryPx} | ` +
    `held: ${heldH}h | unrealizedPnl: $${exchangePos.unrealizedPnl.toFixed(4)}`,
  );

  await sendMessage(
    `🔄 <b>[SYNC] Позиция подтверждена</b>\n` +
    `<code>─────────────────────</code>\n` +
    `📌 #${dbPosition.coin}\n` +
    `💰 $${dbPosition.size_usd.toFixed(2)} @ $${dbPosition.entry_price}\n` +
    `📊 APY на входе: ${dbPosition.entry_apy.toFixed(2)}%\n` +
    `⏳ Удержание: ${heldH}ч\n` +
    `💵 Unrealized PnL: $${exchangePos.unrealizedPnl.toFixed(4)}\n` +
    `✅ Продолжаю сопровождение.`,
  );
}

/**
 * Mismatch: локально позиция OPEN, но на бирже её нет.
 * Сделка была закрыта пока бот был оффлайн (SL/TP/ликвидация).
 *
 * КРИТИЧНО: закрываем стейл-запись в БД, иначе бот навсегда застрянет
 * в режиме "позиция уже есть" и не сможет открыть новую.
 */
async function handleMismatch(dbPosition) {
  const heldH = ((Date.now() - dbPosition.entry_time) / 3_600_000).toFixed(1);

  logger.error(
    `[Sync] ⚠️ MISMATCH — #${dbPosition.coin} is OPEN in DB but NOT on exchange! ` +
    `Position was closed while bot was offline. Held: ${heldH}h`,
  );

  // ── Закрываем stale DB-позицию ───────────────
  // PnL неизвестен — пользователь должен сверить вручную с биржей.
  let dbClosed = false;
  try {
    dbClosePosition(dbPosition.id, {
      close_price:  0,
      realized_pnl: 0,
      fee_paid:     0,
      reason:       'closed_offline',
    });
    dbClosed = true;
    logger.info(
      `[Sync] ✅ Stale DB position #${dbPosition.coin} (id=${dbPosition.id}) marked as closed_offline`,
    );
  } catch (err) {
    logger.error(
      `[Sync] ❌ Failed to close stale DB position #${dbPosition.coin}: ${err.message}. ` +
      `Bot may remain stuck — manual DB cleanup required!`,
    );
  }

  // CRITICAL alert — всегда со звуком
  const dbStatusLine = dbClosed
    ? `🤖 БД синхронизирована. Бот свободен для новых сделок.`
    : `❌ <b>БД НЕ СИНХРОНИЗИРОВАНА!</b> Требуется ручная очистка.`;

  await sendMessage(
    `🚨 <b>[SYNC] ЧП! Сделка закрыта оффлайн</b>\n` +
    `<code>─────────────────────</code>\n` +
    `⚠️ Пока бот был выключен, позиция была закрыта!\n\n` +
    `📌 #${dbPosition.coin}\n` +
    `💰 $${dbPosition.size_usd.toFixed(2)} @ $${dbPosition.entry_price}\n` +
    `📊 APY: ${dbPosition.entry_apy.toFixed(2)}%\n` +
    `⏳ Удержание до выключения: ${heldH}ч\n` +
    `<code>─────────────────────</code>\n` +
    `❗️ Причина: <b>TP/SL или Ликвидация</b>\n` +
    `🔍 <b>Проверь баланс и историю на бирже!</b>\n` +
    `<code>─────────────────────</code>\n` +
    `${dbStatusLine}`,
    true, // critical
  );
}

/**
 * Orphaned Position: на бирже есть позиция, которой нет под управлением бота.
 * Hands-off режим: НЕ усыновляем, флагируем как "ручную" — бот паузится
 * до тех пор, пока оператор не закроет позицию руками.
 */
export async function handleOrphaned(exchangePos) {
  const sizeUsd = Math.abs(exchangePos.szi) * exchangePos.entryPx;
  const side    = exchangePos.szi < 0 ? 'SHORT' : 'LONG';

  logger.warn(
    `[Sync] 🖐 Manual ${side} detected on startup — #${exchangePos.coin} ` +
    `szi=${exchangePos.szi} entry=$${exchangePos.entryPx} size=$${sizeUsd.toFixed(2)} ` +
    `uPnL=$${exchangePos.unrealizedPnl.toFixed(4)} — bot paused (hands-off)`,
  );

  appState.manualPositionActive = true;
  appState.manualPositionCoins.add(exchangePos.coin);
  appState.manualWarningThrottle.set(exchangePos.coin, Date.now());

  // TG-уведомление о ручной позиции на старте убрано (2026-06-09): ручная
  // торговля — основной режим оператора, поза видна на дашборде/бирже. Лог выше
  // остаётся для диагностики.

  return null;
}

// ─────────────────────────────────────────────────
//  PAPER sync (без биржи — только локальные данные)
// ─────────────────────────────────────────────────

async function syncPaper() {
  const dbPosition = getActivePosition();
  const botState   = await loadBotState();

  // Нет позиции нигде — чистый старт
  if (!dbPosition && !botState?.active_position) {
    logger.info('[Sync] PAPER — clean start, no positions');
    return;
  }

  // Позиция в БД — продолжаем (источник истины для PAPER)
  if (dbPosition) {
    const heldH = ((Date.now() - dbPosition.entry_time) / 3_600_000).toFixed(1);
    logger.info(
      `[Sync] PAPER — resuming #${dbPosition.coin} ` +
      `($${dbPosition.size_usd.toFixed(2)} @ ${dbPosition.entry_apy.toFixed(2)}% APY, held ${heldH}h)`,
    );

    await sendMessage(
      `🔄 <b>[SYNC] PAPER — позиция восстановлена</b>\n` +
      `📌 #${dbPosition.coin} | $${dbPosition.size_usd.toFixed(2)}\n` +
      `📊 APY: ${dbPosition.entry_apy.toFixed(2)}%\n` +
      `⏳ Удержание: ${heldH}ч\n` +
      `✅ Продолжаю сопровождение.`,
    );
    return;
  }

  // bot_state.json говорит что была позиция, но в БД её нет
  // (возможно, БД была потеряна или позиция закрылась некорректно)
  if (botState?.active_position && !dbPosition) {
    const sp = botState.active_position;
    logger.warn(
      `[Sync] PAPER — bot_state.json has position #${sp.coin} but DB has no OPEN position. ` +
      `Position may have been closed outside normal flow.`,
    );

    await sendMessage(
      `⚠️ <b>[SYNC] PAPER — рассинхрон стейта</b>\n` +
      `<code>─────────────────────</code>\n` +
      `📄 bot_state.json: #${sp.coin} ($${sp.size_usd.toFixed(2)})\n` +
      `🗄 БД: нет открытых позиций\n` +
      `<code>─────────────────────</code>\n` +
      `ℹ️ Позиция могла быть закрыта вне штатного процесса.\n` +
      `🤖 Бот стартует без позиции.`,
      true,
    );
  }
}

// ─────────────────────────────────────────────────
//  PRODUCTION sync (сверка с биржей)
// ─────────────────────────────────────────────────

async function syncProduction() {
  const dbPosition        = getActivePosition();
  const botState          = await loadBotState();
  const exchangePositions = await fetchExchangePositions();

  // Монета, которую мы ведём локально
  const localCoin = dbPosition?.coin ?? botState?.active_position?.coin ?? null;

  // Ищем нашу монету на бирже (short leg delta-neutral стратегии → szi < 0)
  const matchedExPos = localCoin
    ? exchangePositions.find((p) => p.coin === localCoin)
    : null;

  // ── Сценарий 1: MATCH ────────────────────────
  if (dbPosition && matchedExPos) {
    await handleMatch(dbPosition, matchedExPos);

    // Проверяем, есть ли ещё позиции на бирже, о которых мы не знаем
    const orphaned = exchangePositions.filter(
      (p) => p.coin !== dbPosition.coin,
    );
    for (const op of orphaned) {
      await handleOrphaned(op);
    }
    return;
  }

  // ── Сценарий 2: MISMATCH ────────────────────
  // Локально есть позиция, а на бирже нет
  if (dbPosition && !matchedExPos) {
    await handleMismatch(dbPosition);

    // Проверяем orphaned — может бот переключился на другую монету вручную
    for (const op of exchangePositions) {
      await handleOrphaned(op);
    }
    return;
  }

  // ── Сценарий 3: ORPHANED ────────────────────
  // Нет локальной позиции, но на бирже что-то есть
  if (!dbPosition && exchangePositions.length > 0) {
    for (const op of exchangePositions) {
      await handleOrphaned(op);
    }
    return;
  }

  // ── Чистый старт ─────────────────────────────
  logger.info('[Sync] PRODUCTION — clean start, no positions locally or on exchange');
}

/**
 * Проверяет настройки leverage/margin mode на аккаунте при старте.
 * Логирует предупреждения если leverage > 1x или mode != cross.
 * Шлёт Telegram-алерт при обнаружении опасных настроек.
 */
async function checkLeverageSettings() {
  try {
    const leverageInfo = await checkAccountLeverage(1);

    // Ищем проблемные настройки
    const warnings = leverageInfo.filter(
      (l) => l.type !== 'isolated' || (!isNaN(l.value) && l.value > 1),
    );

    if (warnings.length > 0) {
      const lines = warnings.map(
        (w) => `⚠️ #${w.coin}: ${w.value}x ${w.type}`,
      );

      await sendMessage(
        `🚨 <b>[SYNC] Опасные настройки leverage!</b>\n` +
          `<code>─────────────────────</code>\n` +
          `${lines.join('\n')}\n` +
          `<code>─────────────────────</code>\n` +
          `⚙️ Ожидается: <b>1x isolated</b> для всех позиций.\n` +
          `❗️ Исправь вручную или бот выставит 1x при следующем OPEN.`,
        true,
      );
    }
  } catch (err) {
    logger.warn(`[Sync] Leverage check failed (non-critical): ${err.message}`);
  }
}

// ─────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────

/**
 * Синхронизация состояния бота при запуске.
 *
 * PAPER:      сверяет БД с bot_state.json (биржа не участвует).
 * PRODUCTION: запрашивает clearinghouseState и сверяет с локальными данными.
 *
 * Должна вызываться ПОСЛЕ initDB() и ДО первого tick().
 */
export async function syncWithExchange() {
  const t0 = Date.now();

  logger.info('───────────────────────────────────────────────');
  logger.info(`[Sync] Startup sync BEGIN (mode: ${config.mode})`);
  logger.info('───────────────────────────────────────────────');

  try {
    // Восстанавливаем executor-state из bot_state.json (если есть).
    const savedForRestore = await loadBotState();
    if (savedForRestore?.circuit_breaker) {
      restoreCircuitBreaker(savedForRestore.circuit_breaker);
    }
    if (savedForRestore?.sniper) {
      restoreSniper(savedForRestore.sniper);
    }
    if (savedForRestore?.oi_cap_bans) {
      restoreOiCapBans(savedForRestore.oi_cap_bans);
    }

    if (config.isProduction) {
      await syncProduction();
      await checkLeverageSettings();
    } else {
      await syncPaper();
    }

    logger.info(
      `[Sync] ✅ Startup sync COMPLETE in ${Date.now() - t0}ms`,
    );
  } catch (err) {
    logger.error(
      `[Sync] ❌ Startup sync FAILED in ${Date.now() - t0}ms: ${err.message}`,
      { stack: err.stack },
    );

    // Не даём ошибке синхронизации убить бота — только уведомляем
    await sendMessage(
      `⚠️ <b>[SYNC] Ошибка синхронизации при старте</b>\n` +
      `<code>─────────────────────</code>\n` +
      `<code>${err.message}</code>\n` +
      `<code>─────────────────────</code>\n` +
      `🤖 Бот продолжает работу. Проверь состояние вручную!`,
      true,
    );
  }

  logger.info('───────────────────────────────────────────────');
}
