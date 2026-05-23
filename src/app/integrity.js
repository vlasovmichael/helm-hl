// ─────────────────────────────────────────────────
//  Integrity Check — детектор внешнего закрытия позиций
// ─────────────────────────────────────────────────
// Каждые 60с проверяет: если в БД есть OPEN-позиция, но на бирже
// по этому тикеру позиция отсутствует, значит она была закрыта
// внешне (ADL, ликвидация, ручное действие).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, closePosition as dbClosePosition } from '../core/database.js';
import { getPositions, getAccountSummary } from '../modules/exchange.js';
import { sendMessage } from '../modules/reporter.js';
import { fetchExchangePositions } from '../modules/sync.js';
import { fetchUserFills, classifyClose } from '../modules/userFills.js';
import {
  state,
  INTEGRITY_CHECK_INTERVAL_MS,
  INTEGRITY_GRACE_PERIOD_MS,
} from './state.js';

/**
 * Утилита для надёжного сравнения тикеров.
 * Игнорирует регистр и суффиксы типа -PERP.
 */
function isSameCoin(apiCoin, targetCoin) {
  if (!apiCoin || !targetCoin) return false;
  const a = apiCoin.toLowerCase();
  const t = targetCoin.toLowerCase();
  return a === t || a === `${t}-perp` || a === `@${t}` || a.replace("-perp", "") === t;
}

/**
 * @returns {Promise<boolean>} true если позиция была закрыта внешне
 */
export async function integrityCheck() {
  if (!config.isProduction) return false;

  const now = Date.now();

  // 1. Grace period после старта бота
  if (state.botStartedAt > 0 && now - state.botStartedAt < INTEGRITY_GRACE_PERIOD_MS) {
    return false;
  }

  if (now - state.lastIntegrityCheck < INTEGRITY_CHECK_INTERVAL_MS) return false;
  state.lastIntegrityCheck = now;

  const dbPosition = getActivePosition();
  if (!dbPosition) return false;

  // 2. Grace period после ОТКРЫТИЯ позиции (даем 10с на индексацию API)
  // Это уберет ложные алерты сразу после покупки
  if (now - dbPosition.entry_time < 10_000) {
    return false;
  }

  try {
    const exchangePositions = await getPositions();

    const found = exchangePositions.find((ap) => {
      const pos = ap?.position ?? ap;
      const apiCoin = pos?.coin;
      const szi  = parseFloat(pos?.szi ?? '0');
      return isSameCoin(apiCoin, dbPosition.coin) && szi !== 0;
    });


    if (found) return false; // позиция на месте

    // ── Позиция исчезла — проверяем margin guard ──
    let equity = 0;
    let withdrawable = 0;
    let estimatedPnl = 0;
    let pnlAccurate = false;
    try {
      const summary = await getAccountSummary();
      equity       = summary.equity;
      withdrawable = summary.available;
      // Корректная оценка PnL = equity_now − equity_at_open. Старая формула
      // (equity − size_usd) сравнивала несравнимое и врала на десятки центов.
      if (Number.isFinite(dbPosition.entry_equity) && dbPosition.entry_equity > 0) {
        estimatedPnl = equity - dbPosition.entry_equity;
        pnlAccurate = true;
      } else {
        // Fallback для старых позиций (до миграции entry_equity): не показываем число
        estimatedPnl = 0;
        pnlAccurate = false;
      }
    } catch {
      // PnL неизвестен
    }

    // Margin Guard: если маржа заблокирована → скорее всего лаг API
    if (equity > 10 && withdrawable < equity * 0.5) {
      logger.warn(
        `[Integrity] ⚡ #${dbPosition.coin} not found in getPositions() but ` +
          `margin is locked: withdrawable=$${withdrawable.toFixed(2)} vs equity=$${equity.toFixed(2)} ` +
          `(${((withdrawable / equity) * 100).toFixed(1)}%). ` +
          `Likely API lag — skipping external close detection.`,
      );
      return false;
    }

    // ── Позиция действительно закрыта ──────────────
    logger.error(
      `[Integrity] ⚠️ EXTERNAL CLOSE detected: #${dbPosition.coin} is OPEN in DB ` +
        `but ABSENT on exchange! withdrawable=$${withdrawable.toFixed(2)}, equity=$${equity.toFixed(2)} ` +
        `(margin freed → position is genuinely gone)`,
    );

    const holdMs    = Date.now() - dbPosition.entry_time;
    const holdHours = holdMs / 3_600_000;

    // Classify cause через userFills (TP-trigger / SL-trigger / liquidation /
    // manual_close). Дефолт 'external_close' если fills не дали ответа.
    let closeReason = 'external_close';
    let closePx = 0;
    try {
      const fills = await fetchUserFills(dbPosition.entry_time - 60_000);
      const coinFills = fills.filter(
        (f) => f.coin.toUpperCase() === dbPosition.coin.toUpperCase(),
      );
      const c = classifyClose(dbPosition, coinFills);
      if (c.reason !== 'external_unknown') closeReason = c.reason;
      if (Number.isFinite(c.pnl)) {
        estimatedPnl = c.pnl;
        pnlAccurate  = true;  // fills дают точное число
      }
      if (Number.isFinite(c.closePx)) closePx = c.closePx;
      logger.info(
        `[Integrity] #${dbPosition.coin} classified as '${closeReason}' | ` +
          `pnl(fills)=${Number.isFinite(c.pnl) ? '$' + c.pnl.toFixed(4) : 'n/a'} | ` +
          `closePx=${closePx ? '$' + closePx : 'n/a'}`,
      );
    } catch (clsErr) {
      logger.debug(`[Integrity] classifyClose failed: ${clsErr.message}`);
    }

    dbClosePosition(dbPosition.id, {
      close_price:  closePx,
      realized_pnl: estimatedPnl,
      fee_paid:     0,
      reason:       closeReason,
    });

    logger.info(
      `[Integrity] DB position #${dbPosition.coin} (id=${dbPosition.id}) closed | ` +
        `held: ${holdHours.toFixed(1)}h | estimated PnL: $${estimatedPnl.toFixed(4)}`,
    );

    const pnlSign  = estimatedPnl >= 0 ? '+' : '';
    const pnlEmoji = estimatedPnl >= 0 ? '📈' : '📉';
    const pnlLine = pnlAccurate
      ? `${pnlEmoji} PnL (equity Δ): <b>${pnlSign}$${estimatedPnl.toFixed(4)}</b> ($${dbPosition.entry_equity.toFixed(2)} → $${equity.toFixed(2)})\n`
      : `📊 PnL: <i>точная оценка недоступна (нет entry_equity для этой позиции)</i>\n` +
        `   Смотри Hyperliquid UI или сравни с предыдущим equity вручную.\n`;

    await sendMessage(
      `⚠️ <b>ВНЕШНЕЕ ЗАКРЫТИЕ ПОЗИЦИИ</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🔍 Обнаружено расхождение:\n` +
        `<b>#${dbPosition.coin}</b> закрыт на стороне биржи\n` +
        `<i>(ADL, ликвидация или ручное действие)</i>\n` +
        `<code>─────────────────────</code>\n` +
        `💰 Размер: <b>$${dbPosition.size_usd.toFixed(2)}</b>\n` +
        `💵 Entry: <b>$${dbPosition.entry_price}</b>\n` +
        `⏳ Удержание: <b>${holdHours.toFixed(1)}ч</b>\n` +
        pnlLine +
        `💰 Equity: <b>$${equity.toFixed(2)}</b> | Withdrawable: <b>$${withdrawable.toFixed(2)}</b>\n` +
        `<code>═════════════════════</code>\n` +
        `🤖 Бот переведён в режим <b>IDLE</b>.\n` +
        `Следующий вход — в ближайшем тике.`,
      true,
    );

    return true;
  } catch (err) {
    logger.debug(`[Integrity] Check failed (non-critical): ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────
//  Manual Position Check — hands-off режим
// ─────────────────────────────────────────────────
// Каждый тик проверяет: если на бирже есть позиция, которой нет в БД бота —
// это ты торгуешь вручную (LONG или SHORT). Бот в этом случае:
//   • НЕ усыновляет позицию (ты сам управляешь exit'ом)
//   • НЕ открывает свою параллельно (паузится)
//   • Шлёт уведомление ОДИН РАЗ при входе в hands-off режим
// Когда ручная позиция исчезает с биржи → бот автоматом возвращается к торговле.

let lastOrphanCheck = 0;
const ORPHAN_CHECK_INTERVAL_MS = 60_000;  // 60с — реже чем тик чтобы не спамить API

/**
 * @returns {Promise<'paused'|false>} 'paused' если бот должен пропустить тик
 */
export async function orphanCheck() {
  if (!config.isProduction) return false;

  const now = Date.now();
  if (now - lastOrphanCheck < ORPHAN_CHECK_INTERVAL_MS) {
    // throttle активен, но если флаг уже стоит — продолжаем паузить тик
    return state.manualPositionActive ? 'paused' : false;
  }
  lastOrphanCheck = now;

  // Если в БД есть OPEN — это позиция бота, manualCheck не нужен
  // (integrityCheck уже отработал; если бы оператор открыл вторую позу на другой
  // монете — она попала бы в getPositions(), но текущая single-slot архитектура
  // запрещает второй параллельный ордер от бота, см. coordinator).
  const dbPosition = getActivePosition();

  let exchangePositions;
  try {
    exchangePositions = await fetchExchangePositions();
  } catch (err) {
    logger.debug(`[Manual] fetchExchangePositions failed: ${err.message}`);
    return state.manualPositionActive ? 'paused' : false;
  }

  // Отфильтровываем позицию бота (если есть) — остаётся только "ручное"
  const manualPositions = dbPosition
    ? exchangePositions.filter((p) => p.coin !== dbPosition.coin)
    : exchangePositions;

  // ── Ручных позиций нет ─────────────────────────
  if (manualPositions.length === 0) {
    if (state.manualPositionActive) {
      // Юзер закрыл всё руками → возврат в работу
      const coins = [...state.manualPositionCoins].join(', ');
      logger.info(`[Manual] ✅ Manual position(s) gone (${coins}) — resuming normal trading`);
      await sendMessage(
        `✅ <b>Ручные позиции закрыты</b>\n` +
          `<code>─────────────────────</code>\n` +
          `Бот возвращается к автоматической торговле.`,
        true,
      ).catch(() => {});
      state.manualPositionActive = false;
      state.manualPositionCoins.clear();
      state.manualWarningThrottle.clear();
    }
    return false;
  }

  // ── Ручные позиции есть → hands-off режим ─────
  state.manualPositionActive = true;
  const currentCoins = new Set(manualPositions.map((p) => p.coin));
  state.manualPositionCoins = currentCoins;

  // Уведомление шлём ОДИН РАЗ на коин — пока оператор не закроет позицию.
  // throttle Map используется как "notified set": если запись уже есть,
  // молчим. При закрытии всех ручных позиций map очищается (см. ветку выше),
  // следующая открытая поза снова получит уведомление.
  // Прошлая версия слала каждые 30 мин — раздражало без причины, оператор и так
  // видит позицию на бирже / дашборде.
  for (const exPos of manualPositions) {
    if (!state.manualWarningThrottle.has(exPos.coin)) {
      state.manualWarningThrottle.set(exPos.coin, now);
      const side = exPos.szi < 0 ? 'SHORT' : 'LONG';
      const sizeUsd = Math.abs(exPos.szi) * exPos.entryPx;
      logger.warn(
        `[Manual] 🖐 Manual ${side} detected #${exPos.coin} szi=${exPos.szi} entry=$${exPos.entryPx} — bot paused`,
      );
      await sendMessage(
        `🖐 <b>Ручная позиция #${exPos.coin} (${side})</b>\n` +
          `<code>─────────────────────</code>\n` +
          `📐 Размер: <b>${Math.abs(exPos.szi)} ${exPos.coin}</b> (~$${sizeUsd.toFixed(2)})\n` +
          `💵 Entry: <b>$${exPos.entryPx}</b>\n` +
          `💰 uPnL: <b>$${exPos.unrealizedPnl.toFixed(4)}</b>\n` +
          `<code>─────────────────────</code>\n` +
          `🤖 Бот в режиме <b>HANDS-OFF</b>: не лезет в твою позицию и не открывает свою.\n` +
          `Закрой руками — бот автоматом вернётся к работе.`,
        true,
      ).catch(() => {});
    }
  }

  return 'paused';
}
