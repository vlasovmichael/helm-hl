// ─────────────────────────────────────────────────────────────────────
//  Hover-card — карточка, которая раскрывается при наведении.
//
//  🚨 Нативный `title` в интерфейсе не годится: он ждёт секунду, не
//  переносится, не красится темой и НА ТЕЛЕФОНЕ НЕ ПОКАЗЫВАЕТСЯ ВООБЩЕ —
//  объяснение, написанное в title, с телефона недоступно.
//
//  Поведение снято с hover-card (shadcn/Radix), а не с tooltip: карточка
//  открывается с заметной задержкой, закрывается с запозданием и ДЕРЖИТСЯ,
//  пока курсор внутри неё. Разница не косметическая — у нас в подсказках
//  лежат объяснения на две-три строки, а подсказка-плашка исчезает от любого
//  движения мыши, и дочитать её нельзя.
//
//  Разметку не трогаем: карточка живёт одним узлом в body и находит хозяина
//  делегированием — поэтому работает и на строках, которые перерисовываются
//  каждый тик (Hot Movers, таблицы).
//
//  Атрибут один: data-card="текст". Ширину выбирает сама карточка по длине.
// ─────────────────────────────────────────────────────────────────────

const OPEN_DELAY_MS = 500;   // не выскакивать на проводке курсором через ряд
const CLOSE_DELAY_MS = 250;  // дать курсору дойти до самой карточки
const GAP = 8;               // зазор до хозяина
const EDGE = 8;              // минимальный отступ от края экрана

/** Текст длиннее — карточка шире: две строки в узкой колонке читаются хуже. */
export const WIDE_FROM = 120;

let cardEl = null;
let owner = null;
let openTimer = null;
let closeTimer = null;
let seq = 0;

function ensureEl() {
  if (cardEl) return cardEl;
  cardEl = document.createElement("div");
  cardEl.className = "hovercard";
  cardEl.hidden = true;
  // Курсор внутри карточки — она остаётся: текст читают и выделяют.
  cardEl.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  cardEl.addEventListener("mouseleave", () => close());
  document.body.appendChild(cardEl);
  return cardEl;
}

function place(el, host) {
  // Меряем на экране, но прозрачной: размеры нужны до того, как её увидят.
  el.style.left = "0px";
  el.style.top = "0px";
  el.hidden = false;
  const r = host.getBoundingClientRect();
  const t = el.getBoundingClientRect();

  // Сверху, если помещается, иначе снизу. По горизонтали — центр хозяина с
  // прижатием к краю экрана; «умного» выбора сторон нет намеренно, он делает
  // положение карточки непредсказуемым при прокрутке.
  const above = r.top - t.height - GAP >= EDGE;
  const top = above ? r.top - t.height - GAP : r.bottom + GAP;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - t.width - EDGE));

  el.classList.toggle("hovercard--below", !above);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function open(host) {
  const text = host.dataset.card || "";
  if (!text) return;
  clearTimeout(closeTimer);
  const el = ensureEl();
  if (owner && owner !== host) owner.removeAttribute("aria-describedby");
  owner = host;
  el.textContent = text;
  el.classList.toggle("hovercard--wide", text.length > WIDE_FROM);
  if (!el.id) el.id = `hovercard-${++seq}`;
  host.setAttribute("aria-describedby", el.id);
  place(el, host);
  // 🚨 Класс появления ставим после ПРИНУДИТЕЛЬНОГО reflow, а не в
  // requestAnimationFrame: в фоновой вкладке кадры не идут, и карточка
  // осталась бы висеть прозрачной.
  void el.offsetHeight;
  el.classList.add("is-open");
}

function close(immediate = false) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(
    () => {
      if (!cardEl) return;
      cardEl.classList.remove("is-open");
      cardEl.hidden = true;
      if (owner) owner.removeAttribute("aria-describedby");
      owner = null;
    },
    immediate ? 0 : CLOSE_DELAY_MS,
  );
}

/** Закрыть карточку немедленно — например перед открытием диалога. */
export function closeHoverCard() {
  close(true);
}

let bound = false;

/**
 * Включает hover-карточки на странице. Зовётся один раз, из mountTopnav.
 *
 * 🚨 Слушатели вешаются ЛЕНИВО, как и в core/dialog.js: модуль импортируется
 * юнит-тестами в Node, где `document` не существует.
 */
export function initHoverCards() {
  if (bound || typeof document === "undefined") return;
  bound = true;

  const hostOf = (t) => (t instanceof Element ? t.closest("[data-card]") : null);

  document.addEventListener("mouseover", (e) => {
    const host = hostOf(e.target);
    if (!host || host === owner) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => open(host), OPEN_DELAY_MS);
  });

  document.addEventListener("mouseout", (e) => {
    const host = hostOf(e.target);
    if (!host) return;
    // 🚨 Таймер открытия гасим ВСЕГДА, а не только когда карточка уже видна:
    // иначе курсор уходит раньше задержки, а карточка всё равно выскакивает —
    // над местом, где мыши давно нет.
    clearTimeout(openTimer);
    if (host === owner) close();
  });

  // На телефоне наведения не существует, и тап — единственный способ прочитать
  // объяснение. На мыши клик карточку не открывает: нажатие кнопки не должно
  // оставлять за собой висящую панель.
  const noHover = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none)").matches;

  document.addEventListener("click", (e) => {
    const host = hostOf(e.target);
    if (!host) {
      if (owner) close(true);
      return;
    }
    if (!noHover()) return;
    if (owner === host) close(true);
    else open(host);
  });

  // Клавиатура: Radix hover-card фокус игнорирует, но у нас в карточках лежат
  // объяснения интерфейса, и терять их для клавиатуры незачем.
  document.addEventListener("focusin", (e) => {
    const host = hostOf(e.target);
    if (host) open(host);
  });
  document.addEventListener("focusout", () => close(true));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && owner) close(true);
  });

  // Прокрутка и ресайз уводят хозяина из-под карточки — она обязана уйти
  // вместе с ним, а не висеть над чужим местом.
  window.addEventListener("scroll", () => owner && close(true), true);
  window.addEventListener("resize", () => owner && close(true));
}
