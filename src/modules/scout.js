import axios from 'axios';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { setUniverse, getTradeableSet } from '../core/universe.js';
import { getRuntimeBlacklist, getOiCapBans } from './executor/index.js';
import { push as pushPriceHistory } from '../core/priceHistory.js';

const HL_API   = 'https://api.hyperliquid.xyz/info';
const RTT_LIMIT_MS = 10_000; // отклоняем ответы медленнее 10 с

// ── Predictive Funding ─────────────────────────
const PREDICTED_FUNDING_CACHE_MS = 5 * 60_000; // биржа обновляет раз в час, кеш 5 мин

let predictedCache = { ts: 0, map: new Map() };

// ── Liquidity whitelist ────────────────────────
// Хранит Set из UPPERCASE-имён монет, прошедших двойной фильтр:
//   (1) dayNtlVlm ≥ LIQUID_MIN_VOLUME (hard floor)
//   (2) top-N по dayNtlVlm среди уцелевших
// Ребилдится не чаще, чем раз в LIQUID_CACHE_HOURS — чтобы сам whitelist
// не «дёргался» и позиции не вылетали из-за транзиентных изменений объёма.
let liquidCache = { ts: 0, set: new Set() };
let hunterCache = { ts: 0, set: new Set() };

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
 * Ребилдит whitelist ликвидных монет при истечении кеша.
 * Читает dayNtlVlm из assetCtxs (строка в USDC), применяет пол и top-N.
 *
 * На первом тике (ts=0) отработает сразу. В дальнейшем — раз в
 * config.trading.liquidCacheMs. Fail-safe: если в свежем снэпшоте
 * ни одна монета не прошла фильтр, старый кеш НЕ трогаем — иначе
 * временный сбой данных обнулит whitelist и Scout вернёт пусто.
 */
function refreshLiquidWhitelist(universe, assetCtxs) {
  const { liquidTopN, liquidMinVolume, liquidCacheMs } = config.trading;

  if (Date.now() - liquidCache.ts < liquidCacheMs && liquidCache.set.size > 0) {
    return liquidCache.set;
  }

  const candidates = [];
  for (let i = 0; i < universe.length; i++) {
    const coin = universe[i]?.name;
    const vol  = parseFloat(assetCtxs[i]?.dayNtlVlm ?? 0);
    if (!coin || isNaN(vol)) continue;
    if (vol < liquidMinVolume) continue;
    candidates.push({ coin: coin.toUpperCase(), vol });
  }

  if (candidates.length === 0) {
    logger.warn(
      `[Scout] Liquid whitelist: no coins passed floor $${(liquidMinVolume / 1e6).toFixed(0)}M — ` +
      `keeping previous whitelist (${liquidCache.set.size} coins)`,
    );
    return liquidCache.set;
  }

  candidates.sort((a, b) => b.vol - a.vol);
  const top = candidates.slice(0, liquidTopN);
  const set = new Set(top.map((c) => c.coin));

  liquidCache = { ts: Date.now(), set };

  const cutoffVol = top[top.length - 1].vol;
  logger.info(
    `[Scout] Liquid whitelist refreshed: ${set.size}/${candidates.length} coins | ` +
    `floor $${(liquidMinVolume / 1e6).toFixed(0)}M | cutoff $${(cutoffVol / 1e6).toFixed(1)}M | ` +
    `next refresh in ${(liquidCacheMs / 3_600_000).toFixed(1)}h`,
  );

  return set;
}

/**
 * Отдельный whitelist для Sniper-Hunter. Более мягкий volume-floor
 * (HUNTER_MIN_VOLUME, default $1M), без top-N cap — Hunter готов охотиться
 * на более волатильных mid-cap перпах, carry/fade туда не полезут.
 * Тот же cache-period, что и у основного liquidSet.
 */
function refreshHunterWhitelist(universe, assetCtxs) {
  const { hunterMinVolume, liquidCacheMs } = config.trading;

  if (Date.now() - hunterCache.ts < liquidCacheMs && hunterCache.set.size > 0) {
    return hunterCache.set;
  }

  const set = new Set();
  for (let i = 0; i < universe.length; i++) {
    const coin = universe[i]?.name;
    const vol  = parseFloat(assetCtxs[i]?.dayNtlVlm ?? 0);
    if (!coin || isNaN(vol)) continue;
    if (vol < hunterMinVolume) continue;
    set.add(coin.toUpperCase());
  }

  if (set.size === 0) {
    logger.warn(
      `[Scout] Hunter whitelist: no coins passed floor $${(hunterMinVolume / 1e6).toFixed(1)}M — ` +
      `keeping previous (${hunterCache.set.size} coins)`,
    );
    return hunterCache.set;
  }

  hunterCache = { ts: Date.now(), set };
  logger.info(
    `[Scout] Hunter whitelist refreshed: ${set.size} coins | floor $${(hunterMinVolume / 1e6).toFixed(1)}M`,
  );

  return set;
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

  // Liquid whitelist (6ч кеш, fail-safe если снэпшот пуст) — для carry/fade
  const liquidSet = refreshLiquidWhitelist(universe, assetCtxs);
  // Hunter whitelist (более мягкий volume-floor) — только для Strategy #3
  const hunterSet = refreshHunterWhitelist(universe, assetCtxs);

  // Predictive funding (5min cache, fail-open)
  const predictedFundings = await fetchPredictedFundings();

  // ── Защита: блэклист + universe + runtime + OI cap + liquidity ──
  const tradeable       = getTradeableSet(); // из core/universe.js
  const blacklist       = config.trading.coinBlacklist;
  const runtimeBlocked  = getRuntimeBlacklist();
  const oiCapBlocked    = getOiCapBans();

  // Логируем фильтры на INFO только при изменении, иначе debug
  const filterSnap = `${universe.length}|${tradeable.size}|${blacklist.size}|${runtimeBlocked.size}|${oiCapBlocked.size}|${liquidSet.size}`;
  if (filterSnap !== prevFilterSnapshot) {
    prevFilterSnapshot = filterSnap;
    logger.info(
      `[Scout] Filters: API universe=${universe.length} | tradeable=${tradeable.size} | ` +
      `blacklist=${blacklist.size} | runtime-banned=${runtimeBlocked.size} | ` +
      `oi-cap-banned=${oiCapBlocked.size} | liquid=${liquidSet.size}`,
    );
  } else {
    logger.debug(
      `[Scout] Filters: API universe=${universe.length} | tradeable=${tradeable.size} | ` +
      `blacklist=${blacklist.size} | runtime-banned=${runtimeBlocked.size} | ` +
      `oi-cap-banned=${oiCapBlocked.size} | liquid=${liquidSet.size}`,
    );
  }

  const results       = [];  // для carry/fade (узкая liquid-вселенная)
  const hunterResults = [];  // для Hunter (шире — по hunterSet)
  let skippedBlacklist     = 0;
  let skippedUntradeable   = 0;
  let skippedRuntime       = 0;
  let skippedOiCap         = 0;
  let skippedIlliquid      = 0;

  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx   = assetCtxs[i];

    const coin = asset?.name;
    if (!coin || !ctx) continue;

    const coinUpper = coin.toUpperCase();

    // ── Safety-фильтры (применяются и к carry/fade, и к Hunter) ──

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
    if (tradeable.size > 0 && !tradeable.has(coinUpper)) {
      skippedUntradeable++;
      continue;
    }

    const price = parseFloat(ctx.markPx ?? ctx.midPx ?? 0);
    if (isNaN(price)) continue;

    // ── Hunter scope: shirоkий volume-floor, отдельная вселенная ──
    const inHunterSet = hunterSet.size === 0 || hunterSet.has(coinUpper);
    if (inHunterSet) {
      // Доп. фичи рынка для extended-логирования (см. database.js миграция).
      // Все nullable: при missing в API будут null'ы в БД, не блокируем сигнал.
      const fundingRate = parseFloat(ctx.funding ?? NaN);
      const dayNtlVlm   = parseFloat(ctx.dayNtlVlm ?? NaN);
      const oiCoin      = parseFloat(ctx.openInterest ?? NaN);
      const oiUsd       = Number.isFinite(oiCoin) ? oiCoin * price : null;
      hunterResults.push({
        coin,
        price,
        fundingRate:   Number.isFinite(fundingRate) ? fundingRate : null,
        volume24hUsd:  Number.isFinite(dayNtlVlm)   ? dayNtlVlm   : null,
        oiUsd,
      });
      // Hunter читает priceHistory для детекции спайков — наполняем её
      // для всего hunter-scope (шире, чем carry/fade видят).
      pushPriceHistory(coin, price);
    }

    // ── Carry/Fade scope: тот же price + funding, но только для liquidSet ──
    if (liquidSet.size > 0 && !liquidSet.has(coinUpper)) {
      skippedIlliquid++;
      continue;
    }

    const fundingRate = parseFloat(ctx.funding ?? 0);
    if (isNaN(fundingRate)) continue;

    const rawApy = fundingRate * 24 * 365 * 100;
    const { fast, slow } = updateEma(coin, rawApy);

    // Под флагом carryLongEnabled пускаем и отрицательный fast (long-сторона).
    // Без флага — старое поведение: только положительный funding (short).
    if (config.trading.carryLongEnabled) {
      if (fast === 0) continue;
    } else {
      if (fast <= 0) continue;
    }

    const side = fast >= 0 ? 'short' : 'long';

    const predictedRate = predictedFundings.get(coin);
    const predictedApy  = predictedRate != null ? predictedRate * 24 * 365 * 100 : null;

    results.push({ coin, price, fundingRate, rawApy, smoothedApy: fast, slowApy: slow, predictedApy, side });
  }

  if (skippedBlacklist > 0 || skippedUntradeable > 0 || skippedRuntime > 0 || skippedOiCap > 0 || skippedIlliquid > 0) {
    logger.debug(
      `[Scout] Filtered out: ${skippedBlacklist} blacklisted, ${skippedUntradeable} untradeable, ` +
      `${skippedRuntime} runtime-blocked, ${skippedOiCap} oi-cap-blocked, ` +
      `${skippedIlliquid} illiquid`,
    );
  }

  // Под флагом carryLongEnabled сортируем по абсолютному APY (long-сторона
  // тоже годится), без флага — по знаку (только short-кандидаты).
  if (config.trading.carryLongEnabled) {
    results.sort((a, b) => Math.abs(b.smoothedApy) - Math.abs(a.smoothedApy));
  } else {
    results.sort((a, b) => b.smoothedApy - a.smoothedApy);
  }

  // INFO при смене лидера, иначе debug — не забиваем консоль
  const topCoin = results[0]?.coin ?? '—';
  const topLine = `[Scout] ${results.length} coins with smoothedApy > 0 | top: ${topCoin} @ ${results[0]?.smoothedApy.toFixed(2) ?? 0}%`;

  if (topCoin !== prevTopCoin) {
    prevTopCoin = topCoin;
    logger.info(topLine);
  } else {
    logger.debug(topLine);
  }

  return { scoutData: results, hunterData: hunterResults };
}
