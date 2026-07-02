// ─────────────────────────────────────────────────
//  Daily Risk — дневной стоп-лосс по правде биржи (fills)
// ─────────────────────────────────────────────────
// Аудит 2026-07-02 (60д fills): 8 худших дней = −$130 при общем минусе −$83;
// один тильт-день (5.06: −$32.39, 48 филлов) съедает две недели работы. Дневной
// лимит — самый дешёвый путь к нулю.
//
// Что это: день (Europe/Warsaw = TZ контейнера) достиг −LIMIT$ net по fills →
// halted до полуночи. Правда = fills (Σ closedPnl − fee), НЕ history-таблица:
// fills видят и ручные сделки, и бот, и внешние закрытия без лага.
//
// Что halted ДЕЛАЕТ:
//   • urgent ntfy при пересечении (1 раз/день);
//   • гейт на НОВЫЕ авто-входы бота (tick: OPEN → HOLD);
//   • «тильт-алерт» на каждое новое усыновление (adoptReconcile).
// Что halted НЕ делает: НЕ отключает няньку (вход без стопа хуже лимита) и НЕ
// трогает сопровождение/выходы открытых поз. Кошелёк не заблокировать — это
// громкий rail, не замок.

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { fetchUserFills } from './userFills.js';

/** Ключ дня в TZ процесса (контейнер = Europe/Warsaw). */
export function localDayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/**
 * Чистая: net/fees/филлы за день dayKey из сырых HL fills.
 * net = Σ closedPnl − Σ fee (правда биржи, включая ручные сделки).
 */
export function computeDayStats(fills, dayKey) {
  let net = 0, fees = 0, count = 0;
  for (const f of fills || []) {
    if (!f?.time || localDayKey(f.time) !== dayKey) continue;
    net  += (parseFloat(f.closedPnl ?? '0') || 0) - (parseFloat(f.fee ?? '0') || 0);
    fees += parseFloat(f.fee ?? '0') || 0;
    count++;
  }
  return { net, fees, count };
}

// Последний посчитанный статус (для дашборда, sync-доступ) + день последнего
// алерта пересечения (1 громкий пуш/день, дальше пусть держит рельса).
let _last = null;         // { dayKey, netUsd, feesUsd, fillCount, halted, limitUsd, at }
let _alertedDay = null;

/** Последний известный статус (может быть null до первого тика). */
export function getLastDailyRiskStatus() {
  return _last;
}

/**
 * Пересчитать дневной статус по fills (кэш 30с внутри fetchUserFills — дёшево).
 * Fail-soft: ошибка → прежний/не-halted статус, торговлю не ломаем.
 * @returns {Promise<{halted:boolean, crossedNow:boolean, netUsd:number, feesUsd:number, limitUsd:number, dayKey:string}>}
 */
export async function refreshDailyRisk(now = Date.now()) {
  const limitUsd = config.trading.dailyLossLimitUsd;
  const enabled  = config.trading.dailyLossLimitEnabled;
  const dayKey   = localDayKey(now);
  try {
    const fills = await fetchUserFills(0);
    const { net, fees, count } = computeDayStats(fills, dayKey);
    const halted = enabled && net <= -limitUsd;
    const crossedNow = halted && _alertedDay !== dayKey;
    if (crossedNow) _alertedDay = dayKey;
    _last = { dayKey, netUsd: net, feesUsd: fees, fillCount: count, halted, limitUsd, at: now };
    if (crossedNow) {
      logger.warn(
        `[DailyRisk] 🛑 дневной стоп-лосс: net $${net.toFixed(2)} ≤ −$${limitUsd} ` +
          `(fees $${fees.toFixed(2)}, fills ${count}). Новые авто-входы закрыты до полуночи.`,
      );
    }
    return { halted, crossedNow, netUsd: net, feesUsd: fees, limitUsd, dayKey };
  } catch (err) {
    logger.debug(`[DailyRisk] refresh failed: ${err.message} — считаем не-halted`);
    const stale = _last && _last.dayKey === dayKey ? _last : null;
    return { halted: !!stale?.halted, crossedNow: false, netUsd: stale?.netUsd ?? 0, feesUsd: stale?.feesUsd ?? 0, limitUsd, dayKey };
  }
}

/** Тест-хелпер: сброс состояния. */
export function _resetDailyRiskState() { _last = null; _alertedDay = null; }
