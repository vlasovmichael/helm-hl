// Карточки всплывают по мере доскролла. Общий для дашборда и статистики.
//
// 🚨 data-reveal снимаем после входа: атрибут держит на элементе transition по
// transform/opacity, а живой transition не даёт браузеру отпустить
// композиторный слой — отсюда мигающая полоска у плашки (см. _motion.scss).

const REVEAL_FALLBACK_MS = 1500;

/**
 * @param {string} selector — что показывать по мере появления в кадре.
 * @returns {() => void} остановка: снимает наблюдатель.
 */
export function initReveal(selector = "section.card") {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const targets = Array.from(document.querySelectorAll(selector));
  if (reduce || !("IntersectionObserver" in window) || targets.length === 0) {
    return () => {};
  }

  for (const el of targets) el.setAttribute("data-reveal", "");

  const vh = window.innerHeight || 800;
  let firstScreen = 0;
  const timers = new Set();

  const io = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        // Стаггерим только то, что уже в первом экране: карточки ниже всплывают
        // по одной по мере доскролла.
        if (el.getBoundingClientRect().top < vh) {
          el.style.setProperty("--reveal-i", String(firstScreen++));
        }
        el.classList.add("is-revealed");
        obs.unobserve(el);

        const drop = () => {
          el.removeAttribute("data-reveal");
          el.style.removeProperty("--reveal-i");
        };
        el.addEventListener("transitionend", drop, { once: true });
        // Страховка: в фоновой вкладке таймлайн анимаций стоит и transitionend
        // не придёт.
        timers.add(setTimeout(drop, REVEAL_FALLBACK_MS));
      }
    },
    { threshold: 0.08, rootMargin: "0px 0px -8% 0px" },
  );

  for (const el of targets) io.observe(el);

  return () => {
    io.disconnect();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
