// ─────────────────────────────────────────────────
//  Живой «поп» стрелки активной монеты (Hot Movers + Setup).
//  Стрелка крутится (360°) + подпрыгивает (scale) при каждом изменении цены.
//  Две задачи решены здесь:
//   1. АНТИ-СТРОБ: WS шлёт цену по нескольку раз в секунду → если перезапускать
//      анимацию на каждом тике, она не успевает доиграть свои 0.5s и стробит.
//      Поэтому идущий спин НЕ перебиваем, пока новый удар не СИЛЬНЕЕ текущего
//      (микро-тики только обновляют глиф/цвет). Флаг снимается по animationend.
//   2. СИЛА ОТ ВЕЛИЧИНЫ: scale прыжка зависит от |Δ%| цены — чуть дёрнулась →
//      лёгкий поп, ударила сильно → большой скачок. Прокидывается в CSS-var
//      --hm-pop, который читает @keyframes setupLiveSpin.
// ─────────────────────────────────────────────────

const NOISE_PCT = 0.003; // |Δ%| ниже — шум, не ретригерим (иначе мелкая дрожь)
const MIN_SCALE = 1.2; // минимальный поп (едва заметный тик)
const MAX_SCALE = 2.1; // максимальный поп (сильный удар)
const GAIN = 1.6; // |Δ%| → scale: ~0.5% уже почти максимум

// Навесить один раз: по завершении спина снять флаг «идёт анимация».
export function bindArrowPopEnd(arrow) {
  if (arrow.dataset.popBound === "1") return;
  arrow.dataset.popBound = "1";
  arrow.addEventListener("animationend", () => {
    arrow.dataset.popping = "0";
    arrow.dataset.popScale = "0";
  });
}

// Проиграть поп при изменении цены. deltaPct = |Δ%| относительно прошлой цены.
export function popArrow(arrow, up, deltaPct) {
  // Всегда держим глиф/цвет актуальными (даже на микро-тике).
  arrow.textContent = up ? "↑" : "↓";
  arrow.classList.remove(up ? "down" : "up");
  arrow.classList.add(up ? "up" : "down");

  if (!(deltaPct > NOISE_PCT)) return; // шум → без анимации

  const scale = Math.min(MAX_SCALE, MIN_SCALE + deltaPct * GAIN);
  const running = arrow.dataset.popping === "1";
  const runScale = parseFloat(arrow.dataset.popScale || "0");
  // Идёт спин и новый удар не сильнее → не перебиваем, даём доиграть (анти-строб).
  if (running && scale <= runScale) return;

  arrow.style.setProperty("--hm-pop", scale.toFixed(2));
  arrow.dataset.popScale = String(scale);
  arrow.dataset.popping = "1";
  arrow.classList.remove("spin");
  void arrow.offsetWidth; // reflow → чистый перезапуск анимации
  arrow.classList.add("spin");
}
