// ─────────────────────────────────────────────────
//  OI history — ring buffer (coin → [{ts, oiUsd}])
// ─────────────────────────────────────────────────
// Вынесено из dashboard/routes/movers.js (2026-06-15), чтобы и стратегический
// код (strategistHunter — entry_oi_delta фичи Hunter'а), и дашборд читали один
// буфер без циклической зависимости (core не импортит стратегии/роуты).
// Снапшот берётся из state.latestHunter каждые OI_SNAPSHOT_MS (таймер в
// dashboard lifecycle через movers.takeOiSnapshot).

export const OI_SNAPSHOT_MS = 30_000;
const OI_MAX_SNAPS = 40; // 20 мин запаса при 30с-снапшоте

const _oiHistory = new Map(); // coin → [{ts, oiUsd}]

/**
 * Записать снапшот OI для всех монет из hunterData-подобного массива.
 * @param {Array<{coin:string, oiUsd:number|null}>} data
 * @param {number} [ts=Date.now()]
 */
export function recordOiSnapshot(data, ts = Date.now()) {
  if (!Array.isArray(data) || data.length === 0) return;
  for (const item of data) {
    if (item.oiUsd == null || !(item.oiUsd > 0)) continue; // 0/мусорный OI не пишем в буфер
    let arr = _oiHistory.get(item.coin);
    if (!arr) { arr = []; _oiHistory.set(item.coin, arr); }
    arr.push({ ts, oiUsd: item.oiUsd });
    if (arr.length > OI_MAX_SNAPS) arr.shift();
  }
}

/**
 * OI N минут назад (последний снапшот на/до целевой метки). null если истории
 * мало (< 2 снапшотов) или нет дотягивающего по времени снапшота.
 *
 * `maxStaleMin` (опц.): базовый снапшот должен быть не старше целевой метки
 * больше чем на maxStaleMin минут. Защита от «лежалой» точки: при разрежённой
 * истории ближайший снапшот ≤ target может быть сильно раньше target, и тогда
 * Δ считается против устаревшего OI → фейковый скачок. По умолчанию (не задан)
 * — прежнее поведение без проверки.
 * @param {string} coin
 * @param {number} mins
 * @param {number} [now=Date.now()]
 * @param {{maxStaleMin?: number}} [opts]
 * @returns {number|null}
 */
export function getOiNMinAgo(coin, mins, now = Date.now(), { maxStaleMin } = {}) {
  const arr = _oiHistory.get(coin);
  if (!arr || arr.length < 2) return null;
  const target = now - mins * 60_000;
  let best = null;
  for (const snap of arr) {
    if (snap.ts <= target) best = snap;
    else break;
  }
  if (!best) return null;
  if (maxStaleMin != null && target - best.ts > maxStaleMin * 60_000) return null;
  return best.oiUsd;
}

/** Тестовый сброс буфера. */
export function _resetOiHistory() {
  _oiHistory.clear();
}
