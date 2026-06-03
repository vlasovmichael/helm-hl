// ─────────────────────────────────────────────────
//  WS Entry Tick — Stage 3: входы на WS-тиках
// ─────────────────────────────────────────────────
//
// ⚠️ Поведение-меняющая стадия. Открывает hunter / hunter_long БЫСТРЕЕ, чем
// 15-сек скан: ловит спайк, сформировавшийся ВНУТРИ 15-сек окна. Это про
// «войти раньше», т.е. про частоту/тайминг входов — в tension с принципом
// «WS = точность выходов, не способ торговать больше» (ws_price_feed_plan.md).
// Включать ТОЛЬКО осознанно, после Stage 1/2 на проде. Default OFF.
//
// Как работает (re-use, без дублирования entry-логики):
//   • «current» цена = живая WS-цена (synth-массив поверх последнего hunter-
//     снапшота state.latestHunter, где price заменён на WS). Funding/OI/vol —
//     из снапшота (15-сек старые, но эти поля не быстрые).
//   • «2-мин референс» спайка = priceHistory (наполняется 15-сек сканом). Его
//     разрешения ±15с хватает; priceHistory из WS НЕ кормим (взрыв памяти на
//     ~600 монет без функц. выгоды — current и так из WS напрямую).
//   • Зовём те же analyzeHunter / analyzeHunterLong (entry-ветка). Вся фильтрация
//     (cooldown / post-SL / cross-cooldown / trend-gate / OI / vol) — их.
//   • execute(signal) сам применяет CB / drawdown / OI-cap / PROD-двойной-гейт.
//
// Безопасность:
//   • Mutex с 15-сек tick через state.tickRunning (claim синхронный, без await
//     до set) + re-entrancy guard → двойного OPEN нет.
//   • Входим только когда slot свободен (getActivePosition == null) и не HANDS-OFF.
//   • Coordinator-гейт реплицирован: в проде query'им только PROD-стратегии,
//     иначе execute откроет PAPER-позу, невидимую для слота → фантомы.
//   • Floor: выкл фид / протухшая цена → fallback на поллинговую цену из снапшота.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition } from '../core/database.js';
import { analyzeHunter } from '../modules/strategistSniper.js';
import { analyzeHunterLong } from '../modules/strategistHunterLong.js';
import { execute } from '../modules/executor/index.js';
import { getLivePrice, isFeedFresh } from '../core/priceFeed.js';
import { state } from './state.js';

const MAX_PRICE_AGE_MS = 10_000;

let timer = null;
let running = false;

/** Реплика coordinator-гейта: спрашиваем стратегию для РЕАЛЬНОГО слота? */
function hunterQueryable() {
  return config.trading.hunterEnabled &&
    (!config.isProduction || config.trading.hunterProdEnabled);
}
function hunterLongQueryable() {
  return config.trading.hunterLongEnabled &&
    (!config.isProduction || config.trading.hunterLongProdEnabled);
}

/**
 * Один прогон fast-entry. В HOLD-случае сети не делает (analyze* — pure).
 * Экспортируется для тестов; в проде дёргается по таймеру.
 */
export async function wsFastEntryCheck() {
  if (!config.trading.wsEntriesEnabled) return;
  if (running) return;
  // Mutex с 15-сек тиком — синхронная проверка+claim ниже, без await между.
  if (state.tickRunning || state.shuttingDown) return;
  if (!isFeedFresh()) return;
  if (state.manualPositionActive) return;   // HANDS-OFF: оператор торгует руками
  if (getActivePosition()) return;          // slot занят → не входим

  if (!hunterQueryable() && !hunterLongQueryable()) return;

  const snap = state.latestHunter;
  if (!Array.isArray(snap) || snap.length === 0) return;

  // synth: поверх снапшота заменяем price на живую WS-цену (где свежая).
  const now = Date.now();
  const synth = new Array(snap.length);
  for (let i = 0; i < snap.length; i++) {
    const item = snap[i];
    const live = getLivePrice(item.coin);
    synth[i] = (live && now - live.ts <= MAX_PRICE_AGE_MS)
      ? { ...item, price: live.price }
      : item;  // floor: нет свежей WS-цены → поллинговая из снапшота
  }

  // Claim: дальше 15-сек tick увидит tickRunning и пропустит свой прогон.
  running = true;
  state.tickRunning = true;
  try {
    // Приоритет как в coordinator: hunter → hunter_long.
    let signal = { action: 'HOLD' };
    if (hunterQueryable()) {
      const s = analyzeHunter(synth, undefined, now);
      if (s.action !== 'HOLD') signal = s;
    }
    if (signal.action === 'HOLD' && hunterLongQueryable()) {
      const s = analyzeHunterLong(synth, undefined, now);
      if (s.action !== 'HOLD') signal = s;
    }

    if (signal.action !== 'HOLD') {
      const live = getLivePrice(signal.coin);
      const age = live ? now - live.ts : -1;
      logger.info(
        `[WSEntry] ${signal.strategy_id} ${signal.action} #${signal.coin} ` +
        `spike ${signal.spikePct?.toFixed?.(2)}% @ $${signal.price} ` +
        `(WS-tick, price age ${age}ms — обогнали 15-сек скан)`,
      );
      await execute(signal, undefined);
    }
  } catch (err) {
    logger.warn(`[WSEntry] ${err.message}`);
  } finally {
    state.tickRunning = false;
    running = false;
  }
}

/** Поднимает fast-entry таймер. No-op, если HL_WS_ENTRIES_ENABLED != true. */
export function startWsEntryLoop() {
  if (!config.trading.wsEntriesEnabled) {
    logger.info('[WSEntry] disabled (HL_WS_ENTRIES_ENABLED != true)');
    return;
  }
  if (!config.trading.wsFeedEnabled) {
    logger.warn(
      '[WSEntry] HL_WS_ENTRIES_ENABLED=true, но HL_WS_FEED_ENABLED=false — фид не ' +
      'поднят, WS-входы не сработают. Включи фид. Оставляю на 15-сек скане.',
    );
    return;
  }
  if (timer) return;
  const ms = config.trading.wsEntryIntervalMs;
  timer = setInterval(() => {
    wsFastEntryCheck().catch((err) => logger.warn(`[WSEntry] loop: ${err.message}`));
  }, ms);
  logger.warn(
    `[WSEntry] ⚠️ started (Stage 3: WS-tick ВХОДЫ hunter/hunter_long, каждые ${ms}ms). ` +
    `Это ускоряет частоту входов — следи за числом сделок.`,
  );
}

/** Грейсфул-стоп (вызывается из shutdown). */
export function stopWsEntryLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[WSEntry] stopped');
  }
}
