// ─────────────────────────────────────────────────
//  Target-trail — снять лимитку у цели и дальше вести трейлом
// ─────────────────────────────────────────────────
// Идея оператора (03.09.2026): фиксация по лимитке отдаёт ровно RR и обрезает те
// редкие сделки, где движение продолжается. Предложение — на подходе к цели
// снять reduce-only лимитку и дальше тянуть стоп за ценой.
//
// ⚠️ ЧТО ПОКАЗАЛ ЗАМЕР (46 сделок, доехавших до цели, 5m, 17 дней):
//   среднее   +1.154R против +1.000R у фиксации → разница +0.154R
//   CI95      [−0.033, +0.378] — ноль ВНУТРИ, знак не установлен
//   медиана   +0.844R — то есть ТИПИЧНАЯ сделка при трейле хуже фиксации,
//             а среднее вытягивают три исхода: +4.13R, +3.81R, +2.48R
// Правило живёт хвостом. Поэтому оно выключено по умолчанию и заведено как
// гипотеза `adopt-target-trail` со стоп-правилом: судить один раз на 60
// сделках, доехавших до цели. Раньше не смотреть — это optional stopping.
//
// Ещё одна цена, которой нет в замере: лимитка-цель исполняется МЕЙКЕРОМ, а
// выход трейлом — тейкером по рынку. На круг это ~4-5 бп нотионала, при риске
// 4.66% примерно 0.01R — мелочь против 0.154R, но она всегда против нас.
//
// Чистые функции: без сети, БД и config — чтобы тест не требовал кошелька.

/**
 * Риск сделки в цене (расстояние вход → стоп). null, если стоп неизвестен:
 * без него R-шкала не определена и правило обязано молчать.
 */
export function riskDistance({ entry, stopPrice }) {
  if (!(entry > 0) || !(stopPrice > 0)) return null;
  const d = Math.abs(entry - stopPrice);
  return d > 0 ? d : null;
}

/** Текущий ход в долях R (положительный = в сторону позиции). */
export function unrealizedR({ entry, price, stopPrice, isShort }) {
  const risk = riskDistance({ entry, stopPrice });
  if (risk == null || !(price > 0)) return null;
  const move = isShort ? entry - price : price - entry;
  return move / risk;
}

/**
 * Решение по одной позиции.
 *
 * Состояния ровно два, и переход между ними односторонний:
 *   не взведён → ARM   (цена подошла к цели: снимаем лимитку, начинаем трейлить)
 *   взведён    → CLOSE (откат от пика больше отступа)
 *
 * Обратно правило не откатывается: если лимитка уже снята, вернуть её нельзя —
 * цена успеет уйти, и позиция останется без цели вовсе.
 *
 * @param {object} p
 * @param {number} p.currentR   — текущий ход в R
 * @param {number} p.peakR      — максимум хода в R за жизнь сделки
 * @param {boolean} p.armed     — трейл уже включён для этой позиции
 * @param {number} p.armR       — на каком ходе снимаем лимитку (в R)
 * @param {number} p.giveBackR  — отступ трейла от пика (в R)
 * @returns {{action: 'NONE'|'ARM'|'CLOSE', reason?: string}}
 */
export function decideTargetTrail({ currentR, peakR, armed, armR, giveBackR }) {
  if (![currentR, peakR, armR, giveBackR].every((v) => Number.isFinite(v))) {
    return { action: 'NONE' };
  }
  if (!armed) {
    if (peakR >= armR) {
      return { action: 'ARM', reason: `ход ${peakR.toFixed(2)}R ≥ ${armR}R — снимаю лимитку, дальше трейл` };
    }
    return { action: 'NONE' };
  }
  // Взведён: стоп идёт за пиком с фиксированным отступом в R.
  const floorR = peakR - giveBackR;
  if (currentR <= floorR) {
    return {
      action: 'CLOSE',
      reason: `откат с пика ${peakR.toFixed(2)}R до ${currentR.toFixed(2)}R (отступ ${giveBackR}R)`,
    };
  }
  return { action: 'NONE' };
}

/**
 * Уровень цены, где трейл закроет позицию — для показа в UI и логах.
 * Возвращает null, пока правило не взведено: до этого пол держит обычный стоп.
 */
export function trailFloorPrice({ entry, stopPrice, isShort, peakR, giveBackR, armed }) {
  if (!armed) return null;
  const risk = riskDistance({ entry, stopPrice });
  if (risk == null || !Number.isFinite(peakR) || !Number.isFinite(giveBackR)) return null;
  const floorR = peakR - giveBackR;
  return isShort ? entry - floorR * risk : entry + floorR * risk;
}
