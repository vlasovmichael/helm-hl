// ─────────────────────────────────────────────────
//  Target-trail — снять лимитку у цели и дальше вести трейлом
// ─────────────────────────────────────────────────
// Фиксация по лимитке отдаёт ровно RR и обрезает те редкие сделки, где движение
// продолжается. Правило: на подходе к цели снять reduce-only лимитку и дальше
// тянуть стоп за ценой.
//
// ⛔ ВЫКЛЮЧЕНО по умолчанию: типичная сделка на трейле выходит ХУЖЕ фиксации,
// плюс держится на редких хвостах. Гипотеза `adopt-target-trail`, стоп-правило
// — судить один раз на 60 сделках, доехавших до цели; раньше не смотреть.
// Ещё цена, которой нет в замере: лимитка-цель исполняется мейкером, а выход
// трейлом — тейкером, ~4-5 бп нотионала всегда против нас.
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

/**
 * Надо ли переставлять биржевой стоп — и куда.
 *
 * 🚨 ПОЛ ЖИВЁТ НА БИРЖЕ, А НЕ В ПАМЯТИ БОТА. Уровень, который бот держит числом
 * и сверяет на тике, цена отдаёт между осмотрами — ловить её нечем, ордера там
 * не стоит. Ордер на бирже исполняется, даже если бот лежит.
 *
 * ХРАПОВИК. Пол двигается ТОЛЬКО в мою сторону. Опустить его вниз нельзя ни при
 * каком откате: это увеличило бы риск задним числом.
 *
 * ШАГ. Переставляем, только если новый уровень лучше текущего минимум на
 * minStepPct от входа: каждая перестановка — отмена + постановка, два запроса
 * и короткое окно с двумя стопами сразу (безопасно, оба reduce-only).
 *
 * @param {object} p
 * 🚨 1R СЧИТАЕТСЯ ОТ ЭТАЛОНА (initialStopPrice), а не от текущего стопа: пол
 * едет, и шкала съедет после первой же перестановки.
 *
 * @param {number} p.entry
 * @param {number} p.stopPrice          — текущий стоп (он же текущий пол)
 * @param {number} [p.initialStopPrice] — стоп на входе; эталон шкалы R
 * @param {boolean} p.isShort
 * @param {number} p.peakR         — пик хода в R
 * @param {number} p.giveBackR     — отступ пола от пика, в R
 * @param {number} p.minStepPct    — минимальный шаг перестановки, % от входа
 * @returns {{move:false}|{move:true, px:number, fromR:number, toR:number}}
 */
export function decideFloorMove({
  entry, stopPrice, initialStopPrice, isShort, peakR, giveBackR, minStepPct,
}) {
  const risk = riskDistance({ entry, stopPrice: initialStopPrice ?? stopPrice });
  if (risk == null || !(stopPrice > 0)) return { move: false };
  if (![peakR, giveBackR, minStepPct].every((v) => Number.isFinite(v))) return { move: false };

  const targetFloorR = peakR - giveBackR;
  const px = isShort ? entry - targetFloorR * risk : entry + targetFloorR * risk;
  if (!(px > 0)) return { move: false };

  // Куда двигать: в мою сторону = ВНИЗ для шорта, ВВЕРХ для лонга.
  const better = isShort ? px < stopPrice : px > stopPrice;
  if (!better) return { move: false };

  const stepPct = (Math.abs(px - stopPrice) / entry) * 100;
  if (stepPct < minStepPct) return { move: false };

  const curR = (isShort ? entry - stopPrice : stopPrice - entry) / risk;
  return { move: true, px, fromR: curR, toR: targetFloorR };
}
