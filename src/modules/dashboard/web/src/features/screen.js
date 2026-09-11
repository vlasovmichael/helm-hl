// ─────────────────────────────────────────────────
//  Screen — торгуемые монеты + бюджет дня
// ─────────────────────────────────────────────────
// Заменяет Hot Movers в роли «куда смотреть». Hot Movers показывал, кто скачет,
// по всей бирже; Screen показывает монеты, ОТОБРАННЫЕ ПО ЦЕНЕ ВХОДА, и рядом —
// сколько сделок уже сделано за день.
//
// 🔒 ЗДЕСЬ НЕТ ПРЕДСКАЗАНИЙ, не размывать:
// ни скоринга, ни «setup», ни стрелок «покупай», ни подсветки «сигнал». Всё,
// что мы пробовали в этом жанре, померено и эджа не дало. Карточка говорит три
// вещи, и все три — факты: что произошло с ценой, сколько стоит вход и как ты
// сам торговал эту монету раньше. Выбор монеты остаётся дискреционным.
//
// Серверная часть и обоснование порога — routes/screen.js.

import { settle, emptyRow } from "../core/placeholders.js";
import { icon } from "../core/icon.js";

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

// Окупаемость: ниже 2× круг съедает половину типичного хода — там попытка
// платит больше, чем приносит средний размах.
function payoffClass(p) {
  if (p == null) return "";
  if (p >= 6) return "scr-fr--ok";
  if (p >= 3) return "scr-fr--mid";
  return "scr-fr--bad";
}

// ── Сортировка ─────────────────────────────────────────────────────────────
// Дефолт — по окупаемости попытки (размах часа / круг издержек), а НЕ по
// величине движения. 🚨 Сортировка по |рывку| ставит наверх ровно тот отбор,
// который измерен и хуже случайного (34.6% против 41.1%): глаз берёт первые
// строки, и порядок списка становится решением за оператора.
// Клик по заголовку переключает поле, повторный клик — направление.
const SORT_KEYS = {
  coin:     (c) => c.coin,
  price:    (c) => c.price,
  // Во сколько раз размах последнего часа покрывает круг. Обе части измеримы,
  // в отличие от направления.
  payoff:   (c) => c.payoff ?? null,
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

let sortKey = "payoff";
let sortDir = "desc";
let lastData = null;
// Фильтр по тикеру. Живёт в модуле, а не в DOM: рендер идёт на каждом
// поллинге и обязан пережить перерисовку, не теряя набранное.
let screenQuery = "";

export function sortCoins(coins, key = sortKey, dir = sortDir) {
  const pick = SORT_KEYS[key] || SORT_KEYS.payoff;
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
    `<i class="scr-dot ${i < n ? (i >= cap ?"is-over" : "is-on") : ""}"></i>`,
  ).join("");

  const left = b.remainingUsd;
  const leftTxt = left == null ? "—" : "$" + left.toFixed(2);

  el.innerHTML =
    `<div class="scr-budget__row">` +
      `<span class="scr-budget__label">Trades today</span>` +
      `<span class="scr-budget__dots">${dots}</span>` +
      `<b class="${over ?"is-over" : ""}">${n} / ${cap}</b>` +
    `</div>` +
    `<div class="scr-budget__row">` +
      `<span class="scr-budget__label">Left before daily stop</span>` +
      `<b class="${b.halted ?"is-over" : ""}">${b.halted ? "stop hit" : leftTxt}</b>` +
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
  if (!mine || !mine.n) return `<td class="num scr-mine scr-mine--none">—</td>`;
  const bad = mine.pnl < 0;
  return (
    `<td class="num scr-mine ${bad ?"is-bad" : "is-good"}"` +
      ` data-card="You traded ${mine.coinLabel || "this coin"} ${mine.n}× — net ${fmtSignedUsd(mine.pnl)}, winrate ${
        mine.wr == null ? "—" : Math.round(mine.wr) + "%"
      }">` +
      `${fmtSignedUsd(mine.pnl)}` +
      `<i class="scr-win">${mine.n}× · ${mine.wr == null ? "—" : Math.round(mine.wr) + "%"}</i>` +
    `</td>`
  );
}


/**
 * Расстановка: две полосы — крупные счета по объёму позиций и вся розница по
 * числу счетов. Полосы, а не числа: разрыв между ними читается взглядом, а
 * именно он тут единственное содержание. Данные — Binance, по той же монете.
 */
function posCell(pos) {
  if (!pos || (pos.topLongPct == null && pos.retailLongPct == null)) {
    return `<td class="scr-ls scr-ls--none">—</td>`;
  }
  const bar = (v, cls) =>
    v == null
      ? `<div class="scr-lsbar ${cls} is-empty"><em>—</em><i></i></div>`
      : `<div class="scr-lsbar ${cls}"><em>${Math.round(v)}</em>` +
        `<i><span style="--w:${v.toFixed(1)}%"></span></i></div>`;
  // ⇄ ставим только на заметном разрыве: мелкая разница — это шум выборки,
  // а не расхождение крупных с розницей.
  const gap =
    pos.topLongPct != null && pos.retailLongPct != null
      ? Math.abs(pos.topLongPct - pos.retailLongPct)
      : 0;
  return (
    `<td class="scr-ls" data-card="Top: large accounts by position size. Bottom: all accounts by count. Source: Binance">` +
      bar(pos.topLongPct, "is-top") +
      bar(pos.retailLongPct, "is-retail") +
      (gap >= 12 ? `<b class="scr-div">${icon("swap")}</b>` : "") +
    `</td>`
  );
}

/** OI в долларах и куда он двинулся за час. */
function oiCell(c) {
  if (c.oiUsd == null) return `<td class="num scr-oi">—</td>`;
  const d = c.pos?.oiChg1hPct;
  return (
    `<td class="num scr-oi">${fmtVol(c.oiUsd)}` +
      (d == null ? "" : `<i class="scr-win ${pctCls(d)}">${fmtPct(d, 1)} 1h</i>`) +
    `</td>`
  );
}

/**
 * Профиль суток: 24 столбика, средний размах бара по часу UTC за неделю.
 * Текущий час подсвечен — это и есть ответ на «сейчас вообще время входить».
 */
function hoursCell(hours) {
  if (!Array.isArray(hours) || hours.length !== 24) {
    return `<td class="scr-hrs scr-hrs--none">—</td>`;
  }
  const mx = Math.max(...hours) || 1;
  const now = new Date().getUTCHours();
  const bars = hours
    .map((v, h) => {
      const pct = Math.max(8, Math.round((v / mx) * 100));
      return (
        `<i style="--h:${pct}%;--bi:${h}"${h === now ? ' class="is-now"' : ""}` +
        ` data-tip="${h}:00 UTC · ${v.toFixed(2)}%"></i>`
      );
    })
    .join("");
  return `<td class="scr-hrs"><div class="scr-spark">${bars}</div></td>`;
}

function renderRows() {
  const tbody = document.getElementById("screen-tbody");
  if (!tbody || !lastData?.coins) return;

  // Поиск сужает ДО отсечки в 12 строк: иначе искомая монета найдётся только
  // если она уже попала в верхнюю дюжину, а это ровно наоборот тому, зачем
  // поиск нужен.
  const q = screenQuery.trim().toLowerCase();
  const pool = q
    ? lastData.coins.filter((c) => String(c.coin).toLowerCase().includes(q))
    : lastData.coins;
  const rows = sortCoins(pool).slice(0, 12);
  if (!rows.length) {
    tbody.innerHTML = q
      ? emptyRow(11, { glyph: "search", title: `Nothing matches «${q}»` })
      : emptyRow(11, {
          glyph: "search",
          title: "No coin passed the threshold",
          hint: "Raise SCREEN_MAX_FRICTION_BP if the whole board is too expensive to trade today.",
        });
    return;
  }

  // settle(), а не innerHTML: вход проиграется ровно один раз — на первой
  // подстановке поверх скелетона, и не будет играть на каждом поллинге.
  settle(
    tbody,
    rows
    .map((c) => {
      const short = c.chg15mPct ?? c.chg1hPct;
      const shortLabel = c.chg15mPct != null ? "15m" : c.chg1hPct != null ? "1h" : "";
      const fr = c.frictionPctOfRisk;
      return (
        // Строка кликабельна: открывает Trade Ticket на этой монете. Именно
        // тикет, а не вход — размер и сторону оператор выбирает сам, а нянька
        // потом повесит стоп (см. границу ответственности в tradeTicket.js).
        `<tr class="scr-row" data-coin="${c.coin}" tabindex="0" role="button"` +
          ` data-card="Open trade ticket for ${c.coin}">` +
          `<td class="scr-coin">${c.coin}</td>` +
          `<td class="num scr-payoff ${payoffClass(c.payoff)}">${
            c.payoff == null ? "—" : c.payoff.toFixed(1) + "×"
          }</td>` +
          `<td class="num">${fmtPrice(c.price)}</td>` +
          `<td class="num ${pctCls(short)}">${fmtPct(short, 2)}` +
            (shortLabel ? `<i class="scr-win">${shortLabel}</i>` : "") +
          `</td>` +
          `<td class="num ${pctCls(c.chg24hPct)}">${fmtPct(c.chg24hPct, 1)}</td>` +
          `<td class="num scr-fr ${frictionClass(fr)}">${
            fr == null ? "—" : Math.round(fr) + "%"
          }<i class="scr-win">${c.spreadBp == null ? "" : c.spreadBp.toFixed(1) + " bp"}</i></td>` +
          `<td class="num scr-mk">${
            c.makerFrictionBp == null ? "—" : c.makerFrictionBp.toFixed(1)
          }<i class="scr-win">limit</i></td>` +
          oiCell(c) +
          posCell(c.pos) +
          `<td class="num scr-fund ${pctCls(c.fundingPct)}">${
            c.fundingPct == null ? "—" : c.fundingPct.toFixed(4) + "%"
          }</td>` +
          hoursCell(c.hours) +
          mineCell(c.mine ? { ...c.mine, coinLabel: c.coin } : null) +
          `<td class="num scr-vol">${fmtVol(c.volume24hUsd)}</td>` +
        `</tr>`
      );
    })
      .join(""),
  );
  tbody.dataset.filled = "1";
  paintSortIndicators();
}

function paintSortIndicators() {
  document.querySelectorAll("#sec-screen th[data-sort]").forEach((th) => {
    const on = th.dataset.sort === sortKey;
    th.classList.add("sortable");
    th.classList.toggle("is-sorted", on);
    th.classList.toggle("is-asc", on && sortDir === "asc");
  });
}

/**
 * Рендер экрана. Пустой/битый ответ не стирает предыдущий — карточка не должна
 * мигать «нет данных» на каждом сетевом чихе.
 */
export function renderScreen(data) {
  const tbody = document.getElementById("screen-tbody");
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
    tbody.innerHTML = emptyRow(11, {
      glyph: "clock",
      title: "Screen is still loading",
      hint: `${escapeText(String(why))}. Retrying on the next tick.`,
    });
    return;
  }

  lastData = data;
  paintMeta();
  renderRows();
}

/**
 * Строка меты. Отдельно от renderScreen: её переписывает и поиск, показывая
 * «сколько из скольких» вместо порога — иначе непонятно, сузился список или
 * монета вправду не прошла по цене входа.
 */
function paintMeta() {
  const meta = document.getElementById("screen-meta");
  if (!meta || !lastData) return;
  const q = screenQuery.trim();
  if (q) {
    const hits = lastData.coins.filter((c) =>
      String(c.coin).toLowerCase().includes(q.toLowerCase()),
    ).length;
    meta.textContent = `${hits} of ${lastData.passed} match «${q}»`;
    return;
  }
  const risk = lastData.riskUsd;
  meta.textContent =
    `${lastData.passed} of ${lastData.considered} · friction < ${lastData.thresholdBp} bp` +
    (risk ? ` · risk $${risk.toFixed(2)}` : "");
}

/**
 * Интерактив таблицы: сортировка по клику на заголовок и открытие тикета по
 * клику на строку. Делегирование — строки перерисовываются каждый тик.
 */
export function initScreenInteractions(openTicket) {
  const sec = document.getElementById("sec-screen");
  if (!sec) return;

  const search = document.getElementById("screen-search");
  if (search) {
    const field = search.closest(".scr-search");
    const apply = () => {
      screenQuery = search.value;
      field?.classList.toggle("has-value", screenQuery.length > 0);
      renderRows();
      paintMeta();
    };
    search.addEventListener("input", apply);
    // Escape очищает, не снимая фокус: следующий запрос сразу можно набирать.
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        search.value = "";
        apply();
      }
      // Клик по строке открывает тикет, но клавиши поиска не должны
      // всплывать до обработчика секции.
      e.stopPropagation();
    });
    sec.querySelector("[data-screen-clear]")?.addEventListener("click", () => {
      search.value = "";
      apply();
      search.focus();
    });
  }

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
// Карточка стоит под Active Position и всегда открыта: тумблер, прятавший её
// целиком, переносил кнопки Paper/What-if между двумя шапками.
