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
import { setAdoptTrail, getAdoptTrailAll, clearAdoptTrail } from './adoptTrailStore.js';

// ── Замер 14.08.2026: почему трейл отдаёт 40% пика вместо 30% ───────────────
// По 127 закрытиям adopt_trail_tp медиана отката = 40% при пороге 30%, p90 = 68%,
// а худшая сделка (MANTA 28.06) закрылась с пиком +2.86% в МИНУС −0.72%, то есть
// под ярлыком «трейл забрал прибыль». Починка залипшего тика 31.07 картину не
// сдвинула: медиана 39% до и 40% после.
//
// Лог TRAIL CLOSE показал, что порог перепрыгнут УЖЕ В МОМЕНТ РЕШЕНИЯ (видел 38%,
// не 30%), значит виновато не исполнение, а редкость осмотра позиции. Но чем
// именно — доказать нечем: нигде не пишется, что было на ПРЕДЫДУЩЕМ осмотре и
// сколько времени прошло.
//
// Эти две карты и пишут ровно это. Торговлю не меняют, только лог.
const lastSeenAtMap = new Map(); // positionId → ts предыдущего вызова analyzeAdopt
const lastGbMap     = new Map(); // positionId → откат от пика (%) на пред. осмотре

const peakPctMap   = new Map(); // positionId → peak unrealized% (MFE)
const troughPctMap = new Map(); // positionId → min unrealized% (MAE, ≤0 обычно)
const beArmedMap   = new Map(); // positionId → true, как только peak ≥ BE_ARM

const BE_ARM    = config.trading.adoptBeArmPct;
const BE_FLOOR  = config.trading.adoptBeFloorPct;
const TRAIL_ARM = config.trading.adoptTrailArmPct;
const TRAIL_GB  = config.trading.adoptTrailGiveBackPct;

// Пик персистим, только когда он уже влияет на защиту — то есть дорос до
// ближайшего из порогов. Мелкие колебания у нуля писать на диск незачем: они
// ничего не решают, а запись идёт на каждый тик по каждой позе.
const PERSIST_FROM_PCT = Math.min(BE_ARM, TRAIL_ARM);

// Восстановление мягкого состояния с диска после рестарта (09.08: до этого пик
// жил только в памяти и обнулялся, см. шапку adoptTrailStore.js). Ключи в JSON —
// строки, мапы здесь — по числовому position.id, отсюда Number().
let restoredFromDisk = false;
function restoreFromDiskOnce() {
  if (restoredFromDisk) return;
  restoredFromDisk = true;
  for (const [pid, v] of Object.entries(getAdoptTrailAll())) {
    const id = Number(pid);
    if (!Number.isFinite(id)) continue;
    if (typeof v.peak === 'number' && v.peak > 0)     peakPctMap.set(id, v.peak);
    if (typeof v.trough === 'number' && v.trough < 0) troughPctMap.set(id, v.trough);
    if (v.beArmed === true) beArmedMap.set(id, true);
  }
}

/** Чистит per-position state (вызывается из close-handler'а). */
export function clearAdoptState(positionId) {
  if (positionId == null) return;
  peakPctMap.delete(positionId);
  troughPctMap.delete(positionId);
  beArmedMap.delete(positionId);
  // Замерные карты чистим здесь же: несмываемая Map — это ровно тот механизм,
  // которым 09.08 выбило кучу V8 (см. шапку candleCache.js).
  lastSeenAtMap.delete(positionId);
  lastGbMap.delete(positionId);
  clearAdoptTrail(positionId); // снять персист, иначе орфан доживёт до TTL
}

/** Текущий peak unrealized% (для exitFeatures при close). */
export function getAdoptPeakPct(positionId) {
  restoreFromDiskOnce();
  return peakPctMap.get(positionId) ?? 0;
}

/** Текущий trough unrealized% (MAE, ≤0) — для «призрака просадки» на карточке. */
export function getAdoptMaePct(positionId) {
  restoreFromDiskOnce();
  return troughPctMap.get(positionId) ?? 0;
}

/**
 * MFE/MAE по % (peak/trough unrealized) для exitFeatures при закрытии.
 * НЕ чистит state — cleanup делает clearAdoptState после консьюма.
 * @returns {{ mfePct: number|null, maePct: number|null }}
 */
export function consumeAdoptMfeMae(positionId) {
  if (positionId == null) return { mfePct: null, maePct: null };
  restoreFromDiskOnce();
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
  lastSeenAtMap.clear();
  lastGbMap.clear();
  restoredFromDisk = false;
}

/**
 * Per-tick сопровождение adopted-позы.
 * @param {Object} position — row из positions (strategy_id='adopt')
 * @param {number} price — текущая цена монеты
 * @returns {{ action:'CLOSE'|'HOLD', coin?, price?, reason?, peakPct?, giveBackPct? }}
 */
export function analyzeAdopt(position, price) {
  if (!Number.isFinite(price) || price <= 0) return { action: 'HOLD' };
  restoreFromDiskOnce();

  const isPersisted = position.mode === 'PRODUCTION';
  const isShort = (position.side || 'short') === 'short';
  const entry   = position.entry_price;
  const unrealizedPct = isShort
    ? ((entry - price) / entry) * 100
    : ((price - entry) / entry) * 100;

  const prevPeak = peakPctMap.get(position.id) ?? 0;
  if (unrealizedPct > prevPeak) {
    peakPctMap.set(position.id, unrealizedPct);
    if (isPersisted && unrealizedPct >= PERSIST_FROM_PCT) {
      setAdoptTrail(position.id, { peak: unrealizedPct });
    }
  }
  const peak = peakPctMap.get(position.id) ?? 0;

  // MAE: худшая просадка против позы (для exitFeatures — анализ «ушло ли в плюс
  // перед стопом»). Старт 0: если поза не была в минусе, MAE остаётся 0.
  const prevTrough = troughPctMap.get(position.id) ?? 0;
  if (unrealizedPct < prevTrough) {
    troughPctMap.set(position.id, unrealizedPct);
    // MAE пишем только по позам, у которых уже есть персистируемый пик — сам по
    // себе он на выход не влияет, но без него exitFeatures после рестарта
    // покажут «просадки не было», что портит разбор.
    if (isPersisted && peak >= PERSIST_FROM_PCT) {
      setAdoptTrail(position.id, { trough: unrealizedPct });
    }
  }

  // Разрыв между осмотрами и то, что мы видели в прошлый раз — см. блок выше.
  const nowTs   = Date.now();
  const prevTs  = lastSeenAtMap.get(position.id);
  const gapMs   = prevTs ? nowTs - prevTs : null;
  const prevGb  = lastGbMap.get(position.id);
  lastSeenAtMap.set(position.id, nowTs);
  if (peak > 0) lastGbMap.set(position.id, ((peak - unrealizedPct) / peak) * 100);

  // ── Трейл: даём тянуться, фиксируем на откате ──
  if (peak >= TRAIL_ARM && unrealizedPct > 0) {
    const giveBack  = peak - unrealizedPct;
    const threshold = peak * (TRAIL_GB / 100);
    if (giveBack >= threshold) {
      const gbPct = (giveBack / peak) * 100;
      logger.info(
        `[Adopt] 🎯 TRAIL CLOSE #${position.coin}: peak +${peak.toFixed(2)}% → now +${unrealizedPct.toFixed(2)}% ` +
          `(gave back ${gbPct.toFixed(0)}% ≥ ${TRAIL_GB}%)`,
      );
      // Перелёт порога и его причина. Если prevGb был заметно ниже TRAIL_GB, а
      // gap большой — значит позу просто редко осматривают, и виновата петля,
      // а не правило. Если prevGb уже был около порога — виновато исполнение.
      logger.info(
        `[AdoptTrailProbe] #${position.coin} перелёт=${(gbPct - TRAIL_GB).toFixed(1)}пп ` +
          `порог=${TRAIL_GB}% факт=${gbPct.toFixed(1)}% ` +
          `пред.осмотр=${prevGb == null ? 'нет' : prevGb.toFixed(1) + '%'} ` +
          `пауза=${gapMs == null ? 'нет' : (gapMs / 1000).toFixed(1) + 'с'}`,
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
  if (peak >= BE_ARM && beArmedMap.get(position.id) !== true) {
    beArmedMap.set(position.id, true);
    if (isPersisted) setAdoptTrail(position.id, { beArmed: true });
  }
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
