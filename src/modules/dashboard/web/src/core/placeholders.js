// ─────────────────────────────────────────────────────────────────────
//  Скелетоны и пустые состояния — одна разметка на весь дашборд.
//
//  Правило (см. styles/core/_loaders.scss): у блока с асинхронными данными
//  три состояния, и все три должны быть нарисованы — loading, empty, ready.
//  До 04.09.2026 первые два делались строкой текста вроде «Loading…» или
//  вовсе отсутствовали, и «ещё грузится» было не отличить от «пусто».
//
//  🚨 «Loading…» текстом — не состояние загрузки. Оно не показывает, сколько
//  приедет и какой формы, поэтому в момент подстановки данных макет прыгает.
// ─────────────────────────────────────────────────────────────────────

import { icon } from "./icon.js";

/**
 * Строки-скелетоны для <tbody>. Рисуются настоящими <tr>/<td>, а не одним
 * прямоугольником поверх таблицы: тогда ширины колонок уже посчитаны, и при
 * подстановке данных шапка не съезжает.
 */
export function skeletonRows(cols, rows = 5) {
  const cells = Array.from({ length: cols }, () => `<td><span class="sk"></span></td>`).join("");
  return Array.from({ length: rows }, () => `<tr class="sk-row">${cells}</tr>`).join("");
}

/** Скелетон абзаца: n строк, последняя короче — так блок читается текстом. */
export function skeletonText(lines = 3) {
  return `<div class="sk-text">${Array.from({ length: lines }, () => `<span class="sk sk-line"></span>`).join("")}</div>`;
}

/**
 * Пустое состояние. Не «нет данных», а: что пусто, почему и что делать.
 * `hint` — та самая вторая половина, без неё блок остаётся дырой с подписью.
 */
export function emptyState({ glyph = "info", title, hint = "" }) {
  return `
    <div class="empty">
      ${icon(glyph)}
      <div class="empty__title">${title}</div>
      ${hint ? `<div class="empty__hint">${hint}</div>` : ""}
    </div>`;
}

/** То же в строку таблицы: колонки уже есть, поэтому одна ячейка на всю ширину. */
export function emptyRow(cols, { glyph = "info", title, hint = "" }) {
  return `<tr><td colspan="${cols}">${emptyState({ glyph, title, hint })}</td></tr>`;
}
