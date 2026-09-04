// ─────────────────────────────────────────────────
//  Health Registry — состояние проверок целостности данных
// ─────────────────────────────────────────────────
//
// Место, где результат проверки живёт между замерами: сами числа считались и
// раньше, но умирали в одном logger.info — спросить из кода «как сейчас с
// фидом» было нельзя. Писатели (priceFeed, integrity, tickWatchdog) зовут
// note, читатели (статус-кадр дашборда, /api/health) — summary. Сети тут
// нет: реестр хранит посчитанное другими.
//
// Одна проверка = { category, status, detail }:
//   • status  'pass' | 'warn' | 'fail'
//   • category 'freshness' | 'xref' | 'completeness' | 'consistency'
//
// 🚨 Молчание писателя — НЕ «всё хорошо»: без ttlMs у записи плашка навсегда
// застынет зелёной, когда писатель умрёт.

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
      ? `no updates for ${Math.round(ageMs / 1000)}s (ttl ${Math.round(c.ttlMs / 1000)}s)`
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
