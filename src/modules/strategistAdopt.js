// ─────────────────────────────────────────────────
//  Adopt — сопровождение подхваченной ручной позы (per-tick выход)
// ─────────────────────────────────────────────────
// План: plans/adopt-mode-plan.md
//
// Жёсткий стоп держит БИРЖА (resting reduce-only SL trigger, выставлен при
// подхвате в adoptReconcile). Здесь — более РАННИЕ мягкие выходы, переиспуск
// механики Hunter D3:
//   • BE-храповик: peak% ≥ ARM → взвести; если потом unrealized% ≤ FLOOR (0) —
//     закрыть в безубыток, не отдавать подарок в минус.
//   • Трейл: peak% ≥ ARM → если откат от пика ≥ GIVE_BACK% — закрыть в плюс,
//     дать прибыли тянуться, но зафиксировать на развороте.
// Жёсткий SL тут НЕ дублируем (его исполнит биржа + поймает integrityCheck) —
// иначе риск двойного закрытия. Side-aware (short и long).

import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const peakPctMap   = new Map(); // positionId → peak unrealized% (MFE)
const troughPctMap = new Map(); // positionId → min unrealized% (MAE, ≤0 обычно)
const beArmedMap   = new Map(); // positionId → true, как только peak ≥ BE_ARM

const BE_ARM    = config.trading.adoptBeArmPct;
const BE_FLOOR  = config.trading.adoptBeFloorPct;
const TRAIL_ARM = config.trading.adoptTrailArmPct;
const TRAIL_GB  = config.trading.adoptTrailGiveBackPct;

/** Чистит per-position state (вызывается из close-handler'а). */
export function clearAdoptState(positionId) {
  if (positionId == null) return;
  peakPctMap.delete(positionId);
  troughPctMap.delete(positionId);
  beArmedMap.delete(positionId);
}

/** Текущий peak unrealized% (для exitFeatures при close). */
export function getAdoptPeakPct(positionId) {
  return peakPctMap.get(positionId) ?? 0;
}

/** Текущий trough unrealized% (MAE, ≤0) — для «призрака просадки» на карточке. */
export function getAdoptMaePct(positionId) {
  return troughPctMap.get(positionId) ?? 0;
}

/**
 * MFE/MAE по % (peak/trough unrealized) для exitFeatures при закрытии.
 * НЕ чистит state — cleanup делает clearAdoptState после консьюма.
 * @returns {{ mfePct: number|null, maePct: number|null }}
 */
export function consumeAdoptMfeMae(positionId) {
  if (positionId == null) return { mfePct: null, maePct: null };
  return {
    mfePct: peakPctMap.has(positionId)   ? peakPctMap.get(positionId)   : null,
    maePct: troughPctMap.has(positionId) ? troughPctMap.get(positionId) : null,
  };
}

/** Сброс всего state (тесты). */
export function resetAdoptState() {
  peakPctMap.clear();
  troughPctMap.clear();
  beArmedMap.clear();
}

/**
 * Per-tick сопровождение adopted-позы.
 * @param {Object} position — row из positions (strategy_id='adopt')
 * @param {number} price — текущая цена монеты
 * @returns {{ action:'CLOSE'|'HOLD', coin?, price?, reason?, peakPct?, giveBackPct? }}
 */
export function analyzeAdopt(position, price) {
  if (!Number.isFinite(price) || price <= 0) return { action: 'HOLD' };

  const isShort = (position.side || 'short') === 'short';
  const entry   = position.entry_price;
  const unrealizedPct = isShort
    ? ((entry - price) / entry) * 100
    : ((price - entry) / entry) * 100;

  const prevPeak = peakPctMap.get(position.id) ?? 0;
  if (unrealizedPct > prevPeak) peakPctMap.set(position.id, unrealizedPct);
  const peak = peakPctMap.get(position.id) ?? 0;

  // MAE: худшая просадка против позы (для exitFeatures — анализ «ушло ли в плюс
  // перед стопом»). Старт 0: если поза не была в минусе, MAE остаётся 0.
  const prevTrough = troughPctMap.get(position.id) ?? 0;
  if (unrealizedPct < prevTrough) troughPctMap.set(position.id, unrealizedPct);

  // ── Трейл: даём тянуться, фиксируем на откате ──
  if (peak >= TRAIL_ARM && unrealizedPct > 0) {
    const giveBack  = peak - unrealizedPct;
    const threshold = peak * (TRAIL_GB / 100);
    if (giveBack >= threshold) {
      logger.info(
        `[Adopt] 🎯 TRAIL CLOSE #${position.coin}: peak +${peak.toFixed(2)}% → now +${unrealizedPct.toFixed(2)}% ` +
          `(gave back ${(giveBack / peak * 100).toFixed(0)}% ≥ ${TRAIL_GB}%)`,
      );
      return {
        action: 'CLOSE',
        coin:   position.coin,
        price,
        reason: 'adopt_trail_tp',
        peakPct:     peak,
        giveBackPct: (giveBack / peak) * 100,
      };
    }
  }

  // ── BE-храповик: не отдать подарок в минус ──
  if (peak >= BE_ARM) beArmedMap.set(position.id, true);
  if (beArmedMap.get(position.id) === true && unrealizedPct <= BE_FLOOR) {
    logger.warn(
      `[Adopt] 🛡 BREAKEVEN RATCHET #${position.coin}: peak +${peak.toFixed(2)}% → ` +
        `now ${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}% ≤ floor ${BE_FLOOR}% — закрываем в безубыток`,
    );
    return {
      action:  'CLOSE',
      coin:    position.coin,
      price,
      reason:  'adopt_breakeven_ratchet',
      peakPct: peak,
    };
  }

  // Жёсткий стоп — на бирже (resting SL). Здесь HOLD: ждём следующий тик.
  return { action: 'HOLD' };
}
