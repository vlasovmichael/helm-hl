// ─────────────────────────────────────────────────
//  Price History — per-coin ring buffer (in-memory)
// ─────────────────────────────────────────────────
// Используется Sniper-Hunter'ом (strategistSniper.js) для детекции
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
 * Добавляет сэмпл цены. Автоматически подрезает старые (>10мин) сэмплы.
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

/** @returns {boolean} Есть ли в буфере данные минимум на N минут назад. */
export function hasEnoughHistory(coin, minutes, now = Date.now()) {
  return getPriceNMinAgo(coin, minutes, now) !== null;
}

/** Снимок для дебага/dashboard. */
export function getBufferLength(coin) {
  return buffers.get(coin)?.length ?? 0;
}

/** Тестовый helper — полная очистка. */
export function clearAll() {
  buffers.clear();
}
