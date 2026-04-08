import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const HL_API   = 'https://api.hyperliquid.xyz/info';
const RTT_LIMIT_MS = 10_000; // отклоняем ответы медленнее 10 с

// ── Кеш торгуемого universe (из getMeta) ────────
// Обновляется раз в 5 минут. Содержит Set<string> имён монет,
// которые РЕАЛЬНО можно торговать через Exchange API.
let tradeableCoins     = null;
let tradeableCacheTime = 0;
const TRADEABLE_TTL_MS = 5 * 60_000;

/**
 * Два EMA-фильтра с разной скоростью реакции:
 *
 * FAST (α=0.15, ~12 тиков при 15с = ~3 мин):
 *   для решений о входе и ротации — быстрый сигнал
 *
 * SLOW (α=0.03, ~62 тика при 15с = ~15 мин):
 *   для решений о выходе — глубокое сглаживание,
 *   секундные провалы APY не вызывают панику
 */
const EMA_ALPHA_FAST = 0.15;
const EMA_ALPHA_SLOW = 0.03;

// coin -> { fast, slow, ticks }
const emaStore = new Map();

function updateEma(coin, rawApy) {
  const entry = emaStore.get(coin);
  if (!entry) {
    emaStore.set(coin, { fast: rawApy, slow: rawApy, ticks: 1 });
    return { fast: rawApy, slow: rawApy };
  }
  entry.fast = EMA_ALPHA_FAST * rawApy + (1 - EMA_ALPHA_FAST) * entry.fast;
  entry.slow = EMA_ALPHA_SLOW * rawApy + (1 - EMA_ALPHA_SLOW) * entry.slow;
  entry.ticks++;
  return { fast: entry.fast, slow: entry.slow };
}

/**
 * Запрашивает getMeta() и строит Set торгуемых монет.
 * Кешируется на 5 минут — universe не меняется каждый тик.
 *
 * Это КАНОНИЧЕСКИЙ список: если монеты нет в getMeta().universe,
 * её нельзя торговать через Exchange API (пример: STBL — HLP-индекс).
 *
 * @returns {Promise<Set<string>>}
 */
async function fetchTradeableCoins() {
  if (tradeableCoins && Date.now() - tradeableCacheTime < TRADEABLE_TTL_MS) {
    return tradeableCoins;
  }

  try {
    const { data } = await axios.post(HL_API, { type: 'meta' });
    const universe = data?.universe;

    if (!Array.isArray(universe)) {
      logger.warn('[Scout] getMeta returned invalid universe — using stale cache');
      return tradeableCoins ?? new Set();
    }

    tradeableCoins = new Set(universe.map((a) => a.name));
    tradeableCacheTime = Date.now();

    logger.debug(`[Scout] Tradeable universe refreshed — ${tradeableCoins.size} assets`);
    return tradeableCoins;
  } catch (err) {
    logger.warn(`[Scout] Failed to refresh tradeable universe: ${err.message}`);
    return tradeableCoins ?? new Set();
  }
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
 *   smoothedApy: number,
 *   slowApy: number
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

  // ── Двойная защита: структурный фильтр + блэклист ──
  const tradeable = await fetchTradeableCoins();
  const blacklist = config.trading.coinBlacklist;

  const results = [];
  let skippedBlacklist  = 0;
  let skippedUntradeable = 0;

  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx   = assetCtxs[i];

    const coin = asset?.name;
    if (!coin || !ctx) continue;

    // Фильтр 1: ручной блэклист (STBL и подобные)
    if (blacklist.has(coin)) {
      skippedBlacklist++;
      continue;
    }

    // Фильтр 2: нет в торгуемом universe из getMeta() → не перп-контракт
    if (tradeable.size > 0 && !tradeable.has(coin)) {
      skippedUntradeable++;
      continue;
    }

    const price       = parseFloat(ctx.markPx  ?? ctx.midPx ?? 0);
    const fundingRate = parseFloat(ctx.funding  ?? 0);

    if (isNaN(price) || isNaN(fundingRate)) continue;

    const rawApy = fundingRate * 24 * 365 * 100;
    const { fast, slow } = updateEma(coin, rawApy);

    if (fast <= 0) continue;

    results.push({ coin, price, fundingRate, rawApy, smoothedApy: fast, slowApy: slow });
  }

  if (skippedBlacklist > 0 || skippedUntradeable > 0) {
    logger.debug(
      `[Scout] Filtered out: ${skippedBlacklist} blacklisted, ${skippedUntradeable} untradeable`,
    );
  }

  results.sort((a, b) => b.smoothedApy - a.smoothedApy);

  logger.info(
    `[Scout] ${results.length} coins with smoothedApy > 0 | top: ${results[0]?.coin ?? '—'} @ ${results[0]?.smoothedApy.toFixed(2) ?? 0}%`,
  );

  return results;
}
