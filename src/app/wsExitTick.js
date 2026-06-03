// ─────────────────────────────────────────────────
//  WS Exit Tick — Stage 2: выходы на WS-тиках
// ─────────────────────────────────────────────────
//
// Why: 15-сек поллинг проспал внутри-тиковый вик (WLD: peak +$2.2 → close
// +$0.75). Этот лёгкий цикл считает выходы АКТИВНОЙ позиции на живых WS-ценах
// (раз в HL_WS_EXIT_INTERVAL_MS, default 2с), не дожидаясь 15-сек скана.
//
// Scope (Stage 2): только hunter / hunter_long — это trailing-TP скальперы,
// где вик решает. Carry/trend_follow/fader живут на часовом таймфрейме, их
// 15-сек сэмплинг устраивает → остаются на обычном tick(). Входы тоже на 15с.
//
// Безопасность:
//   • Re-use, не дублируем: зовём ту же coordinate()→analyzeHunter(Long) с
//     синтетическим one-coin массивом, где price = живая WS-цена. Peak/SL/TP/
//     time-stop логика та же, что в 15-сек тике.
//   • Mutex: делим state.tickRunning с главным тиком. Claim синхронный (без
//     await до установки флага) → 15-сек tick и этот цикл взаимоисключаемы,
//     двойного close быть не может.
//   • Floor: при выключенном фиде / протухшей цене — no-op, поллинг ведёт как
//     раньше. Бот не слепнет.
//   • Gated: HL_WS_EXITS_ENABLED (default OFF). Требует поднятого WS-фида.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getActivePosition } from '../core/database.js';
import { coordinate } from '../modules/coordinator.js';
import { execute } from '../modules/executor/index.js';
import { processHunterTrailArm } from './hunterTrailArm.js';
import { getLivePrice, isFeedFresh } from '../core/priceFeed.js';
import { state } from './state.js';

// Стратегии, чьи выходы переводим на WS-тики. Остальные остаются на 15-сек tick.
const WS_EXIT_STRATEGIES = new Set(['hunter', 'hunter_long']);

// Живую цену старше этого порога считаем протухшей → не действуем (floor).
const MAX_PRICE_AGE_MS = 10_000;

let timer = null;
let running = false;  // re-entrancy guard самого цикла (await execute может затянуться)

/**
 * Один прогон fast-exit для активной позиции. Без сети в HOLD-случае.
 * Экспортируется ради тестов; в проде дёргается по таймеру.
 */
export async function wsFastExitCheck() {
  if (!config.trading.wsExitsEnabled) return;
  if (running) return;
  // Mutex с главным тиком — синхронная проверка+claim, без await между ними.
  if (state.tickRunning || state.shuttingDown) return;
  if (!isFeedFresh()) return;

  const pos = getActivePosition();
  if (!pos) return;

  const sid = pos.strategy_id || 'carry';
  if (!WS_EXIT_STRATEGIES.has(sid)) return;

  const live = getLivePrice(pos.coin);
  if (!live) return;
  const age = Date.now() - live.ts;
  if (age > MAX_PRICE_AGE_MS) return;

  // Claim: с этого момента 15-сек tick увидит tickRunning=true и пропустит свой
  // прогон. JS однопоточный → между проверкой выше и присвоением ниже никто не
  // влезет (нет await). running=true — защита от наложения самих fast-итераций.
  running = true;
  state.tickRunning = true;
  try {
    // Синтетический one-coin срез с живой ценой. checkHunter(Long)Exit читает
    // только item.price (peak/SL/TP — из позиции + in-memory), funding/OI в
    // выходе не нужны → массива из {coin, price} достаточно.
    const synth = [{ coin: pos.coin, price: live.price }];

    // Тот же порядок, что в tick(): coordinate → ARM side-effect → execute.
    const signal = await coordinate(synth, pos, synth);
    await processHunterTrailArm(pos);

    if (signal.action !== 'HOLD') {
      logger.info(
        `[WSExit] ${signal.reason || signal.action} #${pos.coin} @ $${live.price} ` +
        `(WS-tick, price age ${age}ms — обогнали 15-сек скан)`,
      );
      await execute(signal, pos);
    }
  } catch (err) {
    logger.warn(`[WSExit] ${err.message}`);
  } finally {
    state.tickRunning = false;
    running = false;
  }
}

/** Поднимает fast-exit таймер. No-op, если HL_WS_EXITS_ENABLED != true. */
export function startWsExitLoop() {
  if (!config.trading.wsExitsEnabled) {
    logger.info('[WSExit] disabled (HL_WS_EXITS_ENABLED != true)');
    return;
  }
  if (!config.trading.wsFeedEnabled) {
    logger.warn(
      '[WSExit] HL_WS_EXITS_ENABLED=true, но HL_WS_FEED_ENABLED=false — фид не ' +
      'поднят, WS-выходы не сработают. Включи фид. Оставляю на 15-сек поллинге.',
    );
    return;
  }
  if (timer) return;
  const ms = config.trading.wsExitIntervalMs;
  timer = setInterval(() => {
    wsFastExitCheck().catch((err) => logger.warn(`[WSExit] loop: ${err.message}`));
  }, ms);
  logger.info(
    `[WSExit] started (Stage 2: WS-tick exits для ${[...WS_EXIT_STRATEGIES].join('/')}, ` +
    `каждые ${ms}ms)`,
  );
}

/** Грейсфул-стоп (вызывается из shutdown). */
export function stopWsExitLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[WSExit] stopped');
  }
}
