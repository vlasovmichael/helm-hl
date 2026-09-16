// Обвязка страницы: штамп даты в шапке и нижняя навигация с подсветкой секции.

/** Дата выпуска в шапке: <header data-edition> показывает её через CSS. */
export function stampEdition() {
  const hdr = document.querySelector("header[data-edition]");
  if (!hdr) return;
  hdr.setAttribute("data-edition", new Date().toISOString().slice(0, 10));
}

// Отступ под липкой шапкой при прокрутке к секции.
const NAV_OFFSET_PX = 70;

/**
 * Нижняя навигация: клик ведёт к секции, активная кнопка следует за скроллом.
 * @returns {() => void} остановка: снимает наблюдатель и слушатели.
 */
export function initBottomNav() {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return () => {};

  const btns = Array.from(nav.querySelectorAll("[data-target]"));
  const onClick = (btn) => () => {
    const el = document.getElementById(btn.dataset.target);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.pageYOffset - NAV_OFFSET_PX;
    window.scrollTo({ top: y, behavior: "smooth" });
  };

  const bound = btns.map((btn) => {
    const handler = onClick(btn);
    btn.addEventListener("click", handler);
    return { btn, handler };
  });

  if (!("IntersectionObserver" in window)) {
    return () => {
      for (const { btn, handler } of bound) btn.removeEventListener("click", handler);
    };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      // Активна секция, ближайшая к верху кадра из видимых сейчас.
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      for (const b of btns) b.classList.toggle("active", b.dataset.target === visible.target.id);
    },
    { rootMargin: "-30% 0px -55% 0px", threshold: 0 },
  );

  for (const btn of btns) {
    const section = document.getElementById(btn.dataset.target);
    if (section) observer.observe(section);
  }

  return () => {
    observer.disconnect();
    for (const { btn, handler } of bound) btn.removeEventListener("click", handler);
  };
}
