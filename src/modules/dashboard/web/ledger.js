import "./src/styles/ledger.scss";
// ─────────────────────────────────────────────────
//  ledger.html — месячный P&L-реестр.
//
//  Таблица месяцев (/api/ledger) переехала сюда из <script> внутри ledger.html
//  04.09.2026: 298 строк логики жили в разметке, не проходили ни eslint, ни
//  сборку, и не могли ничего импортировать — из-за этого твисти месяца остался
//  глифом ▸/▾, когда весь остальной дашборд перешёл на lucide.
//  Плюс отсюда: Tax Summary (tick), trade-модалка, bans-strip.
//  Тема: inline-IIFE гасит FOUC, bindTheme() вешает клики на topnav-свитчер.
// ─────────────────────────────────────────────────

import {
  REFRESH_MS,
  initWebSocket,
  markSuccess,
  startFooterTimer,
  bindTheme,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { stat } from "./src/core/ui.js";
import { fetchJson } from "./src/net/api.js";
import { initModals } from "./src/features/modals.js";
import { renderTax } from "./src/features/pnlInsights.js";
import { renderBans } from "./src/features/accountStatus.js";

// Твисти месяца: свёрнут / раскрыт. Разметка, а не символ — присваивать
// только через innerHTML.

const fmt = (n, sign = true) => {
  if (n == null || isNaN(n)) return "—";
  const s =
    (n < 0 ? "-" : sign && n > 0 ? "+" : "") +
    "$" +
    Math.abs(n).toFixed(2);
  return s;
};
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "dim");
// Цена круга в базисных пунктах от оборота: доллары не сравнимы между
// размерами позиции, bp — сравнимы. 4.32 bp = тейкер обеими ногами.
const bpNote = (bp) =>
  bp == null ? "" : `<span class="sub-meta">${bp.toFixed(1)} bp</span>`;
const monthLabel = (k) => {
  const [y, m] = k.split("-");
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return names[parseInt(m, 10) - 1] + " " + y;
};

/** cls() отдаёт pos/neg — общий компонент знает positive/negative. */
const TONE = { pos: "positive", neg: "negative" };

function renderSummary(t) {
  const cards = [
    {
      k: "Net P&L · all time",
      v: fmt(t.net),
      c: cls(t.net),
      sub: "after fees + funding",
    },
    {
      k: "Bot net",
      v: fmt(t.botNet),
      c: cls(t.botNet),
      sub: `${t.botCount} trades · ${t.botWinRate}% win`,
    },
    {
      k: "Adopted net",
      v: fmt(t.adoptedNet),
      c: cls(t.adoptedNet),
      sub: `${t.adoptedCount} trades · ${t.adoptedWinRate}% win`,
    },
    {
      k: "Manual net",
      v: fmt(t.manualNet),
      c: cls(t.manualNet),
      sub: `${t.manualCount} trades · ${t.manualWinRate}% win`,
    },
    {
      k: "Fees paid",
      v: fmt(-t.fees, false),
      c: "neg",
      sub: "total maker+taker",
    },
    {
      k: "Funding",
      v: fmt(t.funding),
      c: cls(t.funding),
      sub: "funding accrual",
    },
  ];
  // Плитка — общий компонент (core/ui.js). Своей породы карточек у ledger
  // больше нет: .stat-card отличалась от .grid-item только фоном и капслоком,
  // и это была разница без смысла.
  document.getElementById("summary").innerHTML = cards
    .map((c) => stat({ label: c.k, value: c.v, sub: c.sub, tone: TONE[c.c] || "" }))
    .join("");
}

function row(m) {
  const wr = (w, c) =>
    c
      ? `<span class="sub-meta">${w}/${c} · ${Math.round((100 * w) / c)}%</span>`
      : "";
  const has = (m.days || []).length > 0;
  return `
    <tr class="${m.isCurrent ? "current" : ""} ${has ? "expandable" : ""}"
        ${has ? `data-month="${m.month}" tabindex="0" role="button" aria-expanded="false"` : ""}>
      <td class="month">${monthLabel(m.month)}</td>
      <td class="grp-edge ${cls(m.botNet)}">${fmt(m.botNet)}${wr(m.botWins, m.botCount)}</td>
      <td class="col-opt dim">${m.botCount || "—"}</td>
      <td class="grp-edge ${cls(m.adoptedNet)}">${m.adoptedCount ? fmt(m.adoptedNet) : "—"}${wr(m.adoptedWins, m.adoptedCount)}</td>
      <td class="col-opt dim">${m.adoptedCount || "—"}</td>
      <td class="grp-edge ${cls(m.manualNet)}">${fmt(m.manualNet)}${wr(m.manualWins, m.manualCount)}</td>
      <td class="col-opt dim">${m.manualCount || "—"}</td>
      <td class="grp-edge neg">${m.botFees + m.adoptedFees + m.manualFees ? fmt(-(m.botFees + m.adoptedFees + m.manualFees), false) : "—"}${bpNote(m.feesBp)}</td>
      <td class="col-opt ${cls(m.funding)}">${m.funding ? fmt(m.funding) : "—"}</td>
      <td class="grp-edge net-cell ${cls(m.net)}">${fmt(m.net)}</td>
      <td class="${cls(m.cumulativeNet)}">${fmt(m.cumulativeNet)}</td>
    </tr>
    ${has
      ? `<tr class="daybreak" data-days="${m.month}">
           <td colspan="11"><div class="daybreak__wrap"><div class="daybreak__inner">${daysBlock(m)}</div></div></td>
         </tr>`
      : ""}`;
}

// ── Разворот месяца: календарь Пн–Вс + итог недели справа ──
const iso = (d) => d.toISOString().slice(0, 10);
const cellSum = (d) =>
  d ? d.botCount + d.adoptedCount + d.manualCount : 0;

function dayCell(date, m, byDate) {
  const inMonth = iso(date).slice(0, 7) === m.month;
  if (!inMonth) return '<td class="cal-cell out"></td>';
  const d = byDate.get(iso(date));
  const n = cellSum(d);
  if (!d || (!n && !d.funding)) {
    return `<td class="cal-cell empty"><span class="dnum">${date.getUTCDate()}</span></td>`;
  }
  return `
    <td class="cal-cell ${cls(d.net)}">
      <span class="dnum">${date.getUTCDate()}</span>
      <span class="dpnl">${fmt(d.net)}</span>
      <span class="dsub">${n ? `${n} ${n === 1 ? "trade" : "trades"}` : "funding"}${
        d.feesBp != null ? ` · ${d.feesBp.toFixed(1)} bp` : ""
      }</span>
    </td>`;
}

function weekCell(week, m, byDate) {
  const days = week
    .filter((date) => iso(date).slice(0, 7) === m.month)
    .map((date) => byDate.get(iso(date)))
    .filter(Boolean);
  if (!days.length) return '<td class="cal-week out"></td>';
  const net = days.reduce((a, d) => a + d.net, 0);
  const n = days.reduce((a, d) => a + cellSum(d), 0);
  const green = days.filter((d) => d.net > 0).length;
  return `
    <td class="cal-week ${cls(net)}">
      <span class="dpnl">${fmt(net)}</span>
      <span class="dsub">${n} ${n === 1 ? "trade" : "trades"} · ${green}/${days.length} green</span>
    </td>`;
}

function daysBlock(m) {
  const [y, mo] = m.month.split("-").map(Number);
  const byDate = new Map(m.days.map((d) => [d.date, d]));
  const lastTs = Date.UTC(y, mo, 0);
  // старт = понедельник недели, в которую попало 1-е число
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const startTs = Date.UTC(y, mo - 1, 1 - ((first.getUTCDay() + 6) % 7));

  // Считаем в миллисекундах, а не мутируем Date в условии цикла: eslint
  // (no-unmodified-loop-condition) не видит мутацию через setUTCDate и
  // помечает такой while как бесконечный. Заодно код честнее — видно, что шаг
  // ровно неделя.
  const DAY = 86_400_000;
  const rows = [];
  for (let ts = startTs; ts <= lastTs; ts += 7 * DAY) {
    const week = Array.from({ length: 7 }, (_, i) => new Date(ts + i * DAY));
    rows.push(`
      <tr>
        ${week.map((d) => dayCell(d, m, byDate)).join("")}
        ${weekCell(week, m, byDate)}
      </tr>`);
  }
  return `
    <table class="cal">
      <thead>
        <tr>
          <th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th>
          <th>Fri</th><th>Sat</th><th>Sun</th>
          <th class="wk-head">Week</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

function bindExpand(host) {
  // Раскрытие анимированное, поэтому строка НЕ прячется через hidden: скрытому
  // элементу нечего анимировать. Закрытая строка живёт в разметке с нулевой
  // высотой (grid-template-rows: 0fr, см. _ledger.scss) и раскрывается до 1fr —
  // это единственный способ доехать до «высоты по содержимому» без измерений в
  // JS, который на таблице всё равно врёт (вложенный календарь переносится).
  const toggle = (tr) => {
    const panel = host.querySelector(
      `tr.daybreak[data-days="${tr.dataset.month}"]`,
    );
    if (!panel) return;
    const open = !panel.classList.contains("is-open");
    panel.classList.toggle("is-open", open);
    tr.classList.toggle("is-open", open);
    tr.setAttribute("aria-expanded", String(open));
  };
  // Клик мышью не должен оставлять фокус-рамку: помечаем строку на время
  // взаимодействия, стиль её гасит, blur снимает метку.
  host.addEventListener("mousedown", (e) => {
    const tr = e.target.closest("tr.expandable");
    if (tr) tr.classList.add("is-clicked");
  });
  host.addEventListener("blur", (e) => {
    const tr = e.target.closest?.("tr.expandable");
    if (tr) tr.classList.remove("is-clicked");
  }, true);
  host.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.expandable");
    if (tr) toggle(tr);
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr.expandable");
    if (!tr) return;
    e.preventDefault();
    toggle(tr);
  });
}

function renderTable(data) {
  const t = data.totals;
  const head = `
    <table class="ledger">
      <thead>
        <tr>
          <th>Month</th>
          <th class="grp">Bot P&L</th>
          <th class="col-opt">#</th>
          <th class="grp" title="I entered by hand, the nanny picked it up and closed it">Adopted P&L</th>
          <th class="col-opt">#</th>
          <th class="grp">Manual P&L</th>
          <th class="col-opt">#</th>
          <th class="grp">Fees</th>
          <th class="col-opt">Funding</th>
          <th class="grp">Net</th>
          <th>Cumulative</th>
        </tr>
      </thead>
      <tbody>
        ${data.months.map(row).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td class="month">Total</td>
          <td class="grp-edge ${cls(t.botNet)}">${fmt(t.botNet)}</td>
          <td class="col-opt dim">${t.botCount}</td>
          <td class="grp-edge ${cls(t.adoptedNet)}">${t.adoptedCount ? fmt(t.adoptedNet) : "—"}</td>
          <td class="col-opt dim">${t.adoptedCount}</td>
          <td class="grp-edge ${cls(t.manualNet)}">${fmt(t.manualNet)}</td>
          <td class="col-opt dim">${t.manualCount}</td>
          <td class="grp-edge neg">${fmt(-t.fees, false)}</td>
          <td class="col-opt ${cls(t.funding)}">${fmt(t.funding)}</td>
          <td class="grp-edge net-cell ${cls(t.net)}">${fmt(t.net)}</td>
          <td class="${cls(t.net)}">${fmt(t.net)}</td>
        </tr>
      </tfoot>
    </table>`;
  const host = document.getElementById("table-host");
  host.innerHTML = head;
  bindExpand(host);
}

// Скрипт страницы — не модуль, импортировать placeholders.js неоткуда,
// поэтому разметка .empty собрана здесь руками. Классы те же, что у
// остальных пустых состояний дашборда (core/_loaders.scss).
function showEmpty(title, hint) {
  document.getElementById("table-host").innerHTML =
    '<div class="empty-state"><div class="empty-state__title">' +
    title +
    '</div><div class="empty-state__hint">' +
    hint +
    "</div></div>";
  // Скелетоны сводки обещали числа, которых уже не будет.
  document.getElementById("summary").innerHTML = "";
}

async function load() {
  try {
    const r = await fetch("/api/ledger");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    document.getElementById("start-date").textContent =
      data.startDate || "—";
    if (!data.live || !data.months.length) {
      showEmpty(
        "No on-chain fills to show",
        "The bot is in PAPER mode, or Hyperliquid returned no fills for this wallet.",
      );
      return;
    }
    renderSummary(data.totals);
    renderTable(data);
  } catch (e) {
    showEmpty(
      "Ledger did not load",
      e.message + ". Reload the page to try again.",
    );
  }
}


function onStatus(data) {
  renderBans(data);
}

async function tick() {
  // Recent Activity переехала на главную (index) — здесь остаётся только Tax Summary.
  const [taxR] = await Promise.allSettled([fetchJson("/api/tax-summary")]);
  if (taxR.status === "fulfilled") renderTax(taxR.value);
  markSuccess();
}

// ── Bootstrap ──
mountTopnav("ledger");
load();
bindTheme();
initModals();
initWebSocket({ onStatus });
tick();
setInterval(tick, REFRESH_MS);
startFooterTimer();
