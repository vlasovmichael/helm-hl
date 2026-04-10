import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { setUniverse, getTradeableSet } from '../core/universe.js';
import { getRuntimeBlacklist, getOiCapBans } from './executor/index.js';

const HL_API   = 'https://api.hyperliquid.xyz/info';
const RTT_LIMIT_MS = 10_000; // отклоняем ответы медленнее 10 с

// ── Predictive Funding ─────────────────────────
// Если у кандидата (rawApy >= ENTRY_APY_THRESHOLD) предсказанный фандинг
// упадёт более чем на этот процент — пропускаем монету.
const PREDICTED_DROP_THRESHOLD   = 0.30;
const PREDICTED_FUNDING_CACHE_MS = 5 * 60_000; // биржа обновляет раз в час, кеш 5 мин

let predictedCache = { ts: 0, map: new Map() };

// Предыдущие значения — логируем INFO только при изменении
let prevFilterSnapshot = '';
let prevTopCoin = '';

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
 * Обновляет общий кеш universe из ответа metaAndAssetCtxs.
 *
 * Вызывается из scan() после успешного fetch — записывает RAW universe
 * в core/universe.js, откуда его читают и Scout (для фильтрации),
 * и Executor (для resolveAsset). ОДИН источник, НОЛЬ рассинхронов.
 *
 * @param {Array} universe — массив из meta.universe
 */
function refreshUniverse(universe) {
  if (!Array.isArray(universe) || universe.length < 10) {
    logger.warn(
      `[Scout] Universe too small or invalid (${universe?.length ?? 0}) — not updating shared cache`,
    );
    return;
  }

  setUniverse(universe);
}

/**
 * Запрашивает predictedFundings (с кешем 5 мин).
 * Возвращает Map<coin, predictedRate> для venue 'HlPerp'.
 *
 * Fail-open: при ошибке возвращает старый кеш или пустую Map.
 * Никогда не блокирует scan() целиком.
 */
async function fetchPredictedFundings() {
  if (Date.now() - predictedCache.ts < PREDICTED_FUNDING_CACHE_MS) {
    return predictedCache.map;
  }

  try {
    const response = await axios.post(HL_API, { type: 'predictedFundings' });
    const data = response.data;

    if (!Array.isArray(data)) {
      logger.warn(`[Scout] predictedFundings: unexpected shape, ignoring`);
      return predictedCache.map;
    }

    // Формат: [[coin, [[venue, { fundingRate, nextFundingTime }], ...]], ...]
    const map = new Map();
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [coin, venues] = entry;
      if (!coin || !Array.isArray(venues)) continue;
      for (const v of venues) {
        if (!Array.isArray(v) || v.length < 2) continue;
        const [venueName, payload] = v;
        if (venueName === 'HlPerp' && payload && payload.fundingRate != null) {
          const rate = parseFloat(payload.fundingRate);
          if (!isNaN(rate)) map.set(coin, rate);
          break;
        }
      }
    }

    predictedCache = { ts: Date.now(), map };
    logger.debug(`[Scout] predictedFundings: refreshed cache, ${map.size} coins`);
    return map;
  } catch (err) {
    logger.warn(`[Scout] predictedFundings fetch failed: ${err.message} — using stale cache`);
    return predictedCache.map;
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

  // Обновляем ОБЩИЙ кеш universe — Executor будет читать отсюда же
  refreshUniverse(universe);

  // Predictive funding (5min cache, fail-open)
  const predictedFundings = await fetchPredictedFundings();

  // ── Защита: блэклист + universe + runtime + OI cap ──
  const tradeable       = getTradeableSet(); // из core/universe.js
  const blacklist       = config.trading.coinBlacklist;
  const runtimeBlocked  = getRuntimeBlacklist();
  const oiCapBlocked    = getOiCapBans();

  // Логируем фильтры на INFO только при изменении, иначе debug
  const filterSnap = `${universe.length}|${tradeable.size}|${blacklist.size}|${runtimeBlocked.size}|${oiCapBlocked.size}`;
  if (filterSnap !== prevFilterSnapshot) {
    prevFilterSnapshot = filterSnap;
    logger.info(
      `[Scout] Filters: API universe=${universe.length} | tradeable=${tradeable.size} | ` +
      `blacklist=${blacklist.size} | runtime-banned=${runtimeBlocked.size} | ` +
      `oi-cap-banned=${oiCapBlocked.size}`,
    );
  } else {
    logger.debug(
      `[Scout] Filters: API universe=${universe.length} | tradeable=${tradeable.size} | ` +
      `blacklist=${blacklist.size} | runtime-banned=${runtimeBlocked.size} | ` +
      `oi-cap-banned=${oiCapBlocked.size}`,
    );
  }

  const results = [];
  let skippedBlacklist     = 0;
  let skippedUntradeable   = 0;
  let skippedRuntime       = 0;
  let skippedOiCap         = 0;
  let skippedPredictedDrop = 0;

  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx   = assetCtxs[i];

    const coin = asset?.name;
    if (!coin || !ctx) continue;

    const coinUpper = coin.toUpperCase();

    // Фильтр 1: ручной блэклист из .env (STBL и подобные)
    if (blacklist.has(coinUpper)) {
      skippedBlacklist++;
      continue;
    }

    // Фильтр 2: runtime blacklist — Executor уже обжёгся об этот актив
    if (runtimeBlocked.has(coin) || runtimeBlocked.has(coinUpper)) {
      skippedRuntime++;
      continue;
    }

    // Фильтр 2.5: OI cap ban — биржа отказала из-за переполненного OI
    if (oiCapBlocked.has(coin) || oiCapBlocked.has(coinUpper)) {
      skippedOiCap++;
      continue;
    }

    // Фильтр 3: нет в общем universe → не перп-контракт
    // Пропускаем если tradeable пустой (первый тик) —
    // лучше пропустить мусор в Executor, чем забанить всё живое
    if (tradeable.size > 0 && !tradeable.has(coinUpper)) {
      skippedUntradeable++;
      continue;
    }

    const price       = parseFloat(ctx.markPx  ?? ctx.midPx ?? 0);
    const fundingRate = parseFloat(ctx.funding  ?? 0);

    if (isNaN(price) || isNaN(fundingRate)) continue;

    const rawApy = fundingRate * 24 * 365 * 100;

    // Predictive Funding filter — только для серьёзных кандидатов.
    // Если currentApy ниже порога входа — нам всё равно, мы туда не пойдём.
    if (rawApy >= config.trading.entryApy) {
      const predictedRate = predictedFundings.get(coin);
      if (predictedRate != null) {
        const predictedApy = predictedRate * 24 * 365 * 100;
        const drop = (rawApy - predictedApy) / rawApy;
        if (drop > PREDICTED_DROP_THRESHOLD) {
          skippedPredictedDrop++;
          logger.debug(
            `[Scout] #${coin} APY ${rawApy.toFixed(0)}% → predicted ${predictedApy.toFixed(0)}% ` +
            `(-${(drop * 100).toFixed(0)}%) — skip (predicted drop > ${(PREDICTED_DROP_THRESHOLD * 100).toFixed(0)}%)`,
          );
          continue;
        }
      }
    }

    const { fast, slow } = updateEma(coin, rawApy);

    if (fast <= 0) continue;

    results.push({ coin, price, fundingRate, rawApy, smoothedApy: fast, slowApy: slow });
  }

  if (skippedBlacklist > 0 || skippedUntradeable > 0 || skippedRuntime > 0 || skippedOiCap > 0 || skippedPredictedDrop > 0) {
    logger.debug(
      `[Scout] Filtered out: ${skippedBlacklist} blacklisted, ${skippedUntradeable} untradeable, ` +
      `${skippedRuntime} runtime-blocked, ${skippedOiCap} oi-cap-blocked, ` +
      `${skippedPredictedDrop} predicted-drop`,
    );
  }

  results.sort((a, b) => b.smoothedApy - a.smoothedApy);

  // INFO при смене лидера, иначе debug — не забиваем консоль
  const topCoin = results[0]?.coin ?? '—';
  const topLine = `[Scout] ${results.length} coins with smoothedApy > 0 | top: ${topCoin} @ ${results[0]?.smoothedApy.toFixed(2) ?? 0}%`;

  if (topCoin !== prevTopCoin) {
    prevTopCoin = topCoin;
    logger.info(topLine);
  } else {
    logger.debug(topLine);
  }

  return results;
}
