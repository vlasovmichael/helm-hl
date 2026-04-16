import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const ROUND_TRIP = 0.001;
const DELIST_CONFIRM_TICKS = 3;
const DELIST_COOLDOWN_MINUTES = 30;
const NEGATIVE_FUNDING_TICKS = 2;
const FUNDING_GATE_MINUTES = 10;

let negativeFundingStreak = 0;
let disappearedStreak = 0;
let delistCooldown = { coin: null, until: 0 };

const {
  fadeMaxHoldMinutes,
  fadeMinCurrentApy,
  fadeMinDropPct,
} = config.trading;

function hoursToBreakeven(apy) {
  const hourlyRate = apy / 100 / 365 / 24;
  if (hourlyRate <= 0) return Infinity;
  return ROUND_TRIP / hourlyRate;
}

function heldMinutes(pos) {
  return (Date.now() - pos.entry_time) / 60_000;
}

function minutesUntilNextFunding() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return (nextHour.getTime() - now.getTime()) / 60_000;
}

function isInFundingGate() {
  return minutesUntilNextFunding() < FUNDING_GATE_MINUTES;
}

export function resetFadeState() {
  negativeFundingStreak = 0;
  disappearedStreak = 0;
  delistCooldown = { coin: null, until: 0 };
}

/**
 * Fade strategy: шортим монеты с экстремальным фандинг-спайком,
 * который по прогнозу биржи скоро упадёт. Собираем 1-2 часа
 * высокого фандинга и выходим по time-stop.
 *
 * @param {Array} scoutData — отсортированы по smoothedApy desc
 * @param {Object|undefined} activePosition
 * @returns {{ action: string, [key: string]: any }}
 */
export function analyzeFade(scoutData, activePosition) {
  if (!activePosition) {
    negativeFundingStreak = 0;
    disappearedStreak = 0;

    for (const item of scoutData) {
      if (item.smoothedApy < fadeMinCurrentApy) break;

      if (item.predictedApy == null) continue;
      if (item.rawApy <= 0) continue;

      const drop = (item.rawApy - item.predictedApy) / item.rawApy;
      if (drop < fadeMinDropPct) continue;

      const maxHoldHours = fadeMaxHoldMinutes / 60;
      const breakevenH = hoursToBreakeven(item.smoothedApy);
      if (breakevenH > maxHoldHours) {
        logger.debug(
          `[Fade] SKIP ${item.coin} — breakeven ${breakevenH.toFixed(1)}h > max hold ${maxHoldHours}h`,
        );
        continue;
      }

      if (delistCooldown.coin === item.coin && Date.now() < delistCooldown.until) {
        continue;
      }

      logger.info(
        `[Fade] OPEN — ${item.coin} @ ${item.smoothedApy.toFixed(0)}% APY | ` +
          `predicted drop ${(drop * 100).toFixed(0)}% | breakeven ${breakevenH.toFixed(1)}h | ` +
          `time-stop ${fadeMaxHoldMinutes}min`,
      );
      return {
        action: 'OPEN',
        coin: item.coin,
        apy: item.smoothedApy,
        price: item.price,
        strategy_id: 'fade',
      };
    }

    return { action: 'HOLD' };
  }

  // ═══════════════════════════════════════════════
  //  Has position — manage fade trade
  // ═══════════════════════════════════════════════
  const currentCoin = activePosition.coin;
  const current = scoutData.find((m) => m.coin === currentCoin);
  const held = heldMinutes(activePosition);

  // Emergency: delist hysteresis
  if (!current) {
    disappearedStreak++;
    logger.warn(
      `[Fade] ${currentCoin} disappeared — streak: ${disappearedStreak}/${DELIST_CONFIRM_TICKS}`,
    );
    if (disappearedStreak >= DELIST_CONFIRM_TICKS) {
      disappearedStreak = 0;
      delistCooldown = {
        coin: currentCoin,
        until: Date.now() + DELIST_COOLDOWN_MINUTES * 60_000,
      };
      return {
        action: 'CLOSE',
        coin: currentCoin,
        price: activePosition.entry_price,
        reason: 'delisted',
      };
    }
    return { action: 'HOLD' };
  }

  if (disappearedStreak > 0) {
    disappearedStreak = 0;
  }

  // Emergency: price spike >10%
  const spike =
    ((current.price - activePosition.entry_price) / activePosition.entry_price) * 100;
  if (spike > 10) {
    logger.warn(
      `[Fade] CLOSE — ${currentCoin} price spiked +${spike.toFixed(2)}%`,
    );
    return {
      action: 'CLOSE',
      coin: currentCoin,
      price: current.price,
      reason: 'price_spike_protection',
    };
  }

  // Emergency: negative funding (2-tick hysteresis)
  if (current.fundingRate < 0) {
    negativeFundingStreak++;
    if (negativeFundingStreak >= NEGATIVE_FUNDING_TICKS) {
      negativeFundingStreak = 0;
      logger.warn(
        `[Fade] CLOSE — ${currentCoin} funding negative ${NEGATIVE_FUNDING_TICKS} ticks`,
      );
      return {
        action: 'CLOSE',
        coin: currentCoin,
        price: current.price,
        reason: 'negative_funding',
      };
    }
  } else if (negativeFundingStreak > 0) {
    negativeFundingStreak = 0;
  }

  // Time-stop: core of fade strategy
  if (held >= fadeMaxHoldMinutes) {
    if (isInFundingGate()) {
      logger.info(
        `[Fade] HOLD (funding gate) — ${currentCoin} time-stop reached but ` +
          `${minutesUntilNextFunding().toFixed(1)}min to payout`,
      );
      return { action: 'HOLD' };
    }

    logger.info(
      `[Fade] CLOSE — ${currentCoin} time-stop ${fadeMaxHoldMinutes}min reached ` +
        `(held ${held.toFixed(0)}min)`,
    );
    return {
      action: 'CLOSE',
      coin: currentCoin,
      price: current.price,
      reason: 'fade_time_stop',
    };
  }

  logger.debug(
    `[Fade] ${currentCoin} — held ${held.toFixed(0)}/${fadeMaxHoldMinutes}min | ` +
      `APY ${current.smoothedApy.toFixed(0)}%`,
  );

  return { action: 'HOLD' };
}
