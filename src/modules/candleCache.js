// ─────────────────────────────────────────────────
//  Candle Cache — 1h OHLC с TTL-кэшем
// ─────────────────────────────────────────────────
// Обёртка над Hyperliquid candleSnapshot для Strategy #4 (trend_follow).
// TTL 5 мин: 1ч-свечи закрываются раз в час, проверять чаще = тратить квоту API.
//
// Возвращает массив объектов {open, high, low, close, time} oldest→newest.

import { logger } from '../core/logger.js';
import { hlInfo, HL_PRIORITY } from '../core/hlClient.js';
import { resolveApiCoin } from '../core/universe.js';

const TTL_MS   = 5 * 60_000;
const INTERVAL = '1h';

// coin → { fetchedAt, lastAccess, candles, inflight }
const cache = new Map();

// ── Вытеснение: почему у кэшей должен быть потолок ──────────────────────────
//
// Инцидент 2026-08-09 11:51: контейнер упал с
//   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap OOM
// при rss всего 242 из 512 МБ и чистом dmesg — то есть это НЕ cgroup-OOM, как
// 02.08, а потолок самого V8. Подъём лимита контейнера 256→512 МБ тогда лишь
// сдвинул режим отказа: Node 20 выводит heap_size_limit из cgroup и поставил
// себе 259 МБ, в который куча упирается раньше, чем rss в лимит ядра.
//
// Росли именно эти четыре карты. TTL здесь решал только «идти в сеть или отдать
// кэш» — записи не удалялись НИКОГДА (clear*() существуют лишь для тестов).
// Скаут и movers ходят по широкой вселенной (~1011 монет в PriceFeed против 232
// в Universe), поэтому набор задетых монет расползался сутками: +1.9 МБ/ч
// поверх базовых ~130 МБ и упор в потолок примерно за трое суток.
//
// Вытесняем по lastAccess, а НЕ по fetchedAt — это важно для деградации: когда
// весовой бюджет занят, onFetchFail намеренно отдаёт протухшие свечи, при этом
// fetchedAt стоит на месте, а обращения идут. По fetchedAt мы бы выбросили ровно
// то, что сейчас нужнее всего (см. candleCacheDegrade.test.js).
const EVICT_IDLE_MS     = parseInt(process.env.CANDLE_CACHE_IDLE_MS     || String(2 * 60 * 60_000), 10);
// Жёсткий backstop на случай, если монеты трогают чаще, чем идёт вытеснение:
// 400 > 232 монет Universe, то есть рабочий набор скана не страдает.
const EVICT_MAX_ENTRIES = parseInt(process.env.CANDLE_CACHE_MAX_ENTRIES || '400', 10);
// Подметать чаще нет смысла: это O(размер карты) и растёт всё медленно.
const SWEEP_MIN_GAP_MS  = 5 * 60_000;

const CACHES = [];   // [{ name, store }] — заполняется в конце файла
let lastSweepAt = 0;

/** Отметить обращение к монете: продлевает жизнь записи (см. блок выше). */
function markAccess(store, coin, now) {
  const entry = store.get(coin);
  if (entry) entry.lastAccess = now;
}

/**
 * Парсит ответ candleSnapshot в наш формат.
 * Hyperliquid возвращает поля: t (open time), c (close), h (high), l (low),
 * o (open), v (base volume). vol nullable — старые сиды в тестах его не кладут.
 */
function parseCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => ({
      time:  Number(c.t),
      open:  parseFloat(c.o),
      high:  parseFloat(c.h),
      low:   parseFloat(c.l),
      close: parseFloat(c.c),
      vol:   Number.isFinite(parseFloat(c.v)) ? parseFloat(c.v) : null,
    }))
    .filter((c) =>
      Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.high > 0,
    );
}

/**
 * Общий обработчик неудачного fetch'а для всех четырёх кэшей.
 *
 * Отказ по весовому бюджету (isWeightTimeout) — это НЕ авария: клиент HL
 * намеренно отшивает косметику, когда бюджет занят торговым путём. В этом
 * случае отдаём протухшие свечи, если они есть: устаревший 1h-тренд полезнее
 * пустоты, а на торговые решения такой источник и не влияет (там свой путь).
 */
function onFetchFail(store, coin, err, tag) {
  const prev = store.get(coin);
  store.set(coin, { ...(prev || {}), inflight: null });
  if (err.isWeightTimeout) {
    logger.debug(`[${tag}] #${coin} — бюджет занят, отдаю кэш (${err.message})`);
    return prev?.candles ?? null;
  }
  logger.warn(`[${tag}] #${coin} fetch failed: ${err.message}`);
  return null;
}

/**
 * Получает 1h свечи для монеты. С кэшем + защитой от одновременных fetch'ей.
 *
 * @param {string} coin
 * @param {number} lookbackHours — сколько часов истории нужно (минимум atrLong+1)
 * @param {number} [now=Date.now()]
 * @param {number} [priority=HL_PRIORITY.NORMAL] — LOW для косметики дашборда
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getHourlyCandles(coin, lookbackHours, now = Date.now(), priority = HL_PRIORITY.NORMAL) {
  markAccess(cache, coin, now);
  const cached = cache.get(coin);
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.candles;
  }
  // Если уже идёт fetch — ждём его, не делаем дубль.
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackHours * 3_600_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache/${coin}`, priority },
  ).then((data) => {
    const candles = parseCandles(data);
    cache.set(coin, { fetchedAt: Date.now(), lastAccess: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => onFetchFail(cache, coin, err, 'CandleCache'));

  cache.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Очистить кэш (тесты). */
export function clearCandleCache() {
  cache.clear();
}

/** Прямая инжекция (тесты): задаёт «свежие» свечи без fetch'а. */
export function seedCandleCache(coin, candles, now = Date.now()) {
  cache.set(coin, { fetchedAt: now, lastAccess: now, candles, inflight: null });
}

// ── 5-минутные свечи (для Candy Girl радара) ────────────────────────────────
// Отдельный кэш с более коротким TTL: 5m-свечи закрываются раз в 5 мин, держим
// 60s чтобы радар видел свежий reclaim, но не молотил API каждый тик.
const FIVE_MIN_TTL_MS   = 60_000;
const FIVE_MIN_INTERVAL = '5m';
const cache5m = new Map();   // coin → { fetchedAt, candles, inflight }

/**
 * Получает 5m свечи для монеты. Зеркало getHourlyCandles, свой кэш + interval.
 *
 * @param {string} coin
 * @param {number} lookbackMinutes — сколько минут истории нужно
 * @param {number} [now=Date.now()]
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getFiveMinCandles(coin, lookbackMinutes, now = Date.now()) {
  markAccess(cache5m, coin, now);
  const cached = cache5m.get(coin);
  if (cached && now - cached.fetchedAt < FIVE_MIN_TTL_MS) {
    return cached.candles;
  }
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackMinutes * 60_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: FIVE_MIN_INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache5m/${coin}` },
  ).then((data) => {
    const candles = parseCandles(data);
    cache5m.set(coin, { fetchedAt: Date.now(), lastAccess: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => onFetchFail(cache5m, coin, err, 'CandleCache5m'));

  cache5m.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Прямая инжекция 5m-свечей (тесты). */
export function seedFiveMinCache(coin, candles, now = Date.now()) {
  cache5m.set(coin, { fetchedAt: now, lastAccess: now, candles, inflight: null });
}

/** Очистить 5m-кэш (тесты). */
export function clearFiveMinCache() {
  cache5m.clear();
}

// ── 15-минутные свечи (для fade-high-ER сигнала, см. fadeHotSignal.js) ───────
// Сигнал считает ход за 30м (2×15m) и Kaufman ER за 4ч (16×15m) → нужна 15m-
// история. 15m-свеча закрывается раз в 15 мин → TTL 90с: свежесть последнего
// бара без шторма candleSnapshot (тяжёлый запрос, см. 429-заметки выше).
const FIFTEEN_MIN_TTL_MS   = 90_000;
const FIFTEEN_MIN_INTERVAL = '15m';
const cache15m = new Map();   // coin → { fetchedAt, candles, inflight }

/**
 * Получает 15m свечи для монеты. Зеркало getFiveMinCandles, свой кэш + interval.
 *
 * @param {string} coin
 * @param {number} lookbackMinutes — сколько минут истории нужно
 * @param {number} [now=Date.now()]
 * @param {number} [priority=HL_PRIORITY.LOW] — косметика/paper, не торговое чтение
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getFifteenMinCandles(coin, lookbackMinutes, now = Date.now(), priority = HL_PRIORITY.LOW) {
  markAccess(cache15m, coin, now);
  const cached = cache15m.get(coin);
  if (cached && now - cached.fetchedAt < FIFTEEN_MIN_TTL_MS) {
    return cached.candles;
  }
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackMinutes * 60_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: FIFTEEN_MIN_INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache15m/${coin}`, priority },
  ).then((data) => {
    const candles = parseCandles(data);
    cache15m.set(coin, { fetchedAt: Date.now(), lastAccess: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => onFetchFail(cache15m, coin, err, 'CandleCache15m'));

  cache15m.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Прямая инжекция 15m-свечей (тесты). */
export function seedFifteenMinCache(coin, candles, now = Date.now()) {
  cache15m.set(coin, { fetchedAt: now, lastAccess: now, candles, inflight: null });
}

/** Очистить 15m-кэш (тесты). */
export function clearFifteenMinCache() {
  cache15m.clear();
}

// ── 4-часовые свечи (для Candy Girl 4h HTF-confluence) ──────────────────────
// 4h-свеча закрывается раз в 4 часа → TTL 15 мин (тренд старшего ТФ медленный,
// частый refetch смысла не имеет). Своя карта, свой interval.
const FOUR_HOUR_TTL_MS   = 15 * 60_000;
const FOUR_HOUR_INTERVAL = '4h';
const cache4h = new Map();   // coin → { fetchedAt, candles, inflight }

/**
 * Получает 4h свечи для монеты. Зеркало getHourlyCandles, свой кэш + interval.
 *
 * @param {string} coin
 * @param {number} lookbackHours — сколько часов истории нужно
 * @param {number} [now=Date.now()]
 * @returns {Promise<Array<{open,high,low,close,time}>|null>}
 */
export async function getFourHourCandles(coin, lookbackHours, now = Date.now()) {
  markAccess(cache4h, coin, now);
  const cached = cache4h.get(coin);
  if (cached && now - cached.fetchedAt < FOUR_HOUR_TTL_MS) {
    return cached.candles;
  }
  if (cached?.inflight) {
    try { return await cached.inflight; } catch { return null; }
  }

  const startTime = now - lookbackHours * 3_600_000;
  const promise = hlInfo(
    {
      type: 'candleSnapshot',
      req:  { coin: resolveApiCoin(coin), interval: FOUR_HOUR_INTERVAL, startTime, endTime: now },
    },
    { label: `candleCache4h/${coin}` },
  ).then((data) => {
    const candles = parseCandles(data);
    cache4h.set(coin, { fetchedAt: Date.now(), lastAccess: Date.now(), candles, inflight: null });
    return candles;
  }).catch((err) => onFetchFail(cache4h, coin, err, 'CandleCache4h'));

  cache4h.set(coin, { ...(cached || {}), inflight: promise });
  return promise;
}

/** Прямая инжекция 4h-свечей (тесты). */
export function seedFourHourCache(coin, candles, now = Date.now()) {
  cache4h.set(coin, { fetchedAt: now, lastAccess: now, candles, inflight: null });
}

/** Очистить 4h-кэш (тесты). */
export function clearFourHourCache() {
  cache4h.clear();
}

// ── Подметалка ──────────────────────────────────────────────────────────────
// Регистрируем все четыре карты в одном месте (после их объявления), чтобы
// вытеснение было общим и никакой пятый кэш не завёлся мимо него.
CACHES.push(
  { name: '1h',  store: cache },
  { name: '5m',  store: cache5m },
  { name: '15m', store: cache15m },
  { name: '4h',  store: cache4h },
);

/**
 * Вытесняет давно не используемые записи из всех кэшей свечей.
 *
 * Два правила, второе — страховка первого:
 *   1) idle > EVICT_IDLE_MS по lastAccess — монету перестали смотреть;
 *   2) size > EVICT_MAX_ENTRIES — выкидываем самые давние по lastAccess.
 * Записи с inflight не трогаем никогда: их ждёт await в getters, удаление
 * карты из-под промиса привело бы к повторному сетевому запросу.
 *
 * Вызывается из tick() — там же, где живёт весь остальной периодический труд.
 * Сам себя троттлит (SWEEP_MIN_GAP_MS), поэтому звать можно хоть каждый тик.
 *
 * @param {number} [now=Date.now()]
 * @param {{force?: boolean}} [opts] — force обходит троттл (тесты)
 * @returns {{evicted:number, kept:number}|null} — null если троттл пропустил
 */
export function sweepCandleCaches(now = Date.now(), { force = false } = {}) {
  if (!force && now - lastSweepAt < SWEEP_MIN_GAP_MS) return null;
  lastSweepAt = now;

  let evicted = 0;
  let kept    = 0;
  const parts = [];

  for (const { name, store } of CACHES) {
    const before = store.size;

    for (const [coin, entry] of store) {
      if (entry.inflight) continue;
      if (now - (entry.lastAccess ?? entry.fetchedAt ?? 0) > EVICT_IDLE_MS) store.delete(coin);
    }

    if (store.size > EVICT_MAX_ENTRIES) {
      const victims = [...store.entries()]
        .filter(([, e]) => !e.inflight)
        .sort((a, b) => (a[1].lastAccess ?? 0) - (b[1].lastAccess ?? 0))
        .slice(0, store.size - EVICT_MAX_ENTRIES);
      for (const [coin] of victims) store.delete(coin);
    }

    evicted += before - store.size;
    kept    += store.size;
    if (before !== store.size) parts.push(`${name}: ${before}→${store.size}`);
  }

  if (evicted > 0) {
    logger.info(`[CandleCache] вытеснено ${evicted}, осталось ${kept} | ${parts.join(', ')}`);
  }
  return { evicted, kept };
}

/** Размеры кэшей — для [Mem]-строки и тестов. */
export function candleCacheStats() {
  const sizes = {};
  let total = 0;
  for (const { name, store } of CACHES) {
    sizes[name] = store.size;
    total += store.size;
  }
  return { sizes, total };
}

/** Сброс троттла подметалки (тесты). */
export function _resetSweepThrottleForTest() {
  lastSweepAt = 0;
}
