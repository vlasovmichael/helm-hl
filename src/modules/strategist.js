import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

// Комиссии Hyperliquid (taker) + запас на проскальзывание
const FEE_RATE = 0.0002;  // 0.02% taker
const SLIPPAGE = 0.0001;  // 0.01% slippage estimate
const ROUND_TRIP = (FEE_RATE + SLIPPAGE) * 2; // вход + выход

const MAX_PAYBACK_HOURS = 6;

const { minApy, entryApy } = config.trading;

/**
 * Считает, за сколько часов разница в APY окупит полный round-trip комиссий.
 *
 *   hourlyDelta = (targetApy − currentApy) / 100 / 365 / 24
 *   Доход за час на шортовую ногу (50%) = 0.5 × hourlyDelta
 *   payback = ROUND_TRIP / (0.5 × hourlyDelta)
 *
 * @param {number} currentApy  — текущий APY позиции (%)
 * @param {number} targetApy   — APY кандидата на ротацию (%)
 * @returns {number}           — часы до безубытка (Infinity если дельта ≤ 0)
 */
export function calculatePaybackHours(currentApy, targetApy) {
  const deltaHourly = (targetApy - currentApy) / 100 / 365 / 24;
  if (deltaHourly <= 0) return Infinity;
  return ROUND_TRIP / (0.5 * deltaHourly);
}

/**
 * Основная функция стратегического решения.
 *
 * @param {Array<{coin, price, fundingRate, rawApy, smoothedApy}>} scoutData
 *        — данные от Скаута (уже отсортированы по smoothedApy desc, только > 0)
 *
 * @param {Object|undefined} activePosition
 *        — строка из таблицы `positions` (или undefined если нет открытой позиции)
 *        — поля: id, coin, size_usd, entry_price, entry_apy, entry_time, mode, status
 *
 * @returns {{ action: string, [key: string]: any }}
 */
export function analyze(scoutData, activePosition) {
  // ═══════════════════════════════════════════════
  //  Сценарий А: нет позиции
  // ═══════════════════════════════════════════════
  if (!activePosition) {
    const best = scoutData[0]; // уже отсортированы desc

    if (!best || best.smoothedApy < entryApy) {
      logger.info(
        `[Strategist] HOLD — no coin meets entry threshold (${entryApy}%). ` +
        `Best: ${best?.coin ?? '—'} @ ${best?.smoothedApy.toFixed(2) ?? 0}%`,
      );
      return { action: 'HOLD' };
    }

    logger.info(
      `[Strategist] OPEN signal — ${best.coin} @ ${best.smoothedApy.toFixed(2)}% APY`,
    );
    return {
      action: 'OPEN',
      coin:   best.coin,
      apy:    best.smoothedApy,
      price:  best.price,
    };
  }

  // ═══════════════════════════════════════════════
  //  Сценарий Б: есть открытая позиция
  // ═══════════════════════════════════════════════
  const currentCoin = activePosition.coin;
  const current = scoutData.find((m) => m.coin === currentCoin);

  // ── Экстренные проверки (без cooldown) ────────

  // 1. Монета исчезла из листинга / нет данных
  if (!current) {
    logger.warn(`[Strategist] CLOSE — ${currentCoin} disappeared from scout data`);
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  activePosition.entry_price,
      reason: 'delisted',
    };
  }

  // 2. Фандинг стал отрицательным — нам платят мы, а не нам
  if (current.fundingRate < 0) {
    logger.warn(
      `[Strategist] CLOSE — ${currentCoin} funding turned negative (${current.fundingRate})`,
    );
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'negative_funding',
    };
  }

  // 3. EMA APY упал ниже порога выхода
  if (current.smoothedApy < minApy) {
    logger.warn(
      `[Strategist] CLOSE — ${currentCoin} smoothedApy ${current.smoothedApy.toFixed(2)}% < minApy ${minApy}%`,
    );
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'apy_below_threshold',
    };
  }

  // 4. Резкое падение цены (>10% от входа) — защита от ликвидации при леверидже
  const priceDropPct = ((activePosition.entry_price - current.price) / activePosition.entry_price) * 100;
  if (priceDropPct > 10) {
    logger.warn(
      `[Strategist] CLOSE — ${currentCoin} price dropped ${priceDropPct.toFixed(2)}% since entry`,
    );
    return {
      action: 'CLOSE',
      coin:   currentCoin,
      price:  current.price,
      reason: 'price_drop_protection',
    };
  }

  // ── Ротация ───────────────────────────────────

  const best = scoutData.find((m) => m.coin !== currentCoin);

  if (best && best.smoothedApy > current.smoothedApy) {
    const hours = calculatePaybackHours(current.smoothedApy, best.smoothedApy);

    if (hours <= MAX_PAYBACK_HOURS) {
      logger.info(
        `[Strategist] ROTATE — ${currentCoin} (${current.smoothedApy.toFixed(2)}%) → ${best.coin} (${best.smoothedApy.toFixed(2)}%) | payback: ${hours.toFixed(1)}h`,
      );
      return {
        action:      'ROTATE',
        closeCoin:   currentCoin,
        closePrice:  current.price,
        openCoin:    best.coin,
        openPrice:   best.price,
        openApy:     best.smoothedApy,
        paybackHours: parseFloat(hours.toFixed(1)),
        reason:      'better_apy',
      };
    }

    logger.info(
      `[Strategist] HOLD — ${best.coin} APY ${best.smoothedApy.toFixed(2)}% but payback ${hours.toFixed(1)}h > ${MAX_PAYBACK_HOURS}h`,
    );
  }

  // ── Ничего интересного — сидим ────────────────

  return { action: 'HOLD' };
}
