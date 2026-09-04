// ─────────────────────────────────────────────────────────────────────
//  Иконки интерфейса — Lucide, поимённо.
//
//  До 04.09.2026 иконок как системы не было: смысл несли типографские глифы
//  (▲ ▼ ▸ ▾ ✓ ⚠ × ‹ ›) и эмодзи (🤖 🖐 🎯 ⛔), разбросанные по двадцати пяти
//  местам. Три беды: каждый шрифт рисует их по-своему (эмодзи вообще цветным
//  растром, мимо темы), вес не совпадает с текстом, а «стрелка вверх» в одном
//  месте ▲, в другом ↑ и в третьем ▴.
//
//  🚨 Импорт ТОЛЬКО поимённый. `import * as lucide` тащит в бандл весь набор
//  (сотни килобайт) ради полутора десятков контуров.
//
//  Ключи в MAP — по СМЫСЛУ, не по названию картинки: если «лонг» однажды
//  перестанет быть стрелкой, правится одна строка здесь, а не сорок вызовов.
//
//  Соседний icons.js — про другое: там контуры, которые МОРФЯТСЯ по состоянию
//  (навигация, тема, колокольчик). Их ведёт собственный движок, и Lucide их
//  не заменяет.
// ─────────────────────────────────────────────────────────────────────

import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Ban,
  Bot,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleHelp,
  Clock,
  Copy,
  createElement,
  ExternalLink,
  Eye,
  Hand,
  History,
  Info,
  Minus,
  Mail,
  Pause,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Ruler,
  Search,
  Settings,
  Shield,
  Snowflake,
  Target,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  X,
  Zap,
} from "lucide";

const MAP = {
  // Направление сделки. Стрелка, а не треугольник: у ▲/▼ нет оптической оси,
  // и в строке рядом с цифрами они висят выше базовой линии.
  long: ArrowUp,
  short: ArrowDown,
  // Движение цены как процесс (ускоряется / выдыхается) — это уже не сторона
  // сделки, поэтому и картинка другая.
  rising: TrendingUp,
  falling: TrendingDown,
  flat: Minus,

  // Раскрытие. collapsed/expanded — состояния ОДНОГО слота, поэтому пара.
  collapsed: ChevronRight,
  expanded: ChevronDown,
  sortDesc: ChevronDown,
  sortAsc: ChevronUp,
  prev: ChevronLeft,
  next: ChevronRight,

  // Переключение одного на другое (тип ордера: маркет ⇄ лимитка). Именно
  // «поменять местами», а не «пересчитать» (recompute) — это разные жесты.
  swap: ArrowLeftRight,
  close: X,
  check: Check,
  add: Plus,
  copy: Copy,
  search: Search,
  refresh: RefreshCw,
  recompute: RotateCcw,
  external: ExternalLink,
  eye: Eye,
  clock: Clock,
  calendar: Calendar,
  pause: Pause,
  play: Play,

  info: Info,
  help: CircleHelp,
  warn: TriangleAlert,
  danger: CircleAlert,
  blocked: Ban,
  target: Target,
  // «Рынок холодный» — режимный гейт what-if, не оценка сделки.
  cold: Snowflake,

  bot: Bot,
  manual: Hand,

  // Открытая позиция в списке: булавка на месте порядкового номера — «эта
  // строка закреплена наверху, потому что она твоя».
  pinned: Pin,
  // Проверка стопа на вменяемость (не съест ли его обычный шум).
  shield: Shield,
  // Расчёт размера позиции от риска.
  ruler: Ruler,
  // Что под капотом: OI, объём, фандинг.
  flow: Settings,
  // Твоя собственная история по монете — зеркало привычки.
  history: History,
  // Совпало с проверенным эджем — бонус, а не основание.
  spark: Zap,
  mail: Mail,
};

/**
 * Разметка одной иконки. Возвращает строку — чтобы вставать в те же шаблонные
 * литералы, где раньше стоял глиф, без переписывания рендера на DOM-узлы.
 *
 * 🚨 РЕЗУЛЬТАТ — РАЗМЕТКА, а не текст. Он может уходить ТОЛЬКО в innerHTML
 * (напрямую или через шаблонную строку, которая туда попадёт). Присвоение в
 * `textContent` печатает пользователю сырой `<svg xmlns=…>` — так 04.09.2026
 * сломались подстрочник P&L Summary и «7D TREND» в журнале. Проверяй сток,
 * когда добавляешь icon() в существующую строку: раньше там мог лежать глиф,
 * которому textContent был не страшен.
 *
 * Размер и цвет НЕ задаются здесь: `width/height: 1em` + `currentColor` в CSS
 * (.icon) означают, что иконка сама подстраивается под кегль и цвет строки,
 * в которой стоит. Ровно поэтому у неё нет пропа `size`.
 */
export function icon(name, { cls = "", label = "" } = {}) {
  const Ico = MAP[name];
  if (!Ico) return "";
  const el = createElement(Ico);
  el.setAttribute("class", `icon${cls ? " " + cls : ""}`);
  // Иконка рядом с текстом — украшение: скринридер прочитает сам текст.
  // Иконка вместо текста обязана назваться, иначе кнопка немая.
  if (label) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
  } else {
    el.setAttribute("aria-hidden", "true");
  }
  return el.outerHTML;
}

/**
 * Заменяет `<i data-icon="close">` на настоящий svg. Для статической разметки
 * в .html, где шаблонной строки нет и звать icon() неоткуда.
 *
 * Идемпотентна: помеченные узлы уходят из выборки вместе с data-icon, поэтому
 * повторный вызов после ре-рендера ничего не удваивает.
 */
export function paintIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((slot) => {
    const html = icon(slot.dataset.icon, {
      cls: slot.className,
      label: slot.dataset.iconLabel || "",
    });
    if (!html) return;
    slot.outerHTML = html;
  });
}
