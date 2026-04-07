import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

// Комиссии Hyperliquid (taker) + запас на проскальзывание
const FEE_RATE   = 0.0002;  // 0.02% taker
const SLIPPAGE   = 0.0001;  // 0.01%
const ROUND_TRIP = (FEE_RATE + SLIPPAGE) * 2; // вход + выход

const MAX_PAYBACK_HOURS = 6;

const {
  minApy,
  entryApy,
  exitBuffer,
  minHoldMinutes,
  breathingMinutes,
} = config.trading;

// Реальный порог выхода = minApy − exitBuffer
// Например: 30 − 5 = 25%. Зона 25–30% = «зона спокойствия».
const effectiveExitApy = minApy - exitBuffer;

/**
 * За сколько часов разница APY окупит round-trip комиссий.
 */
export function calculatePaybackHours(currentApy, targetApy) {
  const deltaHourly = (targetApy - currentApy) / 100 / 365 / 24;
  if (deltaHourly <= 0) return Infinity;
  return ROUND_TRIP / (0.5 * deltaHourly);
}

/**
 * Сколько минут позиция уже открыта.
 */
function heldMinutes(activePosition) {
  return (Date.now() - activePosition.entry_time) / 60_000;
}

/**
 * @param {Array<{coin, price, fundingRate, rawApy, smoothedApy, slowApy}>} scoutData
 * @param {Object|undefined} activePosition — строка из таблицы positions
 * @returns {{ action: string, [key: string]: any }}
 */
export function analyze(scoutData, activePosition) {
  // ═══════════════════════════════════════════════
  //  Сценарий А: нет позиции — ищем вход
  // ═══════════════════════════════════════════════
  if (!activePosition) {
    const best = scoutData[0]; // отсортированы по smoothedApy desc

    if (!best || best.smoothedApy < entryApy) {
      logger.info(
        `[Strategist] HOLD — no coin ≥ ${entryApy}% | best: ${best?.coin ?? '—'} @ ${best?.smoothedApy.toFixed(2) ?? 0}%`,
      );
      return { action: 'HOLD' };
    }

    logger.info(`[Strategist] OPEN — ${best.coin} @ ${best.smoothedApy.toFixed(2)}%`);
    return {
      action: 'OPEN',
      coin:   best.coin,
      apy:    best.smoothedApy,
      price:  best.price,
    };
  }

  // ═══════════════════════════════════════════════
  //  Сценарий Б: есть позиция
  // ═══════════════════════════════════════════════
  const currentCoin = activePosition.coin;
  const current     = scoutData.find((m) => m.coin === currentCoin);
  const held        = heldMinutes(activePosition);

  // ── Экстренные выходы (игнорируют minHold) ────
  // Эти проверки срабатывают ВСЕГДА — даже через 1 секунду.

  // 1. Монета исчезла
  if (!current) {
    logger.warn(`[Strategist] CLOSE — ${currentCoin} disappeared`);
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  activePosition.entry_price,
      reason: 'delisted',
    };
  }

  // 2. Цена рухнула >10% — защита от ликвидации при леверидже
  const priceDrop = ((activePosition.entry_price - current.price) / activePosition.entry_price) * 100;
  if (priceDrop > 10) {
    logger.warn(`[Strategist] CLOSE — ${currentCoin} price dropped ${priceDrop.toFixed(2)}%`);
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'price_drop_protection',
    };
  }

  // 3. Фандинг стал отрицательным (мы платим, а не нам)
  if (current.fundingRate < 0) {
    logger.warn(`[Strategist] CLOSE — ${currentCoin} funding negative (${current.fundingRate})`);
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'negative_funding',
    };
  }

  // ── Обычные выходы (только после minHold) ─────
  // Используем slowApy — глубокое сглаживание, без паники.

  if (held >= minHoldMinutes) {
    // APY упал ниже (minApy − exitBuffer)
    // Пример: minApy=30, exitBuffer=5 → выходим только ниже 25%
    if (current.slowApy < effectiveExitApy) {
      logger.warn(
        `[Strategist] CLOSE — ${currentCoin} slowApy ${current.slowApy.toFixed(2)}% < effectiveExit ${effectiveExitApy}% (held ${held.toFixed(0)}min)`,
      );
      return {
        action: 'CLOSE',
        coin:   currentCoin,
        price:  current.price,
        reason: 'apy_below_threshold',
      };
    }
  } else {
    logger.info(
      `[Strategist] ${currentCoin} slowApy=${current.slowApy.toFixed(2)}% | hold lock: ${held.toFixed(0)}/${minHoldMinutes} min`,
    );
  }

  // ── Ротация (только после breathing) ──────────
  // Первые breathingMinutes — игнорируем любые «лучшие» монеты.
  // Даём позиции стабилизироваться.

  if (held >= breathingMinutes) {
    const best = scoutData.find((m) => m.coin !== currentCoin);

    if (best && best.smoothedApy > current.smoothedApy) {
      const hours = calculatePaybackHours(current.smoothedApy, best.smoothedApy);

      if (hours <= MAX_PAYBACK_HOURS) {
        logger.info(
          `[Strategist] ROTATE — ${currentCoin} (${current.smoothedApy.toFixed(2)}%) → ${best.coin} (${best.smoothedApy.toFixed(2)}%) | payback: ${hours.toFixed(1)}h`,
        );
        return {
          action:       'ROTATE',
          closeCoin:    currentCoin,
          closePrice:   current.price,
          openCoin:     best.coin,
          openPrice:    best.price,
          openApy:      best.smoothedApy,
          paybackHours: parseFloat(hours.toFixed(1)),
          reason:       'better_apy',
        };
      }

      logger.info(
        `[Strategist] HOLD — ${best.coin} ${best.smoothedApy.toFixed(2)}% but payback ${hours.toFixed(1)}h > ${MAX_PAYBACK_HOURS}h`,
      );
    }
  }

  return { action: 'HOLD' };
}
