// Аккордеоны радара: состояние открыт/закрыт переживает перезагрузку, а на
// свёрнутой шапке видно, сколько строк внутри и первая монета.

const STORE_KEY = "hl-radar-acc";
// Бейдж считает строки уже отрисованной таблицы, поэтому обновляется по времени,
// а не по событию: ленты перерисовываются своими тиками.
const BADGE_REFRESH_MS = 3000;

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function updateBadge(acc) {
  const badge = acc.querySelector(":scope > summary .radar-badge");
  if (!badge) return;
  let rows = 0;
  let first = "";
  for (const row of acc.querySelectorAll("tbody tr")) {
    if (row.querySelector(".empty-state")) continue;
    rows++;
    if (!first) first = row.querySelector("td:nth-child(2)")?.textContent.trim() || "";
  }
  badge.textContent = rows ? `${first ? `${first} · ` : ""}${rows}` : "";
}

/**
 * @returns {() => void} остановка: гасит таймер бейджей.
 */
export function initRadarAccordions() {
  const accs = Array.from(document.querySelectorAll("details.radar-acc"));
  if (accs.length === 0) return () => {};

  const state = readState();

  for (const acc of accs) {
    const id = acc.dataset.acc || acc.id;
    // По умолчанию свёрнуто; разворачиваем только сохранённое.
    if (state[id] === true) acc.setAttribute("open", "");
    else acc.removeAttribute("open");

    acc.addEventListener("toggle", () => {
      state[id] = acc.open;
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
      } catch {
        /* приватный режим — состояние просто не переживёт перезагрузку */
      }
      if (!acc.open) updateBadge(acc);
    });

    // Клик по «?» в шапке не должен сворачивать аккордеон.
    acc.querySelector("summary .help-btn")?.addEventListener("click", (e) => e.stopPropagation());
  }

  const refresh = () => {
    for (const acc of accs) if (!acc.open) updateBadge(acc);
  };
  const timer = setInterval(refresh, BADGE_REFRESH_MS);
  refresh();

  return () => clearInterval(timer);
}
