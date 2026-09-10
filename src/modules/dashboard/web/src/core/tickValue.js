// ─────────────────────────────────────────────────
//  Живое число: подсвечивается ТОЛЬКО изменившийся хвост.
//
//  Приём взят из плашки BTC и вынесен сюда, чтобы живые числа по дашборду
//  вели себя одинаково. Смысл: «$77,356.0» → «$77,344.2» отличается хвостом,
//  и глаз должен ловить именно его, а не перечитывать всё число.
//
//  🚨 Не одометр и не мигание всей ячейки: крутящиеся барабаны и вспышки на
//  крупном числе тянут взгляд на движение вместо значения.
// ─────────────────────────────────────────────────

const prev = new WeakMap(); // el → последняя показанная строка

/**
 * @param {HTMLElement} el   куда писать
 * @param {string} next      новое значение, уже отформатированное
 * @param {boolean|null} up  направление (true — вверх), null — не красить
 */
export function renderTickValue(el, next, up = null) {
  if (!el) return;
  const was = prev.get(el);
  if (was === next) return;
  const cls = was == null || up == null ? "" : up ? "tick-up" : "tick-dn";

  // Общий префикс сравниваем как строки — разряды не разъезжаются, потому что
  // формат один и тот же.
  let i = 0;
  while (i < next.length && was != null && i < was.length && next[i] === was[i]) i++;

  el.textContent = "";
  if (i > 0) {
    const head = document.createElement("span");
    head.textContent = next.slice(0, i);
    el.appendChild(head);
  }
  if (i < next.length) {
    const tail = document.createElement("span");
    if (cls) tail.className = cls;
    tail.textContent = next.slice(i);
    el.appendChild(tail);
  }
  prev.set(el, next);
}
