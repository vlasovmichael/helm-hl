// ─────────────────────────────────────────────────
// WS Exit Tick — выходы на WS-тиках
// ─────────────────────────────────────────────────
// 15-сек поллинг просыпает внутри-тиковые вики. Этот лёгкий цикл считает выходы
// АКТИВНОЙ позиции на живых WS-ценах (HL_WS_EXIT_INTERVAL_MS, default 2с).
//
// Scope: все adopt- и manual_paper-позы. 🚨 Сопровождение ручной позы не должно
// зависеть от здоровья сканера: когда 15-сек тик раздувает затором весового
// бюджета до минут, пол трейла столько же стоит выше цены без закрытия.
//
// Безопасность:
// • Re-use, не дублируем: та же coordinate→analyzeHunter(Long) с
// синтетическим one-coin массивом, где price = живая WS-цена.
// • Mutex: делим state.tickRunning с главным тиком. Claim синхронный (без
// await до установки флага) → двойного close быть не может.
// • Floor: при выключенном фиде / протухшей цене — no-op, ведёт поллинг.
// • Gated: HL_WS_EXITS_ENABLED (default OFF), требует поднятого WS-фида.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getLivePrice, isFeedFresh } from '../core/priceFeed.js';
import { superviseAdoptPositions } from './adoptSupervise.js';
import { superviseManualPaperPositions } from './manualPaperSupervise.js';
import { state } from './state.js';

// Стратегии, чьи выходы переводим на WS-тики. Остальные остаются на 15-сек tick.

// Живую цену старше этого порога считаем протухшей → не действуем (floor).
const MAX_PRICE_AGE_MS = 10_000;

let timer = null;

// Сколько тик может держать мьютекс, прежде чем мы признаем его залипшим и
// перестанем ждать. 60с = 4 нормальных периода: обычный тик укладывается в
// секунды, а залипший держал мьютекс 5 минут — и всё это
// время трейл ручной позы не считался НИ здесь, ни там.
const STUCK_TICK_MS = 60_000;
let adoptRunning = false;
let stuckWarnedAt = 0;

/**
 * Сопровождение adopt/manual_paper поз на WS-кадрах.
 *
 * Владелец в норме — этот проход (раз в 2с). Пока идёт обычный tick(), мы
 * уступаем ему: он делает тот же superviseAdoptPositions сам, и два писателя
 * по одной позиции не нужны. Но если тик залип дольше STUCK_TICK_MS — идём
 * вперёд без него: залипший тик по определению стоит в сканере, а не в
 * adopt-логике, и цена ручной позы важнее чистоты мьютекса.
 *
 * Экспортируется ради тестов; в проде дёргается тем же таймером.
 */
export async function adoptFastPass() {
  if (!config.trading.wsFeedEnabled) return;
  if (adoptRunning || state.shuttingDown) return;
  if (!isFeedFresh()) return;

  if (state.tickRunning) {
    const heldMs = Date.now() - (state.tickRunningSince || Date.now());
    if (heldMs < STUCK_TICK_MS) return; // норма: тик работает, он и ведёт позы
    if (Date.now() - stuckWarnedAt > 60_000) {
      stuckWarnedAt = Date.now();
      logger.warn(
        `[WSExit] тик держит мьютекс ${Math.round(heldMs / 1000)}с — веду adopt-позы сам, ` +
        'не дожидаясь его',
      );
    }
  }

  adoptRunning = true;
  try {
    // Цена только из WS: на 2-сек цикле HTTP-фолбэк дал бы лишний вес каждой
    // позе каждые 2 секунды. Нет свежей цены в фиде → просто ждём кадра.
    await superviseAdoptPositions(wsPriceOnly);
    await superviseManualPaperPositions(wsPriceOnly);
  } catch (err) {
    logger.warn(`[WSExit] adopt-проход: ${err.message}`);
  } finally {
    adoptRunning = false;
  }
}

/** Цена строго из WS-кэша, без HTTP. null → пропускаем позу до след. кадра. */
function wsPriceOnly(coin) {
  const live = getLivePrice(coin);
  if (!live || !(live.price > 0)) return null;
  if (Date.now() - live.ts > MAX_PRICE_AGE_MS) return null;
  return live.price;
}

/** Поднимает fast-exit таймер. Нужен поднятый WS-фид (HL_WS_FEED_ENABLED). */
export function startWsExitLoop() {
  if (!config.trading.wsFeedEnabled) {
    logger.warn(
      '[WSExit] HL_WS_FEED_ENABLED=false — фид не поднят. Сопровождение поз ' +
      '(hunter-выходы, adopt-трейл/BE) остаётся на 15-сек поллинге.',
    );
    return;
  }
  if (timer) return;
  const ms = config.trading.wsExitIntervalMs;
  timer = setInterval(() => {
    adoptFastPass().catch((err) => logger.warn(`[WSExit] adopt-loop: ${err.message}`));
  }, ms);
  logger.info(`[WSExit] started каждые ${ms}ms | ведёт adopt + manual_paper позы`);
}

/** Грейсфул-стоп (вызывается из shutdown). */
export function stopWsExitLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[WSExit] stopped');
  }
}
