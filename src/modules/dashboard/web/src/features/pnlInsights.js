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
      ? ` · 🖐 ${manualCount} manual (${fmtMoney(manualPnl)})`
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

  // Резерв высоты под самый «высокий» период: замеряем реальную строку и
  // считаем max число стратегий по всем периодам. Без этого блок стратегий
  // меняет высоту при переключении дней и карточка (с графиком ниже) скачет.
  let maxRows = 1;
  for (const per of Object.values(lastPnlSummary.periods)) {
    const n = Object.keys(per.byStrategy || {}).length;
    if (n > maxRows) maxRows = n;
  }
  const sampleRow = stratContainer.querySelector(".strategy-row");
  if (sampleRow) {
    const rowH = sampleRow.getBoundingClientRect().height;
    const gap =
      0.4 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    stratContainer.style.minHeight = `${Math.round(maxRows * rowH + (maxRows - 1) * gap)}px`;
  }

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
        ? `${key} · ${fmtMoney(d.pnl)} · ${d.trades} trade${d.trades === 1 ? "" : "s"}`
        : key;
      cells.push(
        `<div class="heatmap-cell ${cellClass(d)}${todayCls}" title="${tip}"></div>`,
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
      <button class="heatmap-year-btn" data-dir="-1" ${prevDis} aria-label="Previous year">‹</button>
      <span class="heatmap-year">${year}</span>
      <button class="heatmap-year-btn" data-dir="1" ${nextDis} aria-label="Next year">›</button>
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

  document.querySelectorAll("#pnl-periods .range-btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.period === currentPnlPeriod) return;
      document
        .querySelectorAll("#pnl-periods .range-btn")
        .forEach((r) => r.classList.remove("active"));
      b.classList.add("active");
      currentPnlPeriod = b.dataset.period;
      renderPnlSummary();
    }),
  );

  document.querySelectorAll("#insights-tabs .range-btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.tab === currentInsightsTab) return;
      document
        .querySelectorAll("#insights-tabs .range-btn")
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

  // Навигация по годам heatmap (делегирование — сетка перерисовывается).
  document.getElementById("heatmap-grid")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".heatmap-year-btn");
    if (!btn || btn.disabled) return;
    currentHeatmapYear += parseInt(btn.dataset.dir, 10);
    renderHeatmap();
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
