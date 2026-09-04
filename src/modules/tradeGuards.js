// ─────────────────────────────────────────────────
//  Гейты ручного входа — то, что закрывает кнопку, а не подсказывает
// ─────────────────────────────────────────────────
// Повод: 17 сделок за сутки, −$4.38. Разложение показало, что
// минус сидит не в выходах и не в комиссиях ($0.19 = 4% минуса), а в
// перезаходах: 9 входов быстрее 2 минут после закрытия, 8 из них разворотом
// стороны, 6 сразу после убытка. Их суммарный PnL −$6.37 при итоге дня −$4.38 —
// то есть всё остальное было в плюсе.
//
// Счётчик сделок при этом показывал «14 / 5 · over the daily trade budget» и не
// останавливал ничего: это была надпись. Здесь она становится отказом.
//
// Обе рельсы гейтят ТОЛЬКО вход. Выход не запирается никогда — запертый выход
// это позиция без права закрыться, что хуже любого перезахода.
//
// Здесь только чистое ядро — ни config, ни БД, чтобы гейты можно было
// протестировать без живого кошелька. Данные достаёт вызывающий
// (src/modules/dashboard/routes/tradeTicket.js).

/**
 * Бюджет сделок за день. Открытые позиции считаются наравне с закрытыми: иначе
 * можно набрать пять открытых и получить «0 / 5», потому что ни одна ещё не
 * закрылась.
 *
 * @param {{closed:number, open:number, cap:number}} p
 * @returns {{ today:number, cap:number, over:boolean, known:boolean }}
 */
export function computeTradesToday({ closed, open, cap }) {
  const today = closed + open;
  return { today, cap, over: today >= cap, known: true };
}

/**
 * Пауза после закрытия сделки по монете.
 *
 * @param {{lastCloseAt:number|null, lastPnl:number|null, minutes:number, now:number}} p
 * @returns {{ blocked:boolean, minutes:number, secondsLeft:number,
 *             lastCloseAt:number|null, lastPnl:number|null }}
 */
export function computeCooldown({ lastCloseAt, lastPnl = null, minutes, now }) {
  const idle = { blocked: false, minutes, secondsLeft: 0, lastCloseAt: null, lastPnl: null };
  if (!(minutes > 0) || !Number.isFinite(lastCloseAt)) return idle;
  const secondsLeft = Math.ceil((lastCloseAt + minutes * 60_000 - now) / 1000);
  if (secondsLeft <= 0) return idle;
  return {
    blocked: true,
    minutes,
    secondsLeft,
    lastCloseAt,
    lastPnl: Number.isFinite(lastPnl) ? lastPnl : null,
  };
}
