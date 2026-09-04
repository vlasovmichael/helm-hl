// ─────────────────────────────────────────────────────────────────────
//  Компоненты интерфейса — сборка разметки. Форму и цвет держит CSS
//  (`core/_controls.scss`). API пропов снят с shadcn/ui (variant/size);
//  сам пакет не поставить: он React + Tailwind + Radix, а тут ваниль.
//
//  🚨 Возвращается РАЗМЕТКА, а не узел — только в innerHTML. Подписи и
//  атрибуты экранируются здесь.
//
//  Роли кнопки: primary — главное действие, ОДНО на экран; danger —
//  необратимое; ghost — второстепенное; long/short — сторона сделки;
//  без модификатора — всё остальное. Новых не заводить.
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
 * Сегментный выбор: 2–5 видимых опций, один клик. Не набор кнопок — ряд
 * кнопок читается как ряд действий, а это выбор.
 * options: [{ value, label, icon, tone }], tone красит выбранный сегмент.
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
 * Поле ввода. `ticker` — моно + капслок (поле монеты, одно на все диалоги).
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

/** Бейдж — метка состояния рядом с текстом (LONG / PAPER / BOT). Не кнопка. */
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
 * Слайдер. Заливку до бегунка несёт --fill: одинаково покрасить пройденную
 * часть <input type=range> в webkit и gecko иначе нельзя.
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
 * крупное число, под ними слайдер/поле/ошибка. Из таких собран «Open
 * Position», из них же — ручной папер.
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
 * Плитка с числом: подпись, значение, необязательный подстрочник.
 * tone ("positive"|"negative"|"highlight") красит ЗНАЧЕНИЕ, не всю плитку:
 * цветной блок целиком читался бы как статус, а тут цвет — знак числа.
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
