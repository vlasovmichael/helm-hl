import axios from 'axios';
import { logger } from '../core/logger.js';

const HL_API   = 'https://api.hyperliquid.xyz/info';
const RTT_LIMIT_MS = 10_000; // отклоняем ответы медленнее 10 с

/**
 * EMA_ALPHA = 0.1 даёт "память" ~19 тиков (период сглаживания ≈ 1/alpha - 1).
 * При тике 5 мин это ~90 минут исторической памяти.
 * Повысь до 0.2–0.3 для более быстрой реакции на смену режима рынка.
 */
const EMA_ALPHA = 0.1;

// coin -> { ema: number, ticks: number }
const emaStore = new Map();

/**
 * Обновляет EMA для монеты и возвращает текущее значение.
 * Первый тик инициализирует EMA сырым значением (без искажения нулём).
 */
function updateEma(coin, rawApy) {
  const entry = emaStore.get(coin);
  if (!entry) {
    emaStore.set(coin, { ema: rawApy, ticks: 1 });
    return rawApy;
  }
  const ema = EMA_ALPHA * rawApy + (1 - EMA_ALPHA) * entry.ema;
  entry.ema = ema;
  entry.ticks++;
  return ema;
}

/**
 * Делает POST-запрос к Hyperliquid /info и возвращает data.
 * Бросает ошибку, если RTT превышает лимит.
 */
async function fetchMarkets() {
  const t0 = Date.now();
  const response = await axios.post(HL_API, { type: 'metaAndAssetCtxs' });
  const rtt = Date.now() - t0;

  if (rtt > RTT_LIMIT_MS) {
    throw new Error(`Hyperliquid RTT ${rtt}ms exceeds limit of ${RTT_LIMIT_MS}ms`);
  }

  const data = response.data;

  if (!Array.isArray(data) || data.length < 2) {
    throw new Error(
      `Unexpected metaAndAssetCtxs shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  return data;
}

/**
 * Основная функция модуля.
 * Запрашивает рынок, обновляет EMA, возвращает монеты с smoothedApy > 0.
 *
 * @returns {Promise<Array<{
 *   coin: string,
 *   price: number,
 *   fundingRate: number,
 *   rawApy: number,
 *   smoothedApy: number
 * }>>}
 */
export async function scan() {
  let data;
  try {
    data = await fetchMarkets();
  } catch (err) {
    logger.error(`[Scout] API error: ${err.message}`);
    return [];
  }

  const [meta, assetCtxs] = data;
  const universe = Array.isArray(meta) ? meta : meta?.universe;

  if (!Array.isArray(universe) || !Array.isArray(assetCtxs)) {
    logger.error('[Scout] Invalid universe or assetCtxs in response');
    return [];
  }

  const results = [];

  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx   = assetCtxs[i];

    const coin = asset?.name;
    if (!coin || !ctx) continue;

    const price       = parseFloat(ctx.markPx  ?? ctx.midPx ?? 0);
    const fundingRate = parseFloat(ctx.funding  ?? 0);

    if (isNaN(price) || isNaN(fundingRate)) continue;

    const rawApy      = fundingRate * 24 * 365 * 100;
    const smoothedApy = updateEma(coin, rawApy);

    if (smoothedApy <= 0) continue;

    results.push({ coin, price, fundingRate, rawApy, smoothedApy });
  }

  results.sort((a, b) => b.smoothedApy - a.smoothedApy);

  logger.info(
    `[Scout] ${results.length} coins with smoothedApy > 0 | top: ${results[0]?.coin ?? '—'} @ ${results[0]?.smoothedApy.toFixed(2) ?? 0}%`,
  );

  return results;
}
