// ─────────────────────────────────────────────────
//  Health Registry — состояние проверок целостности данных
// ─────────────────────────────────────────────────
//
// Why: числа о здоровье фидов у нас СЧИТАЛИСЬ и раньше — `[PriceFeed] status`
// печатает connected/lastAge/coins/avgΔ/maxΔ раз в минуту, integrityCheck
// сверяет БД с биржей раз в 60с. Но жили они ровно один вызов logger.info:
// посчитал → напечатал → обнулил. Спросить из кода «как сейчас с фидом»
// было нельзя, и единственным способом узнать оставалось глазами в docker logs
// — то есть уже ПОСЛЕ того, как что-то сломалось.
//
// Этот модуль — место, где результат проверки живёт между замерами. Писатели
// (priceFeed, integrity, tickWatchdog) зовут note(), читатели (статус-кадр
// дашборда, /api/health) — summary(). Никаких сетевых походов здесь нет:
// реестр только хранит то, что посчитали другие.
//
// Одна проверка = { category, status, detail }:
//   • status  'pass' | 'warn' | 'fail'
//   • category 'freshness' | 'xref' | 'completeness' | 'consistency'
//
// 🚨 Молчание писателя — НЕ «всё хорошо». Если priceFeed перестал звать note()
// (умер таймер, встал процесс), последняя запись обязана протухнуть, иначе
// плашка навсегда застынет зелёной — ровно та ловушка «замёрзшее выглядит как
// живое», против которой реестр и заводится. Отсюда ttlMs у каждой записи.

const checks = new Map(); // name → { category, status, detail, ts, ttlMs }

// Сколько живёт запись без обновления, если писатель не указал своё.
const DEFAULT_TTL_MS = 180_000;

const VALID_STATUS = new Set(['pass', 'warn', 'fail']);

/**
 * Записать (или перезаписать) результат одной проверки.
 * @param {string} name — стабильный ключ, напр. 'price_feed'
 * @param {{category: string, status: 'pass'|'warn'|'fail', detail?: string, ttlMs?: number}} r
 */
export function note(name, { category, status, detail = '', ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!name || !VALID_STATUS.has(status)) return;
  checks.set(name, { category, status, detail, ttlMs, ts: Date.now() });
}

/** Убрать проверку из реестра (источник осознанно выключен). */
export function drop(name) {
  checks.delete(name);
}

/** Сброс (тесты). */
export function resetHealth() {
  checks.clear();
}

/**
 * Свод по всем проверкам.
 *
 * Иерархия overall — по СРОЧНОСТИ, а не по количеству: замёрзший фид опаснее
 * расхождения именно потому, что замёрзшая цена выглядит нормальной и молча
 * врёт, а разошедшаяся хотя бы видна. Поэтому одна протухшая freshness кроет
 * любое число warn'ов.
 *
 * @returns {{overall: string, counts: object, checks: Array, updatedAt: number}}
 */
export function summary() {
  const now = Date.now();
  const counts = { pass: 0, warn: 0, fail: 0 };
  const out = [];

  for (const [name, c] of checks) {
    const ageMs = now - c.ts;
    const expired = ageMs > c.ttlMs;
    // Протухшая запись — это не её последний статус, а «источник замолчал».
    const status = expired ? 'fail' : c.status;
    const category = expired ? 'freshness' : c.category;
    const detail = expired
      ? `нет обновлений ${Math.round(ageMs / 1000)}с (ttl ${Math.round(c.ttlMs / 1000)}с)`
      : c.detail;
    counts[status]++;
    out.push({ name, category, status, detail, ageMs, stale: expired });
  }

  let overall;
  if (out.length === 0) {
    overall = 'unknown';
  } else if (out.some((c) => c.category === 'freshness' && c.status === 'fail')) {
    overall = 'stale';
  } else if (out.some((c) => c.category === 'xref' && c.status === 'fail')) {
    overall = 'drift';
  } else if (counts.fail > 0) {
    overall = 'fail';
  } else if (counts.warn > 0) {
    overall = 'warn';
  } else {
    overall = 'ok';
  }

  return { overall, counts, checks: out, updatedAt: now };
}
