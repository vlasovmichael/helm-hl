// Поле монеты с подсказками — один контрол на тикет, папер и разбор монеты.
// 🚨 Возвращается РАЗМЕТКА (как в core/ui.js), поведение вешает attach().
// Стили — `.combo*` и `.field--coin` в core/_controls.scss.

import { fetchJson } from "../net/api.js";

/**
 * Подсказки тикеров под вводом. Совпадение с НАЧАЛА строки идёт выше, чем
 * вхождение в середине: набирая «AC», человек ищет ACE, а не CASHCAT.
 */
export function suggestCoins(query, coins, limit = 8) {
  const q = String(query || "").trim().toUpperCase();
  const list = Array.isArray(coins) ? coins : [];
  if (!q) return list.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const c of list) {
    const u = String(c).toUpperCase();
    if (u === q) continue; // точное совпадение уже введено — подсказывать нечего
    if (u.startsWith(q)) starts.push(c);
    else if (u.includes(q)) contains.push(c);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Разметка поля монеты с выпадашкой. */
export function coinCombo({ id = "", value = "", placeholder = "ticker", cls = "", attrs = {} } = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== false && v != null)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");
  return (
    `<div class="combo">` +
    `<input class="field field--coin combo__input${cls ? " " + cls : ""}" type="text"` +
    (id ? ` id="${esc(id)}"` : "") +
    ` value="${esc(value)}" placeholder="${esc(placeholder)}"` +
    ` role="combobox" aria-expanded="false" aria-autocomplete="list"` +
    ` autocomplete="off" autocapitalize="characters" spellcheck="false"${extra}>` +
    `</div>`
  );
}

/** Тикеры — капсом и без мусора. */
export function cleanTicker(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9:_-]/g, "");
}

let universeCache = null;

/** Список тикеров биржи. Кэш на страницу: он меняется раз в несколько дней. */
export async function loadCoinUniverse() {
  if (universeCache) return universeCache;
  try {
    const data = await fetchJson("/api/ticket/context");
    // Кэшируем только непустой: иначе один неудачный запрос гасит подсказки.
    if (Array.isArray(data?.coins) && data.coins.length) universeCache = data.coins;
    return universeCache || [];
  } catch {
    return [];
  }
}

/**
 * Выпадашка, стрелки, Enter/Escape. Список перерисовывается точечно: полная
 * перерисовка сбрасывает фокус и каретку на каждом символе.
 * `state` ({open, idx}) передаёт тот, у кого поле переживает ре-рендер.
 */
export function attachCoinCombo(input, { getCoins, onPick, onInput, state } = {}) {
  if (!input) return;
  const box = input.parentElement;
  const st = state || { open: false, idx: 0 };
  const coins = () => (typeof getCoins === "function" ? getCoins() : []) || [];
  const OPT_ID = `${input.id || "combo"}-opt-`;

  const listHtml = () => {
    if (!st.open) return "";
    const items = suggestCoins(input.value, coins());
    if (!items.length) return "";
    // id на пунктах — для aria-activedescendant, иначе скринридер молчит о выборе.
    return `<ul class="combo__list" role="listbox">${items
      .map(
        (c, i) =>
          `<li class="combo__item${i === st.idx ? " is-on" : ""}" role="option"` +
          ` id="${OPT_ID}${i}" aria-selected="${i === st.idx}"` +
          ` data-pick="${esc(c)}">${esc(c)}</li>`,
      )
      .join("")}</ul>`;
  };

  const redraw = () => {
    box.querySelector(".combo__list")?.remove();
    box.insertAdjacentHTML("beforeend", listHtml());
    input.setAttribute("aria-expanded", st.open ? "true" : "false");
    const active = box.querySelector(".combo__item.is-on");
    if (active) input.setAttribute("aria-activedescendant", active.id);
    else input.removeAttribute("aria-activedescendant");
    box.querySelectorAll("[data-pick]").forEach((li) => {
      // mousedown, а не click: blur поля успел бы закрыть список раньше клика.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(li.dataset.pick);
      });
    });
  };

  const pick = (coin) => {
    st.open = false;
    st.idx = 0;
    input.value = coin;
    redraw();
    onPick?.(coin);
  };

  input.addEventListener("input", () => {
    const clean = cleanTicker(input.value);
    if (input.value !== clean) input.value = clean;
    st.open = true;
    st.idx = 0;
    redraw();
    onInput?.(clean);
  });
  input.addEventListener("focus", () => {
    st.open = true;
    st.idx = 0;
    redraw();
  });
  input.addEventListener("blur", () => {
    st.open = false;
    redraw();
  });
  input.addEventListener("keydown", (e) => {
    const items = suggestCoins(input.value, coins());
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      st.open = true;
      st.idx = (st.idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      redraw();
    } else if ((e.key === "Home" || e.key === "End") && st.open && items.length) {
      // При открытой выпадашке Home/End полезнее списку, чем каретке.
      e.preventDefault();
      st.idx = e.key === "Home" ? 0 : items.length - 1;
      redraw();
    } else if (e.key === "Enter" && st.open && items[st.idx]) {
      e.preventDefault();
      pick(items[st.idx]);
    } else if (e.key === "Escape" && st.open) {
      // Гасим список, но НЕ диалог — иначе Esc закрывал бы всё разом.
      e.stopPropagation();
      st.open = false;
      redraw();
    }
  });

  return { redraw, state: st };
}
