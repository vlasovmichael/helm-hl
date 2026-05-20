// Ring buffer of "почти-сигналов" Hunter SHORT/Long: спайк прошёл порог,
// но один из фильтров (vol/OI/trend/cooldown/slot busy) не пустил вход.
// Используется дашбордом (`Near Misses` карточка). Чисто in-memory, после
// рестарта обнуляется — это нормально для дашборд-фида.

const MAX_ENTRIES = 200;

const buffer = [];

/**
 * @param {object} evt
 * @param {string} evt.strategy      — 'hunter' | 'hunter_long'
 * @param {string} evt.coin
 * @param {'SHORT'|'LONG'} evt.side
 * @param {number} evt.spikePct      — спайк, который дал триггер (для long — отрицательный)
 * @param {string} evt.reason        — короткий код: 'vol' | 'oi' | 'trend' | 'cooldown' | 'post_sl' | 'cross_cooldown' | 'slot_busy'
 * @param {string} evt.detail        — человекочитаемая строка ("vol $1.29M < $5.0M min")
 * @param {number} [evt.ts]
 */
export function recordNearMiss(evt) {
  const entry = {
    ts: evt.ts ?? Date.now(),
    strategy: evt.strategy,
    coin: evt.coin,
    side: evt.side,
    spikePct: Number.isFinite(evt.spikePct) ? evt.spikePct : null,
    reason: evt.reason,
    detail: evt.detail || '',
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

/** @param {{ since?: number, limit?: number }} [opts] */
export function getNearMisses(opts = {}) {
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 50;
  const out = [];
  for (let i = buffer.length - 1; i >= 0 && out.length < limit; i--) {
    const e = buffer[i];
    if (e.ts < since) break;
    out.push(e);
  }
  return out;
}

export function clearNearMisses() {
  buffer.length = 0;
}
