// ─────────────────────────────────────────────────
//  Price History — per-coin ring buffer (in-memory)
// ─────────────────────────────────────────────────
// Используется Sniper-Hunter'ом (strategistHunter.js) для детекции
// спайков (|Δprice| за N минут). Iter A.1: только API, без интеграции.
// Наполнение из scout.js добавится в Iter A.3.
//
// Окно буфера — 4ч: покрывает Hunter (2-мин спайк + до 15-мин anti-trend)
// и Market-Regime velocity gate (двухбакетный: 30мин + 2ч).
// В памяти: Map<coin, Array<{ts, price}>>, сэмплы ASC по ts.
// Restart: буфер пуст, первые N мин после старта strategist/hunter спит.

const HISTORY_WINDOW_MS = 4 * 60 * 60_000;

const buffers = new Map();

/**
 * Добавляет сэмпл цены. Автоматически подрезает сэмплы старше окна (4ч).
 * Невалидные цены (NaN, <=0) silent-ignore.
 */
export function push(coin, price, ts = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return;
  let arr = buffers.get(coin);
  if (!arr) {
    arr = [];
    buffers.set(coin, arr);
  }
  arr.push({ ts, price });
  const cutoff = ts - HISTORY_WINDOW_MS;
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
}

/**
 * Цена, ближайшая (но не позже) чем N минут назад.
 * Возвращает null если буфер пуст или данные слишком свежие (не накоплено N мин).
 *
 * Example: если now=t и minutes=2, ищем последний сэмпл с ts <= t-120s.
 */
export function getPriceNMinAgo(coin, minutes, now = Date.now()) {
  const arr = buffers.get(coin);
  if (!arr || arr.length === 0) return null;
  const targetTs = now - minutes * 60_000;
  // Если даже самый старый сэмпл моложе targetTs → не накопили ещё истории
  if (arr[0].ts > targetTs) return null;
  let result = null;
  for (const s of arr) {
    if (s.ts <= targetTs) result = s;
    else break;  // Массив отсортирован по ts — дальше все новее
  }
  return result ? result.price : null;
}

/**
 * Самый свежий сэмпл цены (последний в буфере). null если буфера нет.
 * Нужен дашборду, чтобы синтезировать строку Hot Movers для удерживаемой
 * монеты, которая выпала из scout-вселенной (см. movers.js).
 */
export function getLatestPrice(coin) {
  const arr = buffers.get(coin);
  if (!arr || arr.length === 0) return null;
  return arr[arr.length - 1].price;
}

/** @returns {boolean} Есть ли в буфере данные минимум на N минут назад. */
export function hasEnoughHistory(coin, minutes, now = Date.now()) {
  return getPriceNMinAgo(coin, minutes, now) !== null;
}

/**
 * Возвращает сэмплы за окно последних `minutes` минут (ASC по ts).
 * Используется Vapor-ом (range/high/low за окно).
 */
export function getSamplesSince(coin, minutes, now = Date.now()) {
  const arr = buffers.get(coin);
  if (!arr || arr.length === 0) return [];
  const fromTs = now - minutes * 60_000;
  const out = [];
  for (const s of arr) {
    if (s.ts >= fromTs) out.push(s);
  }
  return out;
}

/**
 * Даунсэмпл серии цен за последние `minutes` мин в `buckets` равных корзин по
 * времени (last-цена в корзине). Для спарклайна Hot Movers: компактный массив
 * фиксированной длины, дешёвый в JSON. Пустые корзины НЕ заполняем — фронт сам
 * решает, рисовать ли (нужно ≥2 точки). Возвращает массив чисел (цены), ASC.
 * @returns {number[]} — длина ≤ buckets; [] если истории нет.
 */
export function getPriceSpark(coin, minutes = 20, buckets = 24, now = Date.now()) {
  const arr = buffers.get(coin);
  if (!arr || arr.length === 0) return [];
  const fromTs = now - minutes * 60_000;
  const span = now - fromTs;
  if (span <= 0) return [];
  const bw = span / buckets;
  const last = new Array(buckets).fill(null);
  for (const s of arr) {
    if (s.ts < fromTs) continue;
    let bi = Math.floor((s.ts - fromTs) / bw);
    if (bi < 0) bi = 0;
    if (bi >= buckets) bi = buckets - 1;
    last[bi] = s.price; // last-цена в корзине (массив ASC → перезапись = свежее)
  }
  return last.filter((v) => v != null);
}

/** Снимок для дебага/dashboard. */
export function getBufferLength(coin) {
  return buffers.get(coin)?.length ?? 0;
}

/** Тестовый helper — полная очистка. */
export function clearAll() {
  buffers.clear();
}
