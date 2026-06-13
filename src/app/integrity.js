// ─────────────────────────────────────────────────
//  Integrity Check — детектор внешнего закрытия позиций
// ─────────────────────────────────────────────────
// Каждые 60с проверяет: если в БД есть OPEN-позиция, но на бирже
// по этому тикеру позиция отсутствует, значит она была закрыта
// внешне (ADL, ликвидация, ручное действие).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition, getActiveAdoptPositions, closePosition as dbClosePosition } from '../core/database.js';
import { getPositionsCached, getAccountSummary } from '../modules/exchange.js';
import { sendMessage } from '../modules/reporter.js';
import { fetchExchangePositions } from '../modules/sync.js';
import { fetchUserFills, classifyClose } from '../modules/userFills.js';
import { maybeAdoptManualPosition } from './adoptReconcile.js';
import { clearAdoptState } from '../modules/strategistAdopt.js';
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
 * Проверяет ОДНУ позицию: если её нет на бирже — закрывает в БД с классификацией
 * причины и шлёт уведомление. exchangePositions/equity/withdrawable передаются
 * сверху (один fetch на весь проход, multi-position).
 * @returns {Promise<boolean>} true если позиция была закрыта внешне
 */
async function closeIfVanished(dbPosition, exchangePositions, equity, withdrawable) {
  const now = Date.now();

  // Grace period после ОТКРЫТИЯ позиции (даём 10с на индексацию API)
  if (now - dbPosition.entry_time < 10_000) return false;

  const found = exchangePositions.find((ap) => {
    const pos = ap?.position ?? ap;
    return isSameCoin(pos?.coin, dbPosition.coin) && parseFloat(pos?.szi ?? '0') !== 0;
  });
  if (found) return false; // позиция на месте

  // ── Позиция исчезла ──────────────
  // PnL = equity_now − equity_at_open (приблизительно при нескольких открытых
  // позах — точное число даёт classifyClose по fills ниже и перетирает это).
  let estimatedPnl = 0;
  let pnlAccurate = false;
  if (Number.isFinite(dbPosition.entry_equity) && dbPosition.entry_equity > 0) {
    estimatedPnl = equity - dbPosition.entry_equity;
    pnlAccurate = true;
  }

  logger.error(
    `[Integrity] ⚠️ EXTERNAL CLOSE detected: #${dbPosition.coin} is OPEN in DB ` +
      `but ABSENT on exchange! withdrawable=$${withdrawable.toFixed(2)}, equity=$${equity.toFixed(2)} ` +
      `(margin freed → position is genuinely gone)`,
  );

  const holdHours = (Date.now() - dbPosition.entry_time) / 3_600_000;

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

  // Adopt: внешнее/ручное закрытие — частый путь выхода для adopted-позы.
  // Чистим per-position trail-state, иначе peak-Map копит мусор.
  if (dbPosition.strategy_id === 'adopt') clearAdoptState(dbPosition.id);

  logger.info(
    `[Integrity] DB position #${dbPosition.coin} (id=${dbPosition.id}) closed | ` +
      `held: ${holdHours.toFixed(1)}h | estimated PnL: $${estimatedPnl.toFixed(4)}`,
  );

  const pnlSign  = estimatedPnl >= 0 ? '+' : '';
  const pnlEmoji = estimatedPnl >= 0 ? '📈' : '📉';
  const pnlLine = pnlAccurate
    ? `${pnlEmoji} PnL: <b>${pnlSign}$${estimatedPnl.toFixed(4)}</b>\n`
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
      `🤖 Слот освобождён.`,
    true,
  );

  return true;
}

/**
 * @returns {Promise<boolean>} true если хотя бы одна позиция была закрыта внешне
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

  // Слот-позиция (Hunter/carry/...) + ВСЕ adopt-позы (multi-slot). Дедуп по id.
  const slotPos = getActivePosition();
  const adoptPositions = getActiveAdoptPositions();
  const byId = new Map();
  if (slotPos) byId.set(slotPos.id, slotPos);
  for (const p of adoptPositions) byId.set(p.id, p);
  const positionsToCheck = [...byId.values()];
  if (positionsToCheck.length === 0) return false;

  try {
    const exchangePositions = await getPositionsCached();

    // Account summary один раз на проход (margin-guard + PnL fallback).
    let equity = 0;
    let withdrawable = 0;
    try {
      const summary = await getAccountSummary();
      equity       = summary.equity;
      withdrawable = summary.available;
    } catch {
      // деградируем — PnL уйдёт на fills/неизвестно, margin-guard пропустит
    }

    // Какие из проверяемых позиций реально отсутствуют в ответе биржи?
    const liveOnExchange = exchangePositions.filter(
      (ap) => parseFloat((ap?.position ?? ap)?.szi ?? '0') !== 0,
    );
    const vanished = positionsToCheck.filter(
      (db) =>
        !liveOnExchange.some((ap) =>
          isSameCoin((ap?.position ?? ap)?.coin, db.coin),
        ),
    );

    // Всё на месте → расхождения нет. Это НОРМА, пока открыты позиции — раньше
    // здесь срабатывал margin-guard и спамил варнингом каждые 60с (393×/9ч),
    // потому что withdrawable < 50% equity истинно всегда, когда деньги в позах.
    if (vanished.length === 0) return false;

    // Лаг-сигнатура индексатора: биржа вернула ПУСТО (ни одной живой позы), а
    // маржа заблокирована → позиции есть, просто API отстал. Гасим, чтобы не
    // закрыть всё ложно. Если хотя бы одна поза в ответе есть — это не общий лаг,
    // а реальное исчезновение конкретной монеты → обрабатываем ниже.
    if (
      liveOnExchange.length === 0 &&
      equity > 10 &&
      withdrawable < equity * 0.5
    ) {
      logger.warn(
        `[Integrity] ⚡ getPositions() пуст, но маржа заблокирована: ` +
          `withdrawable=$${withdrawable.toFixed(2)} vs equity=$${equity.toFixed(2)} ` +
          `(${((withdrawable / equity) * 100).toFixed(1)}%). Похоже на лаг API — skipping.`,
      );
      return false;
    }

    let anyClosed = false;
    for (const dbPosition of vanished) {
      try {
        if (await closeIfVanished(dbPosition, exchangePositions, equity, withdrawable)) {
          anyClosed = true;
        }
      } catch (err) {
        logger.debug(`[Integrity] check #${dbPosition.coin} failed: ${err.message}`);
      }
    }
    return anyClosed;
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
  // Adopt включён → проверяем каждый тик (~15с), чтобы стоп вешался на свежий
  // ручной вход почти сразу, а не через минуту незащищённого окна. Без adopt —
  // прежние 60с (детект нужен только для hands-off паузы, спешить некуда).
  const interval = config.trading.adoptEnabled ? 0 : ORPHAN_CHECK_INTERVAL_MS;
  if (now - lastOrphanCheck < interval) {
    // throttle активен, но если флаг уже стоит — продолжаем паузить тик
    return state.manualPositionActive ? 'paused' : false;
  }
  lastOrphanCheck = now;

  // Монеты, которыми бот ВЛАДЕЕТ в БД: single-slot позиция (Hunter/carry/...) +
  // ВСЕ adopt-позы (multi-slot). Их исключаем из «ручного» списка, иначе уже
  // усыновлённые adopt-монеты выглядели бы как новые ручные orphan'ы.
  const slotPos = getActivePosition();
  const adoptPositions = getActiveAdoptPositions();
  const ownedCoins = new Set();
  if (slotPos) ownedCoins.add(slotPos.coin);
  for (const p of adoptPositions) ownedCoins.add(p.coin);

  let exchangePositions;
  try {
    exchangePositions = await fetchExchangePositions();
  } catch (err) {
    logger.debug(`[Manual] fetchExchangePositions failed: ${err.message}`);
    return state.manualPositionActive ? 'paused' : false;
  }

  // Остаётся только «ручное» — позы на бирже, которых нет в БД бота
  const manualPositions = exchangePositions.filter((p) => !ownedCoins.has(p.coin));

  // ── Ручных позиций нет ─────────────────────────
  if (manualPositions.length === 0) {
    if (state.manualPositionActive) {
      // Юзер закрыл всё руками → возврат в работу. TG-уведомление убрано
      // (2026-06-13, запрос оператора): спам про ручные позиции не нужен, лог достаточно.
      const coins = [...state.manualPositionCoins].join(', ');
      logger.info(`[Manual] ✅ Manual position(s) gone (${coins}) — resuming normal trading`);
      state.manualPositionActive = false;
      state.manualPositionCoins.clear();
      state.manualWarningThrottle.clear();
    }
    return false;
  }

  // ── Adopt Mode (multi-slot, plans/adopt-mode-plan.md) ─────
  // Подхватываем ВСЕ свежие ручные позы в adopt-слоты (reduce-only стоп + ведение).
  // Условие: слот не держит БОТ-стратегия (Hunter/carry/...). Если слот свободен
  // ИЛИ держится только adopt-позами — продолжаем подхватывать новые ручные входы.
  // Усыновлённые монеты перестают быть «ручными»: убираем из manual-списка и
  // flag'ов, чтобы не словить ложное «ручные закрыты» следующим тиком.
  const botStrategyHoldsSlot = slotPos && (slotPos.strategy_id || 'carry') !== 'adopt';
  let activeManual = manualPositions;
  if (!botStrategyHoldsSlot && config.trading.adoptEnabled) {
    try {
      const adoptedCoins = await maybeAdoptManualPosition(manualPositions);
      if (adoptedCoins.length > 0) {
        const adoptedSet = new Set(adoptedCoins);
        activeManual = manualPositions.filter((p) => !adoptedSet.has(p.coin));
        for (const c of adoptedCoins) {
          state.manualPositionCoins.delete(c);
          state.manualWarningThrottle.delete(c);
        }
      }
    } catch (err) {
      logger.debug(`[Manual] adopt attempt failed: ${err.message}`);
    }
  }

  // Все ручные позы усыновлены → паузить тик не нужно: adopt-позы ведёт
  // superviseAdoptPositions(), а coordinator для adopt вернёт HOLD.
  if (activeManual.length === 0) {
    state.manualPositionActive = false;
    return false;
  }

  // ── Ручные позиции есть → hands-off режим ─────
  state.manualPositionActive = true;
  const currentCoins = new Set(activeManual.map((p) => p.coin));
  state.manualPositionCoins = currentCoins;

  // Уведомление шлём ОДИН РАЗ на коин — пока оператор не закроет позицию.
  // throttle Map используется как "notified set": если запись уже есть,
  // молчим. При закрытии всех ручных позиций map очищается (см. ветку выше),
  // следующая открытая поза снова получит уведомление.
  // Прошлая версия слала каждые 30 мин — раздражало без причины, оператор и так
  // видит позицию на бирже / дашборде.
  for (const exPos of activeManual) {
    if (!state.manualWarningThrottle.has(exPos.coin)) {
      state.manualWarningThrottle.set(exPos.coin, now);
      const side = exPos.szi < 0 ? 'SHORT' : 'LONG';
      const sizeUsd = Math.abs(exPos.szi) * exPos.entryPx;
      // TG-уведомление о ручной позиции убрано (2026-06-09): ручная торговля —
      // основной режим оператора, поза и так видна на дашборде/бирже. Оставляем
      // только лог для диагностики.
      logger.warn(
        `[Manual] 🖐 Manual ${side} detected #${exPos.coin} szi=${exPos.szi} entry=$${exPos.entryPx} (~$${sizeUsd.toFixed(2)}) — bot paused`,
      );
    }
  }

  return 'paused';
}
