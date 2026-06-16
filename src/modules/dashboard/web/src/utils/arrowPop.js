// ─────────────────────────────────────────────────
//  Живая стрелка-шеврон активной монеты (Hot Movers + Setup).
//  Вместо крутящегося глифа ↑/↓ — стопка из 3 шевронов (SVG), которую гораздо
//  проще «настроить» визуально:
//   • ЦВЕТ — по направлению цены: серый по умолчанию (видно на тёмной/светлой
//     теме), зелёный вверх / красный вниз при тике по WS.
//   • СИЛА — |Δ%| тика задаёт data-strength (1..3): сколько шевронов от острия
//     зажигается цветом, плюс амплитуду подпрыгивания (--hm-pop).
//   • АНИМАЦИЯ — волна-«подпрыгивание» к острию (вверх для роста, вниз для
//     падения), а не вращение. Шевроны подсвечиваются по очереди от хвоста к острию.
//  АНТИ-СТРОБ (как раньше): WS шлёт цену по нескольку раз в секунду → идущую
//  волну НЕ перебиваем, пока новый удар не СИЛЬНЕЕ текущего; флаг снимается по
//  animationend собственной анимации спана (target === arrow).
// ─────────────────────────────────────────────────

const NOISE_PCT = 0.003; // |Δ%| ниже — шум, не ретригерим (иначе мелкая дрожь)
const TIER_1 = 0.02; // <TIER_1 → 1 шеврон (слабый тик)
const TIER_2 = 0.08; // <TIER_2 → 2 шеврона, иначе 3 (сильный удар)
const MIN_SCALE = 1.05; // минимальная амплитуда подпрыгивания
const MAX_SCALE = 1.5; // максимальная амплитуда
const GAIN = 1.6; // |Δ%| → амплитуда

// 🚀 Экстрим: тик сильнее EXTREME_PCT (одиночный WS-удар!) → поверх шеврона
// запускаем ракету. Редкое событие (обычный тик << 0.1%), поэтому ощущается
// как «полетела». Cooldown не даёт спамить серией ударов подряд.
const EXTREME_PCT = 0.12;
const ROCKET_COOLDOWN_MS = 1400;
const _lastRocketAt = new WeakMap(); // arrow → ts последнего запуска

// Аккуратная SVG-ракета остриём вверх (для «вниз» весь оверлей разворачивается
// в CSS). Корпус/плавники = currentColor (зелёный рост / красный падение),
// иллюминатор = фон карточки, пламя = тёплый оранжевый (читается в обе стороны).
const ROCKET_SVG =
  '<svg class="hm-rkt" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path class="rkt-flame" d="M10.1 16.5h3.8c-.2 2.2-.9 4-1.9 5.3-1-1.3-1.7-3.1-1.9-5.3z"/>' +
  '<path class="rkt-body" d="M12 1.8c2.7 2.6 4.3 6.3 4.3 10.3 0 1.9-.5 3.5-1.3 4.9H9c-.8-1.4-1.3-3-1.3-4.9 0-4 1.6-7.7 4.3-10.3z"/>' +
  '<path class="rkt-fin" d="M7.9 12.6c-1.9 1-3 2.6-3.3 4.9 1.9-.2 3.4-1 4.4-2.2"/>' +
  '<path class="rkt-fin" d="M16.1 12.6c1.9 1 3 2.6 3.3 4.9-1.9-.2-3.4-1-4.4-2.2"/>' +
  '<circle class="rkt-win" cx="12" cy="9.6" r="1.9"/>' +
  "</svg>";

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Одноразовая ракета поверх стрелки: летит вверх (рост) или ныряет вниз
// (падение), оставляет короткий шлейф и сама себя удаляет по animationend.
// Не трогает персистентный шеврон-узел — просто оверлей.
function launchRocket(arrow, up) {
  if (prefersReducedMotion()) return;
  const now = Date.now();
  if (now - (_lastRocketAt.get(arrow) || 0) < ROCKET_COOLDOWN_MS) return;
  _lastRocketAt.set(arrow, now);

  const rocket = document.createElement("span");
  rocket.className = `hm-rocket ${up ? "up" : "down"}`;
  rocket.innerHTML = ROCKET_SVG;
  arrow.appendChild(rocket);
  rocket.addEventListener("animationend", () => rocket.remove(), { once: true });
  // Подстраховка, если animationend не прилетит (анимация отменена и т.п.).
  setTimeout(() => rocket.remove(), 1200);
}

// Стопка из трёх шевронов, остриём вверх. Для «вниз» весь SVG отражается по Y
// в CSS (.chv-arrow.down .chv { transform: scaleY(-1) }) — так и геометрия, и
// порядок подсветки от острия совпадают для обоих направлений.
const CHEVRON_SVG =
  '<svg class="chv" viewBox="0 0 24 26" fill="none" aria-hidden="true">' +
  '<path class="chv-p chv-1" d="M5 8 L12 3 L19 8"/>' +
  '<path class="chv-p chv-2" d="M5 15 L12 10 L19 15"/>' +
  '<path class="chv-p chv-3" d="M5 22 L12 17 L19 22"/>' +
  "</svg>";

// Один раз вложить SVG-шевроны в пустой спан стрелки.
export function initChevronArrow(arrow) {
  if (arrow.dataset.chv === "1") return;
  arrow.dataset.chv = "1";
  arrow.classList.add("chv-arrow");
  arrow.innerHTML = CHEVRON_SVG;
}

// Навесить один раз: по завершении СОБСТВЕННОЙ анимации спана снять флаг волны.
// Анимации дочерних путей всплывают сюда же — их игнорируем (target !== arrow).
export function bindArrowPopEnd(arrow) {
  if (arrow.dataset.popBound === "1") return;
  arrow.dataset.popBound = "1";
  arrow.addEventListener("animationend", (e) => {
    if (e.target !== arrow) return;
    arrow.dataset.popping = "0";
    arrow.dataset.popScale = "0";
    arrow.classList.remove("wave");
  });
}

// Проиграть волну при изменении цены. deltaPct = |Δ%| относительно прошлой цены.
export function popArrow(arrow, up, deltaPct) {
  initChevronArrow(arrow);
  // Направление держим актуальным даже на микро-тике.
  arrow.classList.remove(up ? "down" : "up");
  arrow.classList.add(up ? "up" : "down");

  if (!(deltaPct > NOISE_PCT)) return; // шум → без волны

  const tier = deltaPct < TIER_1 ? 1 : deltaPct < TIER_2 ? 2 : 3;
  arrow.dataset.strength = String(tier);

  const scale = Math.min(MAX_SCALE, MIN_SCALE + deltaPct * GAIN);
  const running = arrow.dataset.popping === "1";
  const runScale = parseFloat(arrow.dataset.popScale || "0");
  // Идёт волна и новый удар не сильнее → не перебиваем, даём доиграть (анти-строб).
  if (running && scale <= runScale) return;

  arrow.style.setProperty("--hm-pop", scale.toFixed(2));
  arrow.dataset.popScale = String(scale);
  arrow.dataset.popping = "1";
  arrow.classList.remove("wave");
  void arrow.offsetWidth; // reflow → чистый перезапуск анимации
  arrow.classList.add("wave");

  // Сильный одиночный удар → ракета поверх шеврона.
  if (deltaPct >= EXTREME_PCT) launchRocket(arrow, up);
}
