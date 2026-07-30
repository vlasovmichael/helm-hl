// ─────────────────────────────────────────────────
//  HL /info — единая точка входа, semaphore + retry
// ─────────────────────────────────────────────────
//
// Why: до этого каждый модуль (scout, dashboard, volatility, candleCache,
// sync, wallet, exchange, userFills) делал свой axios.post / fetch к
// api.hyperliquid.xyz/info. Дашбордовский enrichVolMult бросал 20
// параллельных candleSnapshot каждые ~30s и системно ловил 429,
// рикошетом убивая Scout. Здесь — глобальный потолок concurrency,
// мин-gap и retry с уважением к Retry-After.

import axios from 'axios';
import { retryWithBackoff } from './retry.js';
import { logger } from './logger.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

// 🚨 ГЛАВНОЕ ПРО ЛИМИТ HL (2026-07-30, после 7 безуспешных фиксов 429).
// Лимит /info — НЕ 1200 запросов в минуту, а 1200 ЕДИНИЦ ВЕСА в минуту на IP.
// Вес зависит от типа запроса (см. WEIGHTS ниже): большинство info-запросов
// весят 20, «лёгкие» (allMids/l2Book/clearinghouseState/…) — 2, userRole — 60.
// То есть тяжёлых запросов можно ~60/мин = ОДИН В СЕКУНДУ, а не 20/сек, как
// считал прежний комментарий здесь. Все прежние фиксы крутили concurrency и
// паузы, но считали ШТУКИ — поэтому 429 всегда возвращались (368 шт/сутки на
// 30.07). Ниже — бюджет по весу со скользящим окном 60с; concurrency/min-gap
// оставлены как защита от мгновенных залпов.
const MAX_CONCURRENT = parseInt(process.env.HL_MAX_CONCURRENT || '2', 10);
// Слоты, зарезервированные под торговый путь (HIGH): цены/позиции/ордера/scout.
// NORMAL/LOW не могут занять последние RESERVED_HIGH слотов — иначе один
// медленный/сломанный эндпоинт (напр. userFills, отдающий 500 через 10с)
// монополизирует весь пул и ослепляет бота. Приоритет очереди только
// переупорядочивает ожидающих — он НЕ вытесняет уже занятый слот, поэтому без
// резерва HIGH всё равно голодает. Здесь HIGH всегда имеет гарантированный слот.
const RESERVED_HIGH = parseInt(process.env.HL_RESERVED_HIGH || '1', 10);
const MIN_GAP_MS    = parseInt(process.env.HL_MIN_GAP_MS      || '75', 10);
const TIMEOUT_MS    = parseInt(process.env.HL_TIMEOUT_MS      || '8000', 10);
// Глобальная пауза после 429 — пока кулдаун активен, никакие новые запросы
// не уходят. Все ретраи скоординированно ждут вместо рассинхронных залпов.
const COOLDOWN_429_MS = parseInt(process.env.HL_COOLDOWN_429_MS || '3000', 10);

// Бюджет веса за окно. Держим ниже документированных 1200: HL считает по своему
// таймеру, а мы не видим его окна — 15% запаса дешевле, чем кулдаун после 429.
const WEIGHT_BUDGET    = parseInt(process.env.HL_WEIGHT_BUDGET || '1000', 10);
const WEIGHT_WINDOW_MS = 60_000;
// Доля бюджета, доступная НЕ-торговому пути. Остаток — резерв под HIGH
// (цены/позиции/ордера), чтобы косметика дашборда не могла выесть весь лимит и
// ослепить бота. Ср. RESERVED_HIGH для слотов concurrency.
const WEIGHT_LOW_SHARE = parseFloat(process.env.HL_WEIGHT_LOW_SHARE || '0.7');

// Вес по типу запроса (docs Hyperliquid, раздел Rate limits → /info weights).
const WEIGHT_LIGHT = new Set([
  'l2Book', 'allMids', 'clearinghouseState', 'orderStatus',
  'spotClearinghouseState', 'exchangeStatus',
]);
const WEIGHT_HEAVY = { userRole: 60 };
const WEIGHT_DEFAULT = 20;

/** Вес одного запроса. Экспортируется для тестов и диагностики. */
export function weightOf(body) {
  const type = body?.type;
  if (WEIGHT_HEAVY[type]) return WEIGHT_HEAVY[type];
  return WEIGHT_LIGHT.has(type) ? 2 : WEIGHT_DEFAULT;
}

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

// Приоритеты очереди. Торговый путь (позиции/баланс/цены/ордера/scout) должен
// обходить косметику дашборда (volMult/htf/divergence/whale) — иначе бурст
// тяжёлых candleSnapshot выжирает весовой бюджет HL, ловит 429-кулдаун и
// рикошетом тормозит критичные вызовы бота. Больше число → раньше из очереди.
export const HL_PRIORITY = { HIGH: 2, NORMAL: 1, LOW: 0 };

let inFlight = 0;
let lastSentAt = 0;
let cooldownUntil = 0;
let seq = 0; // монотонный счётчик для FIFO внутри одного приоритета
const waiters = []; // { priority, seq, resolve }

// Потолок одновременных запросов для данного приоритета. HIGH видит весь пул;
// NORMAL/LOW — пул минус зарезервированные под HIGH слоты (минимум 1, чтобы
// низкий приоритет не заблокировался полностью при малом MAX_CONCURRENT).
function capacityFor(priority) {
  if (priority >= HL_PRIORITY.HIGH) return MAX_CONCURRENT;
  return Math.max(1, MAX_CONCURRENT - RESERVED_HIGH);
}

function acquire(priority = HL_PRIORITY.NORMAL) {
  if (inFlight < capacityFor(priority)) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push({ priority, seq: seq++, resolve });
  });
}

// Берём ожидающего с высшим приоритетом, КОТОРОМУ уже разрешён слот при текущем
// inFlight (резерв под HIGH соблюдается и на пути release, а не только acquire).
// При равном приоритете — самый ранний (FIFO, без голодания внутри приоритета).
function takeEligibleWaiter() {
  let bestIdx = -1;
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    if (inFlight >= capacityFor(w.priority)) continue; // резерв не пускает
    if (bestIdx === -1) {
      bestIdx = i;
      continue;
    }
    const b = waiters[bestIdx];
    if (w.priority > b.priority || (w.priority === b.priority && w.seq < b.seq)) {
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  return waiters.splice(bestIdx, 1)[0];
}

function release() {
  inFlight--;
  // Освободившийся слот может разблокировать несколько ожидающих (обычно 0–1).
  let next;
  while ((next = takeEligibleWaiter())) {
    inFlight++;
    next.resolve();
  }
}

// ── Весовой бюджет: скользящее окно 60с ──────────────────────────────────────
// spent — потраченный вес, отсортирован по времени (push в конец, shift с начала).
const spent = [];      // { at, w }
let spentSum = 0;
let weightWaitMs = 0;  // накопленное ожидание бюджета — видно в hlClientStats
let weightWaits  = 0;

function pruneSpent(now) {
  while (spent.length && now - spent[0].at >= WEIGHT_WINDOW_MS) {
    spentSum -= spent.shift().w;
  }
}

/** Сколько веса доступно этому приоритету (HIGH видит весь бюджет). */
function budgetFor(priority) {
  return priority >= HL_PRIORITY.HIGH
    ? WEIGHT_BUDGET
    : Math.floor(WEIGHT_BUDGET * WEIGHT_LOW_SHARE);
}

/**
 * Ждёт, пока в окне освободится место под вес `w`, и списывает его.
 * Проверка и списание идут без await между ними → гонки между конкурентными
 * вызовами нет (JS однопоточный), двойное списание невозможно.
 */
async function reserveWeight(w, priority) {
  const budget = budgetFor(priority);
  const startedAt = Date.now();
  for (;;) {
    const now = Date.now();
    pruneSpent(now);
    if (spentSum + w <= budget) {
      spent.push({ at: now, w });
      spentSum += w;
      const waited = now - startedAt;
      if (waited > 0) { weightWaitMs += waited; weightWaits++; }
      return;
    }
    // Ждём, пока самая старая запись выпадет из окна (+5мс на дребезг таймера).
    const freeIn = WEIGHT_WINDOW_MS - (now - spent[0].at) + 5;
    await new Promise((r) => setTimeout(r, Math.min(Math.max(freeIn, 25), 2000)));
  }
}

async function gap() {
  // Сначала ждём глобальный 429-кулдаун если активен.
  const cdRemain = cooldownUntil - Date.now();
  if (cdRemain > 0) {
    await new Promise((r) => setTimeout(r, cdRemain));
  }
  const elapsed = Date.now() - lastSentAt;
  if (elapsed < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
  }
  lastSentAt = Date.now();
}

function trip429() {
  const newUntil = Date.now() + COOLDOWN_429_MS;
  if (newUntil > cooldownUntil) cooldownUntil = newUntil;
}

/**
 * Один POST на /info с retry, semaphore и min-gap.
 *
 * @param {Object} body — payload запроса (например { type: 'metaAndAssetCtxs' })
 * @param {Object} [opts]
 * @param {string} [opts.label]      — метка для логов retry (например 'scout/markets')
 * @param {number} [opts.timeoutMs]  — override таймаута
 * @param {number} [opts.maxRetries] — override числа попыток (default 3)
 * @param {number} [opts.priority]   — HL_PRIORITY.HIGH|NORMAL|LOW (default NORMAL)
 * @returns {Promise<any>} data из ответа HL
 */
export async function hlInfo(body, opts = {}) {
  const { label = 'hl/info', timeoutMs, maxRetries = 3, priority = HL_PRIORITY.NORMAL } = opts;

  const weight = weightOf(body);

  return retryWithBackoff(
    async () => {
      // Бюджет ЖДЁМ ДО слота: иначе запрос, которому не хватает веса, держал бы
      // слот concurrency и блокировал торговый путь.
      await reserveWeight(weight, priority);
      await acquire(priority);
      try {
        await gap();
        const response = await axios.post(HL_INFO_URL, body, {
          timeout: timeoutMs ?? TIMEOUT_MS,
          headers: DEFAULT_HEADERS,
        });
        return response.data;
      } catch (err) {
        // На 429 — взводим глобальный кулдаун, чтобы остальные запросы в очереди
        // дождались вместо параллельного ретрая. Retry-After в секундах если есть.
        if (err.response?.status === 429) {
          const retryAfter = parseInt(err.response.headers?.['retry-after'] ?? '0', 10);
          if (retryAfter > 0) {
            const until = Date.now() + retryAfter * 1000;
            if (until > cooldownUntil) cooldownUntil = until;
          } else {
            trip429();
          }
        }
        throw err;
      } finally {
        release();
      }
    },
    // LOW-приоритет = косметика дашборда (volMult/htf/divergence/whale). Её 429
    // и ретраи логируем тихо (debug): они безвредны (гасятся в null) и раньше
    // забивали лог «авариями», маскируя реальные торговые сбои.
    { maxRetries, label, quiet: priority === HL_PRIORITY.LOW },
  );
}

/**
 * Диагностика — сколько запросов сейчас в полёте и в очереди.
 * Можно дернуть из дашборда / лог-снапшота.
 */
export function hlClientStats() {
  pruneSpent(Date.now());
  return {
    inFlight,
    queued: waiters.length,
    maxConcurrent: MAX_CONCURRENT,
    reservedHigh: RESERVED_HIGH,
    minGapMs: MIN_GAP_MS,
    cooldownRemainMs: Math.max(0, cooldownUntil - Date.now()),
    // Вес за последние 60с — главный индикатор близости к лимиту HL.
    weightUsed: spentSum,
    weightBudget: WEIGHT_BUDGET,
    weightPct: Math.round((spentSum / WEIGHT_BUDGET) * 100),
    weightWaits,
    weightWaitMs,
  };
}

// Раз в 5 минут — сколько веса реально жжём. Если weightPct стабильно <70% и
// 429 всё равно идут, значит вес какого-то типа занижен в WEIGHTS.
setInterval(() => {
  const s = hlClientStats();
  logger.info(
    `[HL] вес за 60с: ${s.weightUsed}/${s.weightBudget} (${s.weightPct}%) | ` +
      `ожиданий бюджета: ${s.weightWaits} (${(s.weightWaitMs / 1000).toFixed(1)}с суммарно) | ` +
      `in-flight=${s.inFlight} queued=${s.queued}`,
  );
}, 5 * 60_000).unref?.();

logger.info(
  `[HL] info-client: max_concurrent=${MAX_CONCURRENT}, ` +
  `reserved_high=${RESERVED_HIGH}, ` +
  `min_gap_ms=${MIN_GAP_MS}, timeout_ms=${TIMEOUT_MS}, ` +
  `cooldown_429_ms=${COOLDOWN_429_MS}, ` +
  `weight_budget=${WEIGHT_BUDGET}/60с (low-share ${Math.round(WEIGHT_LOW_SHARE * 100)}%)`,
);
