// ─────────────────────────────────────────────────────────────────────
//  Компоненты интерфейса — сборка разметки в одном месте.
//
//  Набор и форма пропов сняты с shadcn/ui (variant / size / disabled,
//  Button · Badge · Input · Segmented): язык знакомый и проверенный. Сам
//  shadcn сюда не поставить — он React + Tailwind + Radix, а дашборд это
//  ванильные шаблонные строки и SCSS; переезд ради кнопок означал бы
//  переписать весь фронт. Взяли API, а не пакет.
//
//  ── Кнопка ───────────────────────────────────────────────────────────
//
//  Форму и цвет держит CSS (`core/_controls.scss`), а здесь — СБОРКА
//  разметки: одно место, где решается, что кнопка это <button type="button">
//  с иконкой слева, подписью, необязательным счётчиком и корректным
//  aria-label, когда подписи нет.
//
//  Зачем компонент, если есть класс: до 04.09.2026 классы уже свели к .btn,
//  но каждая фича по-прежнему собирала строку руками — и расходилась в
//  мелочах: где-то забыт type="button" (кнопка внутри формы сабмитила её),
//  где-то иконочная кнопка без aria-label (скринридер читает пустоту),
//  где-то disabled ставился как disabled="false" (что означает «выключена»).
//
//  🚨 Возвращается РАЗМЕТКА, а не узел: вызовы стоят внутри шаблонных строк
//  рядом с icon(). Всё, что попадает в подпись и в атрибуты, экранируется
//  здесь — снаружи про это помнить не нужно.
//
//  Роли (variant) намеренно ограничены. Новых не заводить: если действию
//  «не хватает» цвета, почти всегда это значит, что на экране два главных
//  действия, и решать надо не цветом.
//    primary — главное действие экрана/диалога, ОДНО;
//    danger  — необратимое или стоящее денег;
//    ghost   — второстепенное («Отмена», «Ещё»);
//    default — всё остальное (тихая обведённая).
// ─────────────────────────────────────────────────────────────────────

import { icon as glyph } from "./icon.js";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const VARIANTS = new Set(["primary", "danger", "ghost", "long", "short"]);
const SIZES = new Set(["sm", "lg"]);

/**
 * @param {object} o
 * @param {string} [o.label]    подпись; пустая → кнопка считается иконочной
 * @param {string} [o.icon]     ключ из core/icon.js, иконка слева
 * @param {string} [o.iconEnd]  иконка справа (напр. «Next ›»)
 * @param {string} [o.variant]  primary | danger | ghost
 * @param {string} [o.size]     sm | lg
 * @param {boolean} [o.cta]     полоса действия во всю ширину
 * @param {boolean} [o.disabled]
 * @param {string} [o.type]     button (по умолчанию) | submit
 * @param {string} [o.title]
 * @param {string} [o.aria]     aria-label; для иконочной кнопки обязателен
 * @param {string} [o.cls]      дополнительные классы (хук для JS-выборки)
 * @param {object} [o.attrs]    data-атрибуты и прочее: { "data-side": "long" }
 */
export function button({
  label = "",
  icon = "",
  iconEnd = "",
  variant = "",
  size = "",
  cta = false,
  disabled = false,
  type = "button",
  title = "",
  aria = "",
  cls = "",
  attrs = {},
} = {}) {
  const iconOnly = !label && (icon || iconEnd);
  const classes = ["btn"];
  if (VARIANTS.has(variant)) classes.push(`btn--${variant}`);
  if (SIZES.has(size)) classes.push(`btn--${size}`);
  if (cta) classes.push("btn--cta");
  if (iconOnly) classes.push("btn--icon");
  if (cls) classes.push(cls);

  // Иконочная кнопка обязана называться — иначе она немая для скринридера.
  const ariaLabel = aria || (iconOnly ? title : "");

  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== false && v != null)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");

  return (
    `<button type="${esc(type)}" class="${classes.join(" ")}"` +
    (title ? ` title="${esc(title)}"` : "") +
    (ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : "") +
    (disabled ? " disabled" : "") +
    `${extra}>` +
    (icon ? glyph(icon) : "") +
    (label ? esc(label) : "") +
    (iconEnd ? glyph(iconEnd) : "") +
    `</button>`
  );
}

/**
 * Сегментный выбор — «две-пять видимых опций, один клик». Отдельный
 * компонент, а не набор кнопок: ряд кнопок читается как ряд ДЕЙСТВИЙ, а
 * это ВЫБОР, и разница должна быть видна до наведения.
 *
 * options: [{ value, label, tone }], tone = "" | "long" | "short" — тон
 * подкрашивает только ВЫБРАННЫЙ сегмент (зелёный лонг / красный шорт).
 */
export function segmented({ options = [], value = "", name = "seg", cls = "", wide = false } = {}) {
  const items = options
    .map((o) => {
      const on = String(o.value) === String(value);
      const tone = o.tone ? ` seg__btn--${o.tone}` : "";
      return (
        `<button type="button" class="seg__btn${tone}${on ? " is-on active" : ""}"` +
        ` data-${esc(name)}="${esc(o.value)}" aria-pressed="${on}">` +
        (o.icon ? glyph(o.icon) + " " : "") +
        `${esc(o.label)}</button>`
      );
    })
    .join("");
  return `<div class="seg${wide ? " seg--wide" : ""}${cls ? " " + cls : ""}" role="group">${items}</div>`;
}

/**
 * Поле ввода. Единственная причина существовать компонентом — тикер: поле
 * монеты в трёх диалогах трижды описывало «моно + капслок + подсказка
 * обычным шрифтом», и они успели разойтись.
 *
 * @param {object} o
 * @param {string} [o.id]
 * @param {string} [o.value]
 * @param {string} [o.placeholder]
 * @param {boolean} [o.ticker]   моно + капслок (поле монеты)
 * @param {boolean} [o.block]    во всю ширину формы
 * @param {object} [o.attrs]
 */
export function field({
  id = "",
  value = "",
  placeholder = "",
  type = "text",
  ticker = false,
  block = false,
  cls = "",
  attrs = {},
} = {}) {
  const classes = ["field"];
  if (ticker) classes.push("field--ticker");
  if (block) classes.push("field--block");
  if (cls) classes.push(cls);
  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== false && v != null)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");
  return (
    `<input class="${classes.join(" ")}" type="${esc(type)}"` +
    (id ? ` id="${esc(id)}"` : "") +
    ` value="${esc(value)}"` +
    (placeholder ? ` placeholder="${esc(placeholder)}"` : "") +
    ` autocomplete="off" spellcheck="false"${extra}>`
  );
}

/**
 * Бейдж — статус или метка рядом с текстом (LONG / PAPER / BOT). Не кнопка:
 * на него не нажимают, поэтому и вид у него другой.
 */
export function badge({ label = "", tone = "", title = "", cls = "" } = {}) {
  const classes = ["badge"];
  if (tone) classes.push(`badge--${tone}`);
  if (cls) classes.push(cls);
  return (
    `<span class="${classes.join(" ")}"` +
    (title ? ` title="${esc(title)}"` : "") +
    `>${esc(label)}</span>`
  );
}

/**
 * Слайдер. Заливку до бегунка несёт --fill: браузер не умеет красить
 * пройденную часть <input type=range> одинаково в webkit и gecko, поэтому
 * фон рисуется градиентом, а процент считается здесь.
 */
export function slider({ name = "", value = 0, min = 0, max = 100, step = 1, cls = "" } = {}) {
  const pct = max > min ? ((Number(value) - min) / (max - min)) * 100 : 0;
  return (
    `<input class="slider${cls ? " " + cls : ""}" type="range"` +
    (name ? ` data-slider="${esc(name)}"` : "") +
    ` min="${esc(min)}" max="${esc(max)}" step="${esc(step)}" value="${esc(value)}"` +
    ` style="--fill:${Math.max(0, Math.min(100, pct)).toFixed(2)}%">`
  );
}

/**
 * Карточка параметра диалога: подпись, слева «относительно чего», справа
 * крупное число, под ними — что угодно (слайдер, поле, ошибка).
 *
 * Ровно та карточка, из которых собран «Open Position». Вынесена сюда, чтобы
 * второй диалог с теми же по смыслу полями (ручной папер) не собирал свою
 * похожую форму заново — именно так они и разъезжались.
 *
 * @param {string} [o.label]     подпись параметра
 * @param {string} [o.labelSub]  мелким шрифтом рядом с подписью — «(USDC)»
 * @param {string} [o.chip]      чип справа от подписи — «Isolated»
 * @param {string} [o.minorValue] число слева (моно, крупно)
 * @param {string} [o.minorNote]  подпись под ним — «available»
 * @param {string} [o.major]     главное число справа
 * @param {string} [o.majorUnit] его единица — «x»
 * @param {boolean} [o.bad]      главное число красным (значение невалидно)
 * @param {string} [o.err]       строка ошибки под карточкой
 * @param {string} [o.hint]      тихая подсказка под карточкой
 * @param {string} [o.below]     готовая разметка под строкой (слайдер, поле)
 * @param {string} [o.accent]    подпись акцентным цветом
 */
export function card({
  label = "",
  labelSub = "",
  chip = "",
  minorValue = "",
  minorNote = "",
  major = "",
  majorUnit = "",
  bad = false,
  err = "",
  hint = "",
  below = "",
  accent = false,
  cls = "",
  attrs = {},
} = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== false && v != null)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");
  const labelHtml = label
    ? `<span class="modal__card-label${accent ? " modal__card-label--accent" : ""}">${esc(label)}` +
      (labelSub ? ` <i>${esc(labelSub)}</i>` : "") +
      `</span>`
    : "";
  const head =
    labelHtml && chip
      ? `<div class="modal__card-head">${labelHtml}<span class="tt-chip">${esc(chip)}</span></div>`
      : labelHtml
        ? `<div class="modal__card-head">${labelHtml}</div>`
        : "";
  const row =
    minorValue || minorNote || major
      ? `<div class="modal__card-row">
           <div class="modal__card-minor">${minorValue ? `<b>${esc(minorValue)}</b>` : ""}${
             minorNote ? `<span>${esc(minorNote)}</span>` : ""
           }</div>
           <div class="modal__card-major${bad ? " is-bad" : ""}">${esc(major)}${
             majorUnit ? `<i>${esc(majorUnit)}</i>` : ""
           }</div>
         </div>`
      : "";
  return (
    `<div class="modal__card${cls ? " " + cls : ""}"${extra}>` +
    head +
    row +
    (err ? `<div class="modal__card-err">${esc(err)}</div>` : "") +
    below +
    (hint ? `<div class="modal__card-hint">${esc(hint)}</div>` : "") +
    `</div>`
  );
}

/**
 * Плитка с числом: подпись, значение, необязательная подстрочная строка.
 *
 * Таких плиток в дашборде было ДВЕ породы — `.grid-item` (дашборд,
 * статистика, карточка позиции) и `.stat-card` (ledger, со своим фоном,
 * радиусом и капслоком). Разница ничего не значила, но бросалась в глаза при
 * переходе между страницами. Осталась одна.
 *
 * tone: "" | "positive" | "negative" | "highlight" — красит ЗНАЧЕНИЕ, не всю
 * плитку: цветной блок целиком читается как статус, а тут цвет говорит лишь
 * про знак числа.
 */
export function stat({
  label = "",
  value = "",
  sub = "",
  tone = "",
  primary = false,
  id = "",
  cls = "",
  attrs = {},
} = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== false && v != null)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");
  return (
    `<div class="grid-item${primary ? " grid-item-primary" : ""}${cls ? " " + cls : ""}"${extra}>` +
    `<div class="item-label">${esc(label)}</div>` +
    `<div class="item-value${tone ? " " + esc(tone) : ""}"${id ? ` id="${esc(id)}"` : ""}>${esc(value)}</div>` +
    (sub ? `<div class="item-sub">${esc(sub)}</div>` : "") +
    `</div>`
  );
}
