// ─────────────────────────────────────────────────────────────────────
//  Поведение диалога — одно на весь дашборд.
//
//  До 04.09.2026 модалок было пять (help, детали сделки, what-if, ручной
//  папер + подтверждение, trade ticket), и каждая вела себя по-своему:
//  своя подписка на Escape, свой `document.body.style.overflow = "hidden"`,
//  фокус не переносился и не возвращался, Tab уходил на страницу под
//  диалогом. Отсюда две живые беды:
//   • два открытых диалога подряд (детали сделки → what-if) — закрытие
//     второго снимало замок прокрутки, хотя первый ещё открыт. Поэтому
//     замок здесь СЧИТАЮЩИЙ, а не булев;
//   • Escape ловил только тот диалог, который сам подписался, и в half-
//     мигрированных местах не работал вовсе.
//
//  Стили — в styles/core/_modals.scss. Разметку и поведение развели
//  намеренно: расходились именно поведением.
// ─────────────────────────────────────────────────────────────────────

import { icon } from "./icon.js";

/** Стек открытых диалогов: Escape закрывает ВЕРХНИЙ, а не все сразу. */
const stack = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function lockScroll() {
  if (stack.length === 1) document.body.style.overflow = "hidden";
}
function unlockScroll() {
  if (!stack.length) document.body.style.overflow = "";
}

/** Первый осмысленный элемент внутри панели — иначе фокус остаётся снаружи. */
function focusFirst(panel) {
  const target =
    panel.querySelector("[data-autofocus]") ||
    panel.querySelector(FOCUSABLE) ||
    panel;
  // Панели ставим tabindex="-1": иначе .focus() на <div> молча ничего не делает.
  if (target === panel) panel.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

/**
 * Замыкает Tab внутри верхнего диалога. Без этого табом можно уйти на
 * страницу под подложкой: она перекрыта визуально, но живёт в дереве.
 */
function trapTab(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  const items = [...top.panel.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null,
  );
  if (!items.length) {
    e.preventDefault();
    top.panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Глобальный слушатель клавиш вешается ЛЕНИВО, при первом открытии диалога.
 *
 * 🚨 На верхнем уровне модуля его быть не может: tradeTicket.js импортируется
 * юнит-тестами в Node, где `document` не существует, и весь файл падал на
 * импорте (tests/tradeTicket.test.js, 04.09.2026). Заодно это честнее: пока
 * ни один диалог не открывали, слушать нечего.
 */
let keysBound = false;
function bindKeys() {
  if (keysBound || typeof document === "undefined") return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    if (!stack.length) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close(stack[stack.length - 1].root);
    } else if (e.key === "Tab") {
      trapTab(e);
    }
  });
}

/**
 * Открывает диалог. `root` — контейнер `.modal` (со скрытым `hidden`),
 * внутри которого лежат `.modal__backdrop` и `.modal__panel`.
 *
 * onClose зовётся ПОСЛЕ закрытия — там, где нужно прибрать состояние
 * (сбросить форму, отменить polling).
 */
export function open(root, { onClose } = {}) {
  if (!root || stack.some((d) => d.root === root)) return;
  const panel = root.querySelector(".modal__panel");
  if (!panel) return;
  bindKeys();

  stack.push({ root, panel, onClose, restore: document.activeElement });
  root.hidden = false;
  // 🚨 Между `hidden = false` и классом обязателен принудительный reflow:
  // браузеру нужно зафиксировать начальное состояние, иначе переходу не с чего
  // стартовать. rAF тут не годится — в фоновой вкладке кадров нет и панель
  // осталась бы невидимой.
  void root.offsetHeight;
  root.classList.add("is-open");
  lockScroll();
  focusFirst(panel);
}

/**
 * Закрывает диалог: снимает is-open, ждёт уход панели, потом прячет. Фокус и
 * замок прокрутки возвращаются сразу — они про управление, не про картинку.
 */
export function close(root) {
  const i = stack.findIndex((d) => d.root === root);
  if (i === -1) return;
  const [dlg] = stack.splice(i, 1);
  dlg.root.classList.remove("is-open");
  // Страховка по таймеру обязательна: transitionend не придёт в фоновой
  // вкладке и при reduced-motion.
  const hide = () => {
    if (!dlg.root.classList.contains("is-open")) dlg.root.hidden = true;
  };
  dlg.panel.addEventListener("transitionend", hide, { once: true });
  setTimeout(hide, 400);
  unlockScroll();
  // Фокус обязан вернуться на кнопку, которая открыла диалог: иначе после
  // Escape человек оказывается в начале страницы и теряет место.
  if (dlg.restore && document.contains(dlg.restore)) {
    dlg.restore.focus({ preventScroll: true });
  }
  dlg.onClose?.();
}

export function isOpen(root) {
  return stack.some((d) => d.root === root);
}

/**
 * Вешает закрытие по клику на подложку и на всё, что помечено
 * `data-close`. Достаточно одного вызова на контейнер за время жизни
 * страницы — слушатель делегированный и переживает ре-рендер тела.
 */
export function bindClose(root) {
  if (!root || root.dataset.dialogBound) return;
  root.dataset.dialogBound = "1";
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close(root);
  });
}

/**
 * Разметка шапки диалога. Держим её здесь, а не в каждой фиче: «привести
 * модалки к одному виду» ломается ровно там, где каждая рисует свой
 * заголовок и свой крестик.
 *
 * glyph — ключ иконки из icon.js; tone — "", "danger" или "warn".
 */
export function head({ glyph = "info", title, sub = "" }) {
  return `
    <div class="modal__head">
      <div class="modal__glyph">${icon(glyph)}</div>
      <div class="modal__titles">
        <div class="modal__title">${title}</div>
        ${sub ? `<div class="modal__sub">${sub}</div>` : ""}
      </div>
      <button type="button" class="modal__close" data-close="1" aria-label="Close">
        ${icon("close")}
      </button>
    </div>`;
}

/**
 * Оболочка `.modal` по id — создаётся один раз и переиспользуется. Если такой
 * элемент уже лежит в статической разметке страницы, берётся он.
 */
export function shell(id, { wide = false } = {}) {
  const found = document.getElementById(id);
  if (found) {
    bindClose(found);
    return found;
  }
  const el = document.createElement("div");
  el.id = id;
  el.className = "modal";
  el.hidden = true;
  el.innerHTML = `
    <div class="modal__backdrop" data-close="1"></div>
    <div class="modal__panel${wide ? " modal__panel--wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal__content"></div>
    </div>`;
  document.body.appendChild(el);
  bindClose(el);
  return el;
}

/**
 * Ядро: одна оболочка, разное содержимое. Шапка, крестик и ряд действий —
 * общие, меняется только тело. Фича со своей вёрсткой целиком (trade ticket)
 * зовёт shell/open/close напрямую.
 *
 * @param {object} o
 * @param {string} o.id        id оболочки: один диалог — одна оболочка
 * @param {string} [o.glyph]   иконка в кружке шапки (ключ core/icon.js)
 * @param {string} o.title
 * @param {string} [o.sub]     подзаголовок под ним
 * @param {string} [o.tone]    "" | "danger" | "warn" — красит кружок шапки
 * @param {boolean} [o.wide]   560px вместо 420px (диалог с таблицами)
 * @param {string} [o.body]    разметка тела
 * @param {string} [o.actions] разметка ряда кнопок под телом
 * @param {Function} [o.onClose]
 * @returns {HTMLElement} корень диалога — на случай, если нужен доступ к DOM
 */
export function show({
  id,
  glyph = "info",
  title = "",
  sub = "",
  tone = "",
  wide = false,
  body = "",
  actions = "",
  onClose,
} = {}) {
  const root = shell(id, { wide });
  const panel = root.querySelector(".modal__panel");
  panel.classList.toggle("modal__panel--wide", wide);
  root.classList.remove("modal--danger", "modal--warn");
  if (tone) root.classList.add(`modal--${tone}`);
  // Содержимое — в свой контейнер: перерисовка тела не должна сносить то, что
  // фича положила в панель рядом.
  const host = panel.querySelector(".modal__content") || panel;
  host.innerHTML =
    head({ glyph, title, sub }) +
    (body ? `<div class="modal__body">${body}</div>` : "") +
    (actions ? `<div class="modal__actions">${actions}</div>` : "");
  open(root, { onClose });
  return root;
}
