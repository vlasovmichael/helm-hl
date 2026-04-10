// ─────────────────────────────────────────────────
//  Volatility Filter — preflight gate перед OPEN
// ─────────────────────────────────────────────────
// Защищает от входа в "пампящие" монеты (кейс MAVIA).
// Считает коэффициент вариации цены за последние 15 минут
// и требует динамически повышенный APY при высокой волатильности.
//
// Variant C (gatekeeper): один candleSnapshot на тик максимум,
// вызывается из executor/index.js → preflightChecks.

import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const HL_API = 'https://api.hyperliquid.xyz/info';

// Порог "штиля": если VolIdx < 0.003 (0.3% за 15 мин) — штрафа нет.
const VOL_IDX_NORMAL_THRESHOLD = 0.003;

// Множитель в формуле Threshold_dynamic = ENTRY_APY × (1 + min(VolIdx × 200, 3)).
// При VolIdx=0.005 (0.5%) → ×2, при 0.015 (1.5%) → ×4 (cap).
const VOL_IDX_MULTIPLIER     = 200;
const VOL_IDX_MAX_MULTIPLIER = 3;

const CANDLE_LOOKBACK_MIN = 15;

/**
 * Получает 15× 1-минутных свечей по монете.
 * Бросает ошибку — обработка fail-open в caller.
 */
async function fetchCandles(coin) {
  const now = Date.now();
  const startTime = now - CANDLE_LOOKBACK_MIN * 60_000;
  const { data } = await axios.post(HL_API, {
    type: 'candleSnapshot',
    req: { coin, interval: '1m', startTime, endTime: now },
  });
  return data;
}

/**
 * Коэффициент вариации = stddev / mean.
 * Безразмерный, нормализованный по уровню цены — сравнимо между монетами.
 */
function computeVolIdx(closes) {
  const n = closes.length;
  if (n === 0) return 0;
  const mean = closes.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  const variance = closes.reduce((a, c) => a + (c - mean) ** 2, 0) / n;
  return Math.sqrt(variance) / mean;
}

/**
 * Главная функция: разрешён ли вход в монету при текущей волатильности.
 *
 * @param {string} coin
 * @param {number} smoothedApy — уже посчитанный стратегом APY кандидата
 * @returns {Promise<{ allowed: boolean, volIdx: number, requiredApy?: number, reason?: string }>}
 */
export async function checkVolatility(coin, smoothedApy) {
  let candles;
  try {
    candles = await fetchCandles(coin);
  } catch (err) {
    logger.warn(
      `[Volatility] #${coin} candleSnapshot failed: ${err.message} — fail-open (allow)`,
    );
    return { allowed: true, volIdx: 0 };
  }

  if (!Array.isArray(candles) || candles.length < 5) {
    logger.warn(
      `[Volatility] #${coin} insufficient candles (${candles?.length ?? 0}) — fail-open (allow)`,
    );
    return { allowed: true, volIdx: 0 };
  }

  const closes = candles
    .map((c) => parseFloat(c.c))
    .filter((n) => !isNaN(n) && n > 0);

  if (closes.length < 5) {
    logger.warn(
      `[Volatility] #${coin} too few valid closes (${closes.length}) — fail-open (allow)`,
    );
    return { allowed: true, volIdx: 0 };
  }

  const volIdx = computeVolIdx(closes);

  // Штиль — пропускаем без штрафа
  if (volIdx < VOL_IDX_NORMAL_THRESHOLD) {
    logger.debug(
      `[Volatility] ✓ #${coin} VolIdx=${volIdx.toFixed(4)} — calm, allow`,
    );
    return { allowed: true, volIdx };
  }

  // Динамический порог
  const multiplier  = 1 + Math.min(volIdx * VOL_IDX_MULTIPLIER, VOL_IDX_MAX_MULTIPLIER);
  const requiredApy = config.trading.entryApy * multiplier;

  if (smoothedApy >= requiredApy) {
    logger.info(
      `[Volatility] ⚠ #${coin} VolIdx=${volIdx.toFixed(4)} hot, ` +
      `but APY ${smoothedApy.toFixed(1)}% ≥ required ${requiredApy.toFixed(1)}% — allow`,
    );
    return { allowed: true, volIdx };
  }

  // VETO — выводим "цифры страха" в лог
  const mean   = closes.reduce((a, b) => a + b, 0) / closes.length;
  const stddev = Math.sqrt(
    closes.reduce((a, c) => a + (c - mean) ** 2, 0) / closes.length,
  );
  logger.warn(
    `[Volatility] ⛔ #${coin} VolIdx=${volIdx.toFixed(4)} ` +
    `(stddev=${stddev.toFixed(6)}, mean=${mean.toFixed(6)}) → ` +
    `required APY≥${requiredApy.toFixed(1)}%, actual=${smoothedApy.toFixed(1)}% — VETO`,
  );

  return {
    allowed:     false,
    volIdx,
    requiredApy,
    reason:      'pump_detected',
  };
}
