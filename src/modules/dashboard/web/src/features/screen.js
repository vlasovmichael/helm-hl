// ─────────────────────────────────────────────────
//  Screen — торгуемые монеты + бюджет дня
// ─────────────────────────────────────────────────
// Заменяет Hot Movers в роли «куда смотреть». Hot Movers показывал, кто скачет,
// по всей бирже; Screen показывает монеты, ОТОБРАННЫЕ ПО ЦЕНЕ ВХОДА, и рядом —
// сколько сделок уже сделано за день.
//
// 🔒 ЗДЕСЬ НЕТ ПРЕДСКАЗАНИЙ (решено 23.08.2026, не размывать):
// ни скоринга, ни «setup», ни стрелок «покупай», ни подсветки «сигнал». Всё,
// что мы пробовали в этом жанре, померено и эджа не дало. Карточка говорит три
// вещи, и все три — факты: что произошло с ценой, сколько стоит вход и как ты
// сам торговал эту монету раньше. Выбор монеты остаётся дискреционным.
//
// Серверная часть и обоснование порога — routes/screen.js.

const fmtPct = (v, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%";

const pctCls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");

function fmtPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return "—";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return "$" + p.toFixed(3);
  return "$" + Number(p.toPrecision(4));
}

function fmtVol(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(0) + "M";
  return "$" + (n / 1e3).toFixed(0) + "K";
}

/** reason/message с сервера уезжает в innerHTML — экранируем. */
function escapeText(t) {
  return t.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const fmtSignedUsd = (n) =>
  !Number.isFinite(n) ? "—" : (n >= 0 ? "+$" : "−$") + Math.abs(n).toFixed(2);

/**
 * Класс ячейки трения. Пороги не вкусовые: 15% бюджета риска — это уже та
 * величина, при которой правота должна быть систематической, чтобы окупиться.
 */
export function frictionClass(pctOfRisk) {
  if (pctOfRisk == null || !Number.isFinite(pctOfRisk)) return "";
  if (pctOfRisk <= 8) return "scr-fr--ok";
  if (pctOfRisk <= 15) return "scr-fr--mid";
  return "scr-fr--bad";
}

// ── Сортировка ─────────────────────────────────────────────────────────────
// Дефолт — по величине движения: список уже отобран по цене входа, и внутри
// него интересно, что шевелится. Клик по заголовку переключает поле, повторный
// клик — направление.
const SORT_KEYS = {
  coin:     (c) => c.coin,
  price:    (c) => c.price,
  // ВАЖНО: ранжируем ТОЛЬКО по короткому окну. Подставлять сюда 24ч, когда
  // короткого нет, нельзя: монета с +25% за сутки встала бы выше монеты с +3%
  // за 15 минут, и колонка «Move» врала бы порядком. Нет данных → в конец.
  move:     (c) => {
    const m = c.chg15mPct ?? c.chg1hPct;
    return m == null ? -Infinity : Math.abs(m);
  },
  chg24h:   (c) => c.chg24hPct ?? 0,
  friction: (c) => c.frictionPctOfRisk ?? null,
  volume:   (c) => c.volume24hUsd ?? 0,
  mine:     (c) => (c.mine ? c.mine.pnl : 0),
};

let sortKey = "move";
let sortDir = "desc";
let lastData = null;

export function sortCoins(coins, key = sortKey, dir = sortDir) {
  const pick = SORT_KEYS[key] || SORT_KEYS.move;
  const sign = dir === "asc" ? 1 : -1;
  return [...coins].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (typeof x === "string" || typeof y === "string") {
      return String(x).localeCompare(String(y)) * sign;
    }
    // Пустые значения не участвуют в гонке: они всегда внизу, в обе стороны.
    const xEmpty = !Number.isFinite(x);
    const yEmpty = !Number.isFinite(y);
    if (xEmpty && yEmpty) return 0;
    if (xEmpty) return 1;
    if (yEmpty) return -1;
    return (x - y) * sign;
  });
}

/** Бюджет дня: сколько сделок сделано и сколько осталось до дневного стопа. */
function renderBudget(b) {
  const el = document.getElementById("screen-budget");
  if (!el || !b) return;

  const n = b.tradesToday ?? 0;
  const cap = b.tradesCap ?? 5;
  const over = n > cap;
  // Точки-счётчик: видно с одного взгляда, без чтения цифр.
  const dots = Array.from({ length: Math.max(cap, n) }, (_, i) =>
    `<i class="scr-dot ${i < n ? (i >= cap ? "is-over" : "is-on") : ""}"></i>`,
  ).join("");

  const left = b.remainingUsd;
  const leftTxt = left == null ? "—" : "$" + left.toFixed(2);

  el.innerHTML =
    `<div class="scr-budget__row">` +
      `<span class="scr-budget__label">Trades today</span>` +
      `<span class="scr-budget__dots">${dots}</span>` +
      `<b class="${over ? "is-over" : ""}">${n} / ${cap}</b>` +
    `</div>` +
    `<div class="scr-budget__row">` +
      `<span class="scr-budget__label">Left before daily stop</span>` +
      `<b class="${b.halted ? "is-over" : ""}">${b.halted ? "stop hit" : leftTxt}</b>` +
    `</div>` +
    (b.known === false
      ? `<div class="scr-budget__note">daily counter hasn't run — the limit isn't holding right now</div>`
      : "") +
    (over
      ? `<div class="scr-budget__note is-over">over the daily trade budget</div>`
      : "");
}

/** Колонка «Mine»: твой послужной список по монете. */
function mineCell(mine) {
  if (!mine || !mine.n) return `<td class="r scr-mine scr-mine--none">—</td>`;
  const bad = mine.pnl < 0;
  return (
    `<td class="r scr-mine ${bad ? "is-bad" : "is-good"}"` +
      ` title="You traded ${mine.coinLabel || "this coin"} ${mine.n}× — net ${fmtSignedUsd(mine.pnl)}, winrate ${
        mine.wr == null ? "—" : Math.round(mine.wr) + "%"
      }">` +
      `${fmtSignedUsd(mine.pnl)}` +
      `<i class="scr-win">${mine.n}× · ${mine.wr == null ? "—" : Math.round(mine.wr) + "%"}</i>` +
    `</td>`
  );
}

function renderRows() {
  const tbody = document.getElementById("screen-tbody");
  if (!tbody || !lastData?.coins) return;

  const rows = sortCoins(lastData.coins).slice(0, 12);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No coin passed the threshold</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((c) => {
      const short = c.chg15mPct ?? c.chg1hPct;
      const shortLabel = c.chg15mPct != null ? "15m" : c.chg1hPct != null ? "1h" : "";
      const fr = c.frictionPctOfRisk;
      return (
        // Строка кликабельна: открывает Trade Ticket на этой монете. Именно
        // тикет, а не вход — размер и сторону оператор выбирает сам, а нянька
        // потом повесит стоп (см. границу ответственности в tradeTicket.js).
        `<tr class="scr-row" data-coin="${c.coin}" tabindex="0" role="button"` +
          ` title="Open trade ticket for ${c.coin}">` +
          `<td class="scr-coin">${c.coin}</td>` +
          `<td class="r">${fmtPrice(c.price)}</td>` +
          `<td class="r ${pctCls(short)}">${fmtPct(short, 2)}` +
            (shortLabel ? `<i class="scr-win">${shortLabel}</i>` : "") +
          `</td>` +
          `<td class="r ${pctCls(c.chg24hPct)}">${fmtPct(c.chg24hPct, 1)}</td>` +
          `<td class="r scr-fr ${frictionClass(fr)}">${
            fr == null ? "—" : Math.round(fr) + "%"
          }<i class="scr-win">${c.spreadBp == null ? "" : c.spreadBp.toFixed(1) + " bp"}</i></td>` +
          mineCell(c.mine ? { ...c.mine, coinLabel: c.coin } : null) +
          `<td class="r scr-vol">${fmtVol(c.volume24hUsd)}</td>` +
        `</tr>`
      );
    })
    .join("");
  tbody.dataset.filled = "1";
  paintSortIndicators();
}

function paintSortIndicators() {
  document.querySelectorAll("#sec-screen th[data-sort]").forEach((th) => {
    const on = th.dataset.sort === sortKey;
    th.classList.toggle("is-sorted", on);
    th.dataset.dir = on ? sortDir : "";
  });
}

/**
 * Рендер экрана. Пустой/битый ответ не стирает предыдущий — карточка не должна
 * мигать «нет данных» на каждом сетевом чихе.
 */
export function renderScreen(data) {
  const tbody = document.getElementById("screen-tbody");
  const meta = document.getElementById("screen-meta");
  if (!tbody) return;

  if (data?.budget) renderBudget(data.budget);

  if (!data?.ok || !Array.isArray(data.coins)) {
    // Уже показывали список — оставляем его. Данные о ликвидности живут 120с и
    // устаревают медленно, поэтому старый экран честнее пустого: мигать
    // «недоступно» на каждом сетевом чихе хуже, чем показать чуть несвежее.
    if (tbody.dataset.filled) return;
    // Первая загрузка не удалась — говорим ПОЧЕМУ и что это не тупик: следующий
    // тик попробует снова. Сырое сообщение исключения («Unexpected end of JSON
    // input») пользователю ничего не объясняет, поэтому наружу идёт причина, а
    // техническая деталь — только когда её прислал сервер.
    const why =
      data?.reason === "dashboard unreachable"
        ? "dashboard is not answering"
        : data?.reason === "build-failed"
          ? `exchange call failed (${data.message || "no detail"})`
          : "no answer yet";
    tbody.innerHTML =
      `<tr><td colspan="7" class="empty-state">` +
        `Screen is still loading — ${escapeText(String(why))}. Retrying…` +
      `</td></tr>`;
    return;
  }

  lastData = data;
  if (meta) {
    const risk = data.riskUsd;
    meta.textContent =
      `${data.passed} of ${data.considered} · friction < ${data.thresholdBp} bp` +
      (risk ? ` · risk $${risk.toFixed(2)}` : "");
  }
  renderRows();
}

/**
 * Интерактив таблицы: сортировка по клику на заголовок и открытие тикета по
 * клику на строку. Делегирование — строки перерисовываются каждый тик.
 */
export function initScreenInteractions(openTicket) {
  const sec = document.getElementById("sec-screen");
  if (!sec) return;

  sec.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "desc" ? "asc" : "desc";
      } else {
        sortKey = key;
        // Тикер логичнее читать от A, числа — от большего.
        sortDir = key === "coin" ? "asc" : "desc";
      }
      renderRows();
    });
  });

  const openFor = (el) => {
    const row = el.closest?.(".scr-row");
    if (row?.dataset.coin && typeof openTicket === "function") openTicket(row.dataset.coin);
  };
  sec.addEventListener("click", (e) => openFor(e.target));
  sec.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.target.classList?.contains("scr-row")) {
        e.preventDefault();
        openFor(e.target);
      }
    }
  });

  paintSortIndicators();
}

// ── Сворачивание Hot Movers ────────────────────────────────────────────────
// Карточка остаётся в проекте целиком: оператору нужны её Paper и What-if, а сама
// таблица — та самая техника «двадцать входов», от которой уходим. Поэтому
// прячем, а не удаляем, и по умолчанию скрыта. Пока скрыта — фронт не ходит в
// /api/signals и не рендерит строки (WS-кадр всё равно приходит, но его
// hotMovers просто игнорируется).
const HM_KEY = "hl-scanner-hotmovers-open";

export function hotMoversVisible() {
  try {
    return localStorage.getItem(HM_KEY) === "1";
  } catch {
    return false;
  }
}

export function initHotMoversToggle() {
  const btn = document.getElementById("hm-toggle");
  const sec = document.getElementById("sec-movers");
  if (!btn || !sec) return;

  const apply = (on) => {
    sec.classList.toggle("is-collapsed", !on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    btn.querySelector(".hm-toggle__label").textContent = on
      ? "Hide Hot Movers table"
      : "Show Hot Movers table";
    // Кнопки Paper и What-if живут в шапке Hot Movers и нужны оператору всегда —
    // при сворачивании они переезжают в шапку экрана, а не исчезают.
    const host = document.getElementById(on ? "hm-actions-slot" : "screen-actions-slot");
    const tools = document.getElementById("hm-tools");
    if (host && tools && tools.parentElement !== host) host.appendChild(tools);
  };

  apply(hotMoversVisible());
  btn.addEventListener("click", () => {
    const on = !(btn.getAttribute("aria-expanded") === "true");
    try {
      localStorage.setItem(HM_KEY, on ? "1" : "0");
    } catch {
      /* приватное окно — переключатель работает до перезагрузки */
    }
    apply(on);
  });
}
