// ─────────────────────────────────────────────────
//  Роутер витрины на History API.
//
//  Страница-модуль отдаёт { title, nav, render(outlet) }, где render рисует
//  разметку и возвращает функцию остановки. Остановка обязательна: таймеры,
//  сокеты и наблюдатели переживают уход со страницы и на возврате копятся —
//  второй тик, третий, лишний WS.
//
//  🚨 Перехватываем только зарегистрированные пути: остальные ссылки ведут на
//  страницы вне роутера и обязаны грузиться обычным переходом.
// ─────────────────────────────────────────────────

import { setTopnavActive } from "./topnav.js";

/** @type {Map<string, () => Promise<{ default: object }>>} */
const routes = new Map();
let outlet = null;
let stopCurrent = null;
let pending = null;
let painted = false;

export function route(path, load) {
  routes.set(path, load);
}

export function navigate(path) {
  if (path === location.pathname + location.search) return;
  history.pushState({}, "", path);
  render();
}

/** Ссылка, которую ведёт роутер: свой origin, обычный клик, известный путь. */
function routedLink(target) {
  const a = target?.closest?.("a[href]");
  if (!a || a.target === "_blank") return null;
  if (a.origin !== location.origin) return null;
  return routes.has(a.pathname) ? a : null;
}

function onClick(e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = routedLink(e.target);
  if (!a) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
}

// Модуль страницы качаем по наведению: к клику import() уже в кэше, и переход
// происходит без ожидания сети.
function onHover(e) {
  const a = routedLink(e.target);
  if (a) routes.get(a.pathname)();
}

export function start(node) {
  outlet = node;
  document.addEventListener("click", onClick);
  document.addEventListener("pointerover", onHover);
  window.addEventListener("popstate", () => render());
  render();
}

async function render() {
  const path = location.pathname;
  const load = routes.get(path);
  if (!load) {
    location.href = path;
    return;
  }

  const token = {};
  pending = token;
  const { default: page } = await load();
  if (pending !== token) return; // за время загрузки ушли на другой экран

  stopCurrent?.();
  stopCurrent = null;
  document.title = page.title;
  document.body.dataset.page = page.nav;
  setTopnavActive(page.nav);

  const paint = () => {
    outlet.replaceChildren();
    stopCurrent = page.render(outlet) ?? null;
    // Первая отрисовка — это обычная загрузка страницы, браузер уже наверху;
    // трогать прокрутку там значит ломать переход по ссылке с якорем.
    if (painted) window.scrollTo({ top: 0, behavior: "instant" });
    painted = true;
  };

  // Кроссфейд между экранами тем же приёмом, что у межстраничных переходов.
  if (document.startViewTransition) document.startViewTransition(paint);
  else paint();
}
