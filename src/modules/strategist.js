import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

// Комиссии Hyperliquid (taker) + запас на проскальзывание
const FEE_RATE   = 0.0002;  // 0.02% taker
const SLIPPAGE   = 0.0001;  // 0.01%
const ROUND_TRIP = (FEE_RATE + SLIPPAGE) * 2; // вход + выход

const MAX_PAYBACK_HOURS = 4;

// Гистерезис: negative funding должен держаться N тиков подряд
// перед закрытием. При 15с тике, 2 тика = 30с.
const NEGATIVE_FUNDING_TICKS = 2;

// Минимальный APY для входа — защитный порог.
// Даже если entryApy=60%, но текущий APY упал до 8%, не входим.
const MIN_ENTRY_APY_FLOOR = 10;

// Funding-Aware Exit Gate: Hyperliquid платит фандинг каждый час в HH:00 UTC.
// Закрытие позиции за N минут до выплаты = потеря накопленного за окно фандинга.
// Блокируем soft-exits (APY below threshold, rotation) в этом окне.
// Emergency-exits (delist, price spike, negative funding) гейт игнорируют.
const FUNDING_GATE_MINUTES = 10;

/**
 * Сколько минут осталось до ближайшей выплаты фандинга (HH:00 UTC).
 * @returns {number} число с дробной частью, например 9.5
 */
function minutesUntilNextFunding() {
  const now      = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return (nextHour.getTime() - now.getTime()) / 60_000;
}

/**
 * true если до выплаты < FUNDING_GATE_MINUTES → soft-exits заблокированы.
 */
function isInFundingGate() {
  return minutesUntilNextFunding() < FUNDING_GATE_MINUTES;
}

// Счётчик: сколько тиков подряд funding < 0
let negativeFundingStreak = 0;

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
    // Сбрасываем счётчик negative funding — нет позиции
    negativeFundingStreak = 0;

    const best = scoutData[0]; // отсортированы по smoothedApy desc

    if (!best || best.smoothedApy < entryApy) {
      logger.info(
        `[Strategist] HOLD — no coin ≥ ${entryApy}% | best: ${best?.coin ?? '—'} @ ${best?.smoothedApy.toFixed(2) ?? 0}%`,
      );
      return { action: 'HOLD' };
    }

    // Защитный порог: не входим если APY ниже пола
    if (best.smoothedApy < MIN_ENTRY_APY_FLOOR) {
      logger.info(
        `[Strategist] HOLD — ${best.coin} APY ${best.smoothedApy.toFixed(2)}% < floor ${MIN_ENTRY_APY_FLOOR}%`,
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

  // 2. Цена выросла >10% — защита шорта от убытка
  const priceSpike = ((current.price - activePosition.entry_price) / activePosition.entry_price) * 100;
  if (priceSpike > 10) {
    logger.warn(`[Strategist] CLOSE — ${currentCoin} price spiked +${priceSpike.toFixed(2)}% (short at risk)`);
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'price_spike_protection',
    };
  }

  // 3. Фандинг стал отрицательным (мы платим, а не нам)
  //    Гистерезис: закрываем только если negative N тиков подряд.
  //    При 15с тике, 2 тика = 30с — фильтрует мгновенные выбросы.
  if (current.fundingRate < 0) {
    negativeFundingStreak++;
    logger.warn(
      `[Strategist] ⚠️ ${currentCoin} funding negative (${current.fundingRate}) — ` +
        `streak: ${negativeFundingStreak}/${NEGATIVE_FUNDING_TICKS}`,
    );

    if (negativeFundingStreak >= NEGATIVE_FUNDING_TICKS) {
      logger.warn(
        `[Strategist] CLOSE — ${currentCoin} funding negative ${negativeFundingStreak} ticks in a row`,
      );
      negativeFundingStreak = 0; // сброс
      return {
        action: 'CLOSE',
        coin:   currentCoin,
        price:  current.price,
        reason: 'negative_funding',
      };
    }
  } else {
    // Funding вернулся в плюс — сброс счётчика
    if (negativeFundingStreak > 0) {
      logger.info(
        `[Strategist] ✅ ${currentCoin} funding recovered (${current.fundingRate}) — streak reset`,
      );
      negativeFundingStreak = 0;
    }
  }

  // ── Обычные выходы (только после minHold) ─────
  // Используем slowApy — глубокое сглаживание, без паники.

  if (held >= minHoldMinutes) {
    // APY упал ниже (minApy − exitBuffer)
    // Пример: minApy=30, exitBuffer=5 → выходим только ниже 25%
    if (current.slowApy < effectiveExitApy) {
      // Funding-Aware Gate: не выходим в окне выплаты — потеряем накопленный фандинг
      if (isInFundingGate()) {
        logger.info(
          `[Strategist] HOLD (funding gate) — ${currentCoin} slowApy ${current.slowApy.toFixed(2)}% ` +
            `< exit ${effectiveExitApy}% but ${minutesUntilNextFunding().toFixed(1)}min to funding payout`,
        );
        return { action: 'HOLD' };
      }

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
        // Funding-Aware Gate: ротация = close+open, close теряет накопленный фандинг
        if (isInFundingGate()) {
          logger.info(
            `[Strategist] HOLD (funding gate) — would rotate ${currentCoin} → ${best.coin} ` +
              `but ${minutesUntilNextFunding().toFixed(1)}min to funding payout`,
          );
          return { action: 'HOLD' };
        }

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
