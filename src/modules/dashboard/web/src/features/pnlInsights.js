// ─────────────────────────────────────────────────
//  P&L Summary + Insights (per-coin lifetime + 90d heatmap) + Tax.
//  · renderPnlSummary — карточка P&L по периоду (today/week/...) + breakdown по
//    стратегиям; период переключается кнопками #pnl-periods.
//  · renderInsights → renderPerCoin / renderHeatmap (вкладки #insights-tabs,
//    сортировка per-coin таблицы).
//  · renderTax — налоговая сводка (PLN), без внутреннего state.
//  Данные приходят из tick через setPnlSummary/setInsights; period/tab/sort —
//  внутренний state. initPnlInsights({ fmtTime }) вешает биндинги.
// ─────────────────────────────────────────────────

import { fmtMoney, escapeHtml, strategyDisplayName } from "../utils/format.js";
import { fetchJson, postJson } from "../net/api.js";
import { icon } from "../core/icon.js";

let currentPnlPeriod = "today";
let lastPnlSummary = null;
let lastInsights = null;
let currentInsightsTab = "per-coin";
let perCoinSort = { key: "pnl", dir: "desc" };
let currentHeatmapYear = null; // выбранный год сетки (null → последний с данными)
let _fmtTime = (ts) => String(ts); // зависит от currentRangeHours в main

export function setPnlSummary(payload) {
  lastPnlSummary = payload;
  renderPnlSummary();
}
export function setInsights(payload) {
  lastInsights = payload;
  renderInsights();
}

function renderPnlSummary() {
  if (!document.getElementById("pnl-total")) return; // секция живёт на /strategies.html
  if (!lastPnlSummary || !lastPnlSummary.periods) return;
  const p = lastPnlSummary.periods[currentPnlPeriod];
  if (!p) return;

  // p.* теперь = combined stats (bot + manual). p.manual/p.bot — только для split-вывода.
  const manualPnl = p.manual?.pnl || 0;
  const manualCount = p.manual?.count || 0;

  const totalEl = document.getElementById("pnl-total");
  totalEl.textContent = fmtMoney(p.totalPnl || 0);
  totalEl.classList.toggle("positive", (p.totalPnl || 0) > 0);
  totalEl.classList.toggle("negative", (p.totalPnl || 0) < 0);

  const wr = p.count > 0 ? `${p.winRate.toFixed(0)}% win` : "—";
  const manualNote =
    manualCount > 0
      ? ` · ${icon("manual")} ${manualCount} manual (${fmtMoney(manualPnl)})`
      : "";
  document.getElementById("pnl-stats").textContent =
    `${p.count} trade${p.count === 1 ? "" : "s"} · ${wr}${manualNote}`;

  const fundingEl = document.getElementById("pnl-funding");
  fundingEl.textContent = p.funding ? fmtMoney(p.funding) : "—";
  fundingEl.classList.toggle("positive", p.funding > 0);
  fundingEl.classList.toggle("negative", p.funding < 0);

  // Unrealized показываем только для period=today (он "сейчас")
  const unrEl = document.getElementById("pnl-unrealized");
  const unr = lastPnlSummary.unrealized;
  if (currentPnlPeriod === "today" && Number.isFinite(unr) && unr !== 0) {
    unrEl.textContent = fmtMoney(unr);
    unrEl.classList.toggle("positive", unr > 0);
    unrEl.classList.toggle("negative", unr < 0);
  } else {
    unrEl.textContent = "—";
    unrEl.classList.remove("positive", "negative");
  }

  document.getElementById("pnl-utilization").textContent = Number.isFinite(
    p.utilizationPct,
  )
    ? `${p.utilizationPct.toFixed(0)}%`
    : "—";

  document.getElementById("pnl-avg").textContent =
    p.count > 0 ? fmtMoney(p.avgPnl) : "—";
  document.getElementById("pnl-best").textContent =
    p.count > 0 ? fmtMoney(p.bestPnl) : "—";
  document.getElementById("pnl-worst").textContent =
    p.count > 0 ? fmtMoney(p.worstPnl) : "—";
  document.getElementById("pnl-wl").textContent =
    p.count > 0 ? `${p.wins} / ${p.losses}` : "—";

  const expEl = document.getElementById("pnl-expectancy");
  if (expEl) {
    expEl.textContent = p.count > 0 ? fmtMoney(p.expectancy) : "—";
    expEl.classList.toggle("positive", p.expectancy > 0);
    expEl.classList.toggle("negative", p.expectancy < 0);
  }
  const payoffEl = document.getElementById("pnl-payoff");
  if (payoffEl) {
    if (p.count === 0 || p.payoffRatio == null) {
      payoffEl.textContent = "—";
    } else {
      payoffEl.textContent = `${p.payoffRatio.toFixed(2)}×`;
    }
  }
  const ddEl = document.getElementById("pnl-maxdd");
  if (ddEl) {
    if (p.count === 0) {
      ddEl.textContent = "—";
    } else {
      const pctTxt = Number.isFinite(p.maxDrawdownPct)
        ? ` (${p.maxDrawdownPct.toFixed(0)}%)`
        : "";
      ddEl.textContent = `${fmtMoney(-Math.abs(p.maxDrawdown))}${pctTxt}`;
      ddEl.classList.toggle("negative", p.maxDrawdown > 0);
    }
  }
  const feesEl = document.getElementById("pnl-fees");
  if (feesEl) {
    if (p.count === 0) {
      feesEl.textContent = "—";
    } else {
      const pctTxt =
        Number.isFinite(p.feesPctOfGross) && p.grossPnl !== 0
          ? ` (${p.feesPctOfGross.toFixed(0)}% of gross)`
          : "";
      feesEl.textContent = `${fmtMoney(p.totalFees)}${pctTxt}`;
    }
  }

  // Strategy breakdown — byStrategy уже включает 'manual' (server-side combined).
  const stratContainer = document.getElementById("pnl-strategy");
  const strategies = Object.entries(p.byStrategy || {});
  if (strategies.length === 0) {
    stratContainer.innerHTML =
      '<div class="empty-state">No trades in this period</div>';
  } else {
    const maxAbs = Math.max(
      1e-9,
      ...strategies.map(([, s]) => Math.abs(s.pnl)),
    );
    stratContainer.innerHTML = strategies
      .sort(([, a], [, b]) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .map(([sid, s]) => {
        const widthPct = (Math.abs(s.pnl) / maxAbs) * 100;
        const wr = s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : 0;
        const cls = s.pnl > 0 ? "positive" : s.pnl < 0 ? "negative" : "";
        return `
          <div class="strategy-row">
            <div class="strategy-name">${strategyDisplayName(sid)}</div>
            <div class="strategy-bar"><div class="strategy-bar-fill ${cls}" style="width:${widthPct}%"></div></div>
            <div class="strategy-pnl ${cls}">${fmtMoney(s.pnl)}</div>
            <div class="strategy-meta">${s.count}t · ${wr}% win</div>
          </div>`;
      })
      .join("");
  }

  // Блок стратегий занимает высоту под реальное число строк текущего периода.
  // (Раньше резервировали max по всем периодам, чтобы карточка не «прыгала» при
  // переключении дней — но это давало постоянную дыру на дефолтном Today с одной
  // стратегией. Лёгкий рефлоу при ручном переключении периода предпочтительнее.)

  // Данные отрендерены — убираем скелетон-оверлей.
  document.getElementById("pnl-skeleton")?.classList.add("hidden");
}

// ─────────────────────────────────────────────────
//  Insights: per-coin lifetime + 90d heatmap
// ─────────────────────────────────────────────────
function renderInsights() {
  if (!lastInsights) return;
  if (currentInsightsTab === "per-coin") renderPerCoin();
  else if (currentInsightsTab === "breakdown") renderBreakdown();
  else if (currentInsightsTab === "exits") renderExits();
  else renderHeatmap();
  document.getElementById("insights-skeleton")?.classList.add("hidden");
}

// ── Breakdown: long/short + по стратегии (lifetime, с expectancy/payoff) ──
function sideLabel(side) {
  if (side === "short") return "🔴 SHORT";
  if (side === "long") return "🟢 LONG";
  return escapeHtml(side || "?");
}

function breakdownRow(label, r) {
  const pnlCls = r.pnl > 0 ? "num-pos" : r.pnl < 0 ? "num-neg" : "";
  const expCls = r.expectancy > 0 ? "num-pos" : r.expectancy < 0 ? "num-neg" : "";
  const wrCls = r.winRate >= 60 ? "num-pos" : r.winRate < 40 ? "num-neg" : "";
  // payoff < 1 = леак (средний выигрыш меньше среднего проигрыша).
  const payoff = r.payoffRatio == null ? "—" : `${r.payoffRatio.toFixed(2)}×`;
  const payoffCls =
    r.payoffRatio == null ? "" : r.payoffRatio >= 1 ? "num-pos" : "num-neg";
  return `
    <tr>
      <td>${label}</td>
      <td class="num">${r.trades}</td>
      <td class="num ${wrCls}">${r.winRate.toFixed(0)}%</td>
      <td class="num ${pnlCls}">${fmtMoney(r.pnl)}</td>
      <td class="num ${expCls}">${fmtMoney(r.expectancy)}</td>
      <td class="num ${payoffCls}">${payoff}</td>
    </tr>`;
}

function renderBreakdown() {
  const empty = '<tr><td colspan="6" class="empty-state">No trades yet</td></tr>';
  const sideTbody = document.getElementById("breakdown-side-tbody");
  if (sideTbody) {
    const rows = lastInsights.bySide || [];
    sideTbody.innerHTML = rows.length
      ? rows.map((r) => breakdownRow(sideLabel(r.side), r)).join("")
      : empty;
  }
  const stratTbody = document.getElementById("breakdown-strategy-tbody");
  if (stratTbody) {
    const rows = lastInsights.byStrategy || [];
    stratTbody.innerHTML = rows.length
      ? rows.map((r) => breakdownRow(strategyDisplayName(r.strategy), r)).join("")
      : empty;
  }
}

// ── Exit quality: MFE/MAE excursion (насколько хорошо выходим) ──
function statCard(label, value, cls, hint) {
  return `<div class="exits-card ${cls || ""}">
      <div class="exits-card-val">${value}</div>
      <div class="exits-card-lbl" title="${hint || ""}">${label}</div>
    </div>`;
}

function renderExits() {
  const ex = lastInsights.excursion;
  const meta = document.getElementById("exits-meta");
  const cards = document.getElementById("exits-cards");
  const tbody = document.getElementById("exits-tbody");
  if (!meta || !cards || !tbody) return;

  if (!ex || !ex.sample) {
    meta.textContent = "No trades with MFE/MAE tracking yet (adopt: manual entry, bot exit)";
    cards.innerHTML = "";
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">No excursion data yet</td></tr>';
    return;
  }

  // Малая выборка — честно подсвечиваем, что это линза, а не «доказательство».
  const thin = ex.winners < 20;
  meta.innerHTML =
    `${ex.sample} trades with MFE/MAE · ${ex.winners} winners` +
    (ex.dupsRemoved ? ` · ${ex.dupsRemoved} duplicate(s) merged` : "") +
    (thin
      ? ` · <span class="exits-warn">sample too small (&lt;20) — diagnostics, not an edge</span>`
      : "");

  const cap = ex.avgCapturePct;
  const capCls = cap == null ? "" : cap >= 50 ? "is-good" : cap >= 30 ? "" : "is-bad";
  cards.innerHTML = [
    statCard(
      "Avg capture",
      cap == null ? "—" : `${cap.toFixed(0)}%`,
      capCls,
      "realized ÷ MFE on winners — how much of the available move you take. ~50%+ is solid",
    ),
    statCard(
      "Avg left on table",
      ex.avgLeftOnTable == null ? "—" : fmtMoney(ex.avgLeftOnTable),
      "",
      "MFE − realized: how much of the peak you give back on average (some is unavoidable)",
    ),
    statCard(
      "Avg heat (MAE)",
      ex.avgHeat == null ? "—" : fmtMoney(-ex.avgHeat),
      "",
      "Average drawdown on winners before they turned — entry timing / catching knives",
    ),
    statCard(
      "Round-tripped",
      String(ex.roundTripped),
      ex.roundTripped > 0 ? "is-bad" : "is-good",
      "Was clearly green, closed red — the worst kind of exit",
    ),
  ].join("");

  tbody.innerHTML = ex.rows
    .map((t) => {
      const pnlCls = t.pnl > 0 ? "num-pos" : t.pnl < 0 ? "num-neg" : "";
      // Capture — метрика только для winners (доля удержанного пика). На лузерах
      // realized/MFE вырождается в мусор (−4556% при MFE≈0) → показываем «—».
      const isWinner = t.pnl > 0 && t.capture != null;
      const capPct = isWinner ? `${(t.capture * 100).toFixed(0)}%` : "—";
      const capCls = isWinner ? (t.capture >= 0.5 ? "num-pos" : "num-neg") : "";
      return `<tr>
        <td>${escapeHtml(t.coin)}</td>
        <td>${sideLabel(t.side)}</td>
        <td class="num ${pnlCls}">${fmtMoney(t.pnl)}</td>
        <td class="num">${t.mfeUsd == null ? "—" : fmtMoney(t.mfeUsd)}</td>
        <td class="num">${t.maeUsd == null ? "—" : fmtMoney(t.maeUsd)}</td>
        <td class="num ${capCls}">${capPct}</td>
      </tr>`;
    })
    .join("");
}

function renderPerCoin() {
  const rows = [...(lastInsights.perCoin || [])];
  const { key, dir } = perCoinSort;
  const mul = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (typeof va === "string") return mul * va.localeCompare(vb);
    return mul * ((va || 0) - (vb || 0));
  });

  // Sort indicator on headers.
  document.querySelectorAll(".per-coin-table th[data-sort]").forEach((th) => {
    th.classList.remove("sort-active", "sort-asc", "sort-desc");
    if (th.dataset.sort === key) {
      th.classList.add("sort-active");
      th.classList.add(dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  const meta = document.getElementById("per-coin-meta");
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  if (meta) {
    meta.textContent = `${rows.length} coins · ${totalTrades} trades · ${fmtMoney(totalPnl)} all-time`;
  }

  const tbody = document.getElementById("per-coin-tbody");
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">No trades yet</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const pnlCls = r.pnl > 0 ? "num-pos" : r.pnl < 0 ? "num-neg" : "";
      const avgCls = r.avg > 0 ? "num-pos" : r.avg < 0 ? "num-neg" : "";
      const wrCls =
        r.winRate >= 60 ? "num-pos" : r.winRate < 40 ? "num-neg" : "";
      return `
        <tr>
          <td class="coin-cell">#${escapeHtml(r.coin)}</td>
          <td class="num">${r.trades}</td>
          <td class="num ${pnlCls}">${fmtMoney(r.pnl)}</td>
          <td class="num ${wrCls}">${r.winRate.toFixed(0)}%</td>
          <td class="num ${avgCls}">${fmtMoney(r.avg)}</td>
          <td class="num num-muted">${_fmtTime(r.lastClosedAt)}</td>
        </tr>`;
    })
    .join("");
}

// Локальный YYYY-MM-DD (тот же формат, что отдаёт бэкенд).
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function renderHeatmap() {
  const days = lastInsights.daily || []; // только дни с торговлей, по возрастанию
  const grid = document.getElementById("heatmap-grid");
  const meta = document.getElementById("heatmap-meta");
  if (!grid) return;

  const byDate = new Map(days.map((d) => [d.date, d]));

  // Доступные года из данных + текущий; кламп выбранного года к диапазону.
  const nowYear = new Date().getFullYear();
  const years = new Set(days.map((d) => +d.date.slice(0, 4)));
  years.add(nowYear);
  const yearList = [...years].sort((a, b) => a - b);
  const minYear = yearList[0];
  const maxYear = yearList[yearList.length - 1];
  if (
    currentHeatmapYear == null ||
    currentHeatmapYear < minYear ||
    currentHeatmapYear > maxYear
  ) {
    currentHeatmapYear = maxYear;
  }
  const year = currentHeatmapYear;

  // Тиры по абсолюту daily P&L за ВСЮ историю — цвета сопоставимы между годами.
  const absVals = days
    .map((d) => Math.abs(d.pnl))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const q = (p) =>
    absVals.length === 0 ? 0 : absVals[Math.floor((absVals.length - 1) * p)];
  const t1 = q(0.33);
  const t2 = q(0.66);
  const cellClass = (d) => {
    if (!d || d.trades === 0) return "empty";
    const a = Math.abs(d.pnl);
    const tier = a >= t2 ? "strong" : a >= t1 ? "normal" : "weak";
    return d.pnl >= 0 ? `win-${tier}` : `loss-${tier}`;
  };

  const todayKey = localDateKey(new Date());

  // 12 месячных блоков выбранного года (календарная сетка Mon..Sun).
  const months = [];
  for (let m = 0; m < 12; m++) {
    const lead = (new Date(year, m, 1).getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) {
      cells.push('<div class="heatmap-cell placeholder"></div>');
    }
    let monthPnl = 0;
    let monthTrades = 0;
    for (let dd = 1; dd <= daysInMonth; dd++) {
      const key = `${year}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      const d = byDate.get(key);
      if (d) {
        monthPnl += d.pnl;
        monthTrades += d.trades;
      }
      const todayCls = key === todayKey ? " is-today" : "";
      const tip = d
        ? `${key} · ${fmtMoney(d.pnl)} · ${d.trades} trade${d.trades === 1 ? "" : "s"} — click to review`
        : key;
      // Дни со сделками кликабельны → модалка разбора дня (сделки + заметка).
      const clickAttr = d ? ` data-date="${key}" role="button" tabindex="0"` : "";
      const clickCls = d ? " is-clickable" : "";
      cells.push(
        `<div class="heatmap-cell ${cellClass(d)}${todayCls}${clickCls}" title="${tip}"${clickAttr}></div>`,
      );
    }
    const pnlCls = monthPnl > 0 ? "pos" : monthPnl < 0 ? "neg" : "";
    const pnlTag =
      monthTrades > 0
        ? `<span class="heatmap-month-pnl ${pnlCls}">${fmtMoney(monthPnl)}</span>`
        : "";
    months.push(
      `<div class="heatmap-month">
        <div class="heatmap-month-head">
          <span class="heatmap-month-name">${MONTH_NAMES[m]}</span>${pnlTag}
        </div>
        <div class="heatmap-month-grid">${cells.join("")}</div>
      </div>`,
    );
  }

  const prevDis = year <= minYear ? "disabled" : "";
  const nextDis = year >= maxYear ? "disabled" : "";
  grid.innerHTML = `
    <div class="heatmap-nav">
      <button class="btn btn--icon btn--sm heatmap-year-btn" type="button" data-dir="-1" ${prevDis} aria-label="Previous year">${icon("prev")}</button>
      <span class="heatmap-year">${year}</span>
      <button class="btn btn--icon btn--sm heatmap-year-btn" type="button" data-dir="1" ${nextDis} aria-label="Next year">${icon("next")}</button>
    </div>
    <div class="heatmap-months">${months.join("")}</div>`;

  if (meta) {
    const yearDays = days.filter((d) => d.date.startsWith(`${year}-`));
    const yearPnl = yearDays.reduce((s, d) => s + d.pnl, 0);
    const yearTrades = yearDays.reduce((s, d) => s + d.trades, 0);
    meta.textContent =
      yearDays.length > 0
        ? `${year}: ${yearDays.length} active days · ${yearTrades} trades · ${fmtMoney(yearPnl)}`
        : `${year}: no trades`;
  }
}

export function renderTax(tax) {
  if (!tax) return;
  if (!document.getElementById("tax-costs")) return; // нет секции (/strategies.html)
  // Год — из payload (/api/tax-summary), а не зашитый в HTML: иначе врёт после
  // смены календарного года.
  const yearEl = document.getElementById("tax-year");
  if (yearEl && tax.year) yearEl.textContent = tax.year;
  document.getElementById("tax-costs").textContent =
    `${(tax.totalCostsPLN || 0).toLocaleString()} PLN`;
  document.getElementById("tax-revenue").textContent =
    `${(tax.totalRevenuePLN || 0).toLocaleString()} PLN`;
  const profit = tax.netProfitPLN || 0;
  const profitEl = document.getElementById("tax-profit");
  profitEl.textContent = `${profit >= 0 ? "+" : ""}${profit.toLocaleString()} PLN`;
  profitEl.style.color = profit >= 0 ? "var(--green)" : "var(--red)";
  document.getElementById("tax-est").textContent =
    `${(profit > 0 ? profit * 0.19 : 0).toLocaleString()} PLN`;
}

// Биндинги переключателей периода/вкладок/сортировки. Зовётся из bootstrap.
export function initPnlInsights({ fmtTime } = {}) {
  if (typeof fmtTime === "function") _fmtTime = fmtTime;

  document.querySelectorAll("#pnl-periods .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.period === currentPnlPeriod) return;
      document
        .querySelectorAll("#pnl-periods .seg__btn")
        .forEach((r) => r.classList.remove("active"));
      b.classList.add("active");
      currentPnlPeriod = b.dataset.period;
      renderPnlSummary();
    }),
  );

  document.querySelectorAll("#insights-tabs .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.tab === currentInsightsTab) return;
      document
        .querySelectorAll("#insights-tabs .seg__btn")
        .forEach((r) => r.classList.remove("active"));
      b.classList.add("active");
      currentInsightsTab = b.dataset.tab;
      document
        .querySelectorAll("#insights-container .insights-pane")
        .forEach((pane) => {
          pane.style.display =
            pane.id === `insights-pane-${currentInsightsTab}` ? "" : "none";
        });
      renderInsights();
    }),
  );

  // Навигация по годам heatmap + клик по дню → модалка разбора (делегирование,
  // сетка перерисовывается каждый рендер).
  document.getElementById("heatmap-grid")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".heatmap-year-btn");
    if (btn) {
      if (btn.disabled) return;
      currentHeatmapYear += parseInt(btn.dataset.dir, 10);
      renderHeatmap();
      return;
    }
    const cell = e.target.closest(".heatmap-cell[data-date]");
    if (cell) openDayModal(cell.dataset.date);
  });
  // Клавиатурная доступность: Enter/Space на клетке-дне.
  document.getElementById("heatmap-grid")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cell = e.target.closest(".heatmap-cell[data-date]");
    if (cell) {
      e.preventDefault();
      openDayModal(cell.dataset.date);
    }
  });

  document.querySelectorAll(".per-coin-table th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (perCoinSort.key === key) {
        perCoinSort.dir = perCoinSort.dir === "desc" ? "asc" : "desc";
      } else {
        perCoinSort.key = key;
        // По дефолту для числовых — desc, для coin — asc.
        perCoinSort.dir = key === "coin" ? "asc" : "desc";
      }
      renderInsights();
    }),
  );
}

// ─────────────────────────────────────────────────
//  Day modal — разбор дня (Tradezella-style): сделки дня + заметка
// ─────────────────────────────────────────────────
// Self-contained: statistics.html не тащит index-овую modals.js, поэтому оверлей
// создаётся здесь лениво и живёт в body. Данные — /api/day-journal (те же
// round-trip'ы, что хитмап/Ledger → цифры сходятся). Заметка автосейвится при
// закрытии, если изменилась (плюс кнопка «Сохранить»).
let dayModalEl = null;
let dayModalState = { date: null, loadedNote: "" };

const SOURCE_LABEL = { bot: "bot", adopted: "adopt", manual: "manual" };

function ensureDayModal() {
  if (dayModalEl) return dayModalEl;
  const el = document.createElement("div");
  el.className = "day-modal";
  el.hidden = true;
  el.innerHTML = `
    <div class="day-modal__backdrop" data-close="1"></div>
    <div class="day-modal__panel" role="dialog" aria-modal="true" aria-label="Day review">
      <div class="day-modal__head">
        <div class="day-modal__title" id="day-modal-title">—</div>
        <button class="day-modal__close" data-close="1" aria-label="Close">✕</button>
      </div>
      <div class="day-modal__summary" id="day-modal-summary"></div>
      <div class="day-modal__trades" id="day-modal-trades"></div>
      <label class="day-modal__note-lbl" for="day-modal-note">Day note</label>
      <textarea id="day-modal-note" class="day-modal__note" rows="4"
        placeholder="What went well / where you slipped / did you follow the plan…"></textarea>
      <div class="day-modal__foot">
        <span class="day-modal__status" id="day-modal-status"></span>
        <button class="btn btn--primary" type="button" id="day-modal-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  el.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", closeDayModal),
  );
  el.querySelector("#day-modal-save").addEventListener("click", () =>
    saveDayNote(true),
  );
  dayModalEl = el;
  return el;
}

async function openDayModal(date) {
  const el = ensureDayModal();
  dayModalState = { date, loadedNote: "" };
  el.querySelector("#day-modal-title").textContent = date;
  el.querySelector("#day-modal-summary").innerHTML = "";
  el.querySelector("#day-modal-trades").innerHTML =
    '<div class="day-modal__loading">Loading…</div>';
  el.querySelector("#day-modal-note").value = "";
  el.querySelector("#day-modal-status").textContent = "";
  el.hidden = false;
  document.body.style.overflow = "hidden";

  let data;
  try {
    data = await fetchJson(`/api/day-journal?date=${date}`);
  } catch {
    el.querySelector("#day-modal-trades").innerHTML =
      '<div class="day-modal__loading">Load error</div>';
    return;
  }
  if (dayModalState.date !== date) return; // открыли другой день, пока грузилось

  const s = data.summary || { trades: 0, pnl: 0, fees: 0, wins: 0, losses: 0 };
  const pnlCls = s.pnl > 0 ? "num-pos" : s.pnl < 0 ? "num-neg" : "";
  el.querySelector("#day-modal-summary").innerHTML =
    `<span class="${pnlCls}">${fmtMoney(s.pnl)}</span>` +
    `<span class="day-modal__sub">${s.trades} trades · ${s.wins}W/${s.losses}L · fees ${fmtMoney(-Math.abs(s.fees))}</span>`;

  el.querySelector("#day-modal-trades").innerHTML = renderDayTrades(data.trades || []);

  dayModalState.loadedNote = data.note || "";
  el.querySelector("#day-modal-note").value = data.note || "";
}

function renderDayTrades(trades) {
  if (!trades.length) return '<div class="day-modal__loading">No trades</div>';
  const rows = trades
    .map((t) => {
      const sideCls = (t.side || "").toLowerCase() === "long" ? "long" : "short";
      const pnlCls = t.pnl > 0 ? "num-pos" : t.pnl < 0 ? "num-neg" : "";
      const src = SOURCE_LABEL[t.source] || t.source || "—";
      return `<tr>
        <td>${escapeHtml(t.coin || "?")}</td>
        <td><span class="day-side day-side--${sideCls}">${sideCls.toUpperCase()}</span></td>
        <td class="day-modal__src">${escapeHtml(src)}</td>
        <td class="r">${_fmtTime(t.closeTime)}</td>
        <td class="r ${pnlCls}">${fmtMoney(t.pnl)}</td>
      </tr>`;
    })
    .join("");
  return `<table class="day-modal__table"><thead><tr>
      <th>Coin</th><th>Side</th><th>Source</th><th class="r">Closed</th><th class="r">PnL</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

async function saveDayNote(explicit = false) {
  const el = dayModalEl;
  if (!el || !dayModalState.date) return;
  const note = el.querySelector("#day-modal-note").value;
  if (note === dayModalState.loadedNote) {
    if (explicit) flashStatus("No changes");
    return;
  }
  try {
    await postJson("/api/day-journal", { date: dayModalState.date, note });
    dayModalState.loadedNote = note;
    flashStatus("Saved");
  } catch {
    flashStatus("Save error");
  }
}

function flashStatus(text) {
  const st = dayModalEl?.querySelector("#day-modal-status");
  if (!st) return;
  st.textContent = text;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => {
    if (st.textContent === text) st.textContent = "";
  }, 2500);
}

function closeDayModal() {
  if (!dayModalEl) return;
  saveDayNote(false); // автосейв, если заметка изменилась
  dayModalEl.hidden = true;
  document.body.style.overflow = "";
  dayModalState.date = null;
}

// Esc закрывает модалку дня (один глобальный слушатель).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dayModalEl && !dayModalEl.hidden) closeDayModal();
});
