// ─────────────────────────────────────────────────
//  Odometer-анимация числа (digit-reel барабаны)
// ─────────────────────────────────────────────────
// Единственное место: крутят и Total Equity (accountStatus), и цену BTC в плашке
// Market Context. Меняем только отличающиеся разряды; катим КРАТЧАЙШИМ путём
// (5→4 = 1 шаг вниз, а не 9 вверх «целым кругом»). Цифры фикс-ширины в контейнере
// .animated-value (overflow:hidden, 1.1em) → смена значения не меняет ширину.
// CSS: styles/core/_activity.scss (.animated-value / .digit-reel).

const lastAnimatedValues = new Map(); // elId → последняя показанная строка

export function updateAnimatedNumber(elId, newValueStr) {
  const el = document.getElementById(elId);
  if (!el) return;
  const prev = lastAnimatedValues.get(elId) || "";
  if (prev === newValueStr) return;

  const oldStr = prev || newValueStr;
  lastAnimatedValues.set(elId, newValueStr);

  el.innerHTML = "";
  const maxLength = Math.max(oldStr.length, newValueStr.length);
  const oldPadded = oldStr.padStart(maxLength, " ");
  const newPadded = newValueStr.padStart(maxLength, " ");

  for (let i = 0; i < maxLength; i++) {
    const charOld = oldPadded[i];
    const charNew = newPadded[i];

    if (charOld === charNew) {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    } else if (/[0-9]/.test(charNew)) {
      const reel = document.createElement("div");
      reel.className = "digit-reel";
      const startDigit = /[0-9]/.test(charOld) ? Number(charOld) : 0;
      const endDigit = Number(charNew);
      // Кратчайший путь: fwd — шагов вверх, bwd — вниз; берём меньшее.
      const fwd = (endDigit - startDigit + 10) % 10;
      const bwd = (startDigit - endDigit + 10) % 10;
      const up = fwd <= bwd;             // вверх короче (или равно)
      const steps = up ? fwd : bwd;
      const addSpan = (d) => {
        const s = document.createElement("span");
        s.textContent = String(d);
        reel.appendChild(s);
      };
      const offset = `translateY(-${steps * 1.1}em)`;
      if (up) {
        // start сверху, end снизу → катим вверх (transform 0 → -steps).
        for (let k = 0; k <= steps; k++) addSpan((startDigit + k) % 10);
        el.appendChild(reel);
        requestAnimationFrame(() => { reel.style.transform = offset; });
      } else {
        // вниз: колонка [end..start] (end сверху). Стартуем со start (низ),
        // анимируем к end (верх): transform -steps → 0 (визуально едет вниз).
        for (let k = steps; k >= 0; k--) addSpan((startDigit - k + 10) % 10);
        reel.style.transform = offset; // показать start сразу, без анимации
        el.appendChild(reel);
        void reel.offsetHeight;        // зафиксировать стартовый кадр (reflow)
        requestAnimationFrame(() => { reel.style.transform = "translateY(0)"; });
      }
    } else {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    }
  }
}
