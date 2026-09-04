// ─────────────────────────────────────────────────
//  Alloc Probe — чёрный ящик: кто раздул кучу за последнюю минуту
// ─────────────────────────────────────────────────
//
// [Mem] ⚡ говорит РАЗМЕР залпа памяти, но не виновника. Здесь каждая
// потенциально крупная операция (запрос к HL, HTTP-роут дашборды,
// WS-broadcast, тик) меряет heapUsed до и после себя и роняет строчку в
// кольцевой буфер; когда memWatch ловит скачок — печатает топ буфера за минуту.
//
// ⚠️ Дельта кучи на конкурентных операциях — не бухгалтерия: параллельные
// задачи мешают вклады, GC посреди операции даёт минус. Это ловушка на слона
// (+200МБ), а не весы для граммов — поэтому агрегируем и по сумме, и по
// максимуму одного вызова: залп виден как одиночный большой max.
import { logger } from '../core/logger.js';

const RING = parseInt(process.env.ALLOC_PROBE_RING || '600', 10);
const ENABLED = process.env.ALLOC_PROBE !== '0';

/** @type {Array<{at:number,name:string,ms:number,bytes:number,heapDelta:number}>} */
const ring = new Array(RING).fill(null);
let head = 0;

/** Запись события. Дешёвая: без аллокаций сверх одного объекта. */
export function recordAlloc(name, { ms = 0, bytes = 0, heapDelta = 0 } = {}) {
  if (!ENABLED) return;
  ring[head] = { at: Date.now(), name, ms, bytes, heapDelta };
  head = (head + 1) % RING;
}

/**
 * Обёртка: померить, сколько куча выросла за время операции.
 * Возвращает результат fn как есть; ошибки не глотает (но замер пишет —
 * упавший запрос тоже мог успеть распарсить тело).
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {(result:T) => number} [bytesOf] — чем мерить размер полезной нагрузки
 * @returns {Promise<T>}
 */
export async function probeAlloc(name, fn, bytesOf) {
  if (!ENABLED) return fn();
  const t0 = Date.now();
  const h0 = process.memoryUsage().heapUsed;
  let out;
  try {
    out = await fn();
    return out;
  } finally {
    let bytes = 0;
    try { bytes = bytesOf && out !== undefined ? bytesOf(out) || 0 : 0; } catch { /* замер не должен ронять работу */ }
    recordAlloc(name, {
      ms: Date.now() - t0,
      bytes,
      heapDelta: process.memoryUsage().heapUsed - h0,
    });
  }
}

/**
 * Чистая агрегация (для тестов): свернуть события окна в топ по вкладу.
 *
 * Сортируем по суммарному приросту, но в строке показываем и максимум одного
 * вызова: залп — это один жирный вызов, а не тысяча мелких, и их надо
 * различать глазом с первого взгляда.
 *
 * @param {Array<{at:number,name:string,ms:number,bytes:number,heapDelta:number}>} events
 * @param {{now:number, windowMs:number, top:number}} p
 */
export function summarizeAllocs(events, { now, windowMs, top }) {
  const since = now - windowMs;
  const byName = new Map();
  for (const e of events) {
    if (!e || e.at < since) continue;
    let agg = byName.get(e.name);
    if (!agg) { agg = { name: e.name, count: 0, sum: 0, max: 0, bytes: 0, ms: 0 }; byName.set(e.name, agg); }
    agg.count += 1;
    agg.ms += e.ms;
    agg.bytes += e.bytes;
    if (e.heapDelta > 0) agg.sum += e.heapDelta;
    if (e.heapDelta > agg.max) agg.max = e.heapDelta;
  }
  return [...byName.values()].sort((a, b) => b.sum - a.sum).slice(0, top);
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/** Строка для лога: топ операций окна. Пустая строка, если писать не о чем. */
export function formatRecentAllocs({ windowMs = 60_000, top = 6, now = Date.now() } = {}) {
  const rows = summarizeAllocs(ring, { now, windowMs, top });
  if (rows.length === 0) return '';
  return rows
    .map((r) => `${r.name} ×${r.count} +${mb(r.sum)}МБ (max ${mb(r.max)}МБ${r.bytes ? `, тело ${mb(r.bytes)}МБ` : ''})`)
    .join(' · ');
}

/** Печать в лог — зовётся из memWatch при пойманном скачке. */
export function logRecentAllocs(windowMs = 60_000) {
  const line = formatRecentAllocs({ windowMs });
  logger.warn(
    line
      ? `[Alloc] за ${Math.round(windowMs / 1000)}с: ${line}`
      : `[Alloc] за ${Math.round(windowMs / 1000)}с — ни одной измеренной операции (виновник вне швов)`,
  );
}

/** Только для тестов: очистить буфер. */
export function _resetAllocProbe() {
  ring.fill(null);
  head = 0;
}

/** Только для тестов: заглянуть внутрь. */
export function _allocRing() {
  return ring.filter(Boolean);
}
