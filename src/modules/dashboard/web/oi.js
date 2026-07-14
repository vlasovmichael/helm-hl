import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  oi.html — витрина истории open interest (все монеты).
//  Читает /api/oi-collector/* (данные от tools/oiCollector.mjs). Сверху —
//  сортируемая таблица-обзор по всем монетам с ΔOI 24ч/1ч; клик по монете →
//  ряд во времени (dual-axis спарклайн OI vs цена + таблица).
//  ЭТО ПОКАЗ ДАННЫХ, не сигнал — вывод про эдж требует месяца разных режимов.
// ─────────────────────────────────────────────────

import { bindTheme } from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { fetchJson } from "./src/net/api.js";

mountTopnav("oi");
bindTheme();

// ── форматтеры ──
const fmtUsd = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};
const fmtTok = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};
const fmtPx = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(4);
};
const fmtPctCell = (n) => {
  if (n == null || !Number.isFinite(n))
    return '<span class="oi-muted">—</span>';
  const cls = n > 0 ? "oi-pos" : n < 0 ? "oi-neg" : "oi-muted";
  const sign = n > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${n.toFixed(1)}%</span>`;
};
const fmtFunding = (n) => {
  if (n == null || !Number.isFinite(n))
    return '<span class="oi-muted">—</span>';
  const cls = n > 0 ? "oi-pos" : n < 0 ? "oi-neg" : "oi-muted";
  const sign = n > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${(n * 100).toFixed(4)}%</span>`;
};
const fmtTime = (t) =>
  new Date(t).toISOString().slice(5, 16).replace("T", " ");

// ── состояние обзора ──
let overview = [];
let sortKey = "oiUsd";
let sortAsc = false;
let filter = "";
let activeCoin = null;
let detailHours = 72;

// ── обзор ──
async function loadOverview() {
  const data = await fetchJson("/api/oi-collector/overview");
  const spanEl = document.getElementById("oi-span");
  if (!data.ok) {
    document.getElementById("oi-tbody").innerHTML =
      '<tr><td colspan="8" class="oi-empty">Нет данных коллектора ещё. Первый снимок появится в течение 15 минут после запуска.</td></tr>';
    spanEl.textContent = "";
    return;
  }
  overview = data.coins;
  const s = data.span;
  const dur = ((s.lastT - s.firstT) / 3600_000).toFixed(0);
  spanEl.textContent = `${data.coins.length} монет · ${s.count} снимков · история ~${dur}ч${
    data.has24h ? "" : " · Δ24ч пока неполная"
  }`;
  renderTable();
}

function sortRows(rows) {
  const dir = sortAsc ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortKey === "coin") return dir * a.coin.localeCompare(b.coin);
    const av = a[sortKey],
      bv = b[sortKey];
    // null/NaN всегда вниз
    const an = av == null || !Number.isFinite(av);
    const bn = bv == null || !Number.isFinite(bv);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return dir * (av - bv);
  });
}

function renderTable() {
  const tbody = document.getElementById("oi-tbody");
  let rows = overview;
  if (filter) rows = rows.filter((r) => r.coin.toUpperCase().includes(filter));
  rows = sortRows(rows);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="oi-empty">Ничего не найдено${
      filter ? ` по «${filter}»` : ""
    }</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr data-coin="${r.coin}"${r.coin === activeCoin ? ' class="active"' : ""}>
        <td>${r.coin}</td>
        <td>${fmtUsd(r.oiUsd)}</td>
        <td>${fmtPctCell(r.dOi24hPct)}</td>
        <td>${fmtPctCell(r.dOi1hPct)}</td>
        <td>${fmtPx(r.px)}</td>
        <td>${fmtPctCell(r.dPx24hPct)}</td>
        <td>${fmtFunding(r.f)}</td>
        <td class="oi-muted">${fmtUsd(r.v)}</td>
      </tr>`,
    )
    .join("");
  tbody.querySelectorAll("tr[data-coin]").forEach((tr) =>
    tr.addEventListener("click", () => selectCoin(tr.dataset.coin)),
  );
  // маркер сортировки в шапке
  document.querySelectorAll("#oi-table thead th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === sortKey);
    th.classList.toggle("asc", th.dataset.key === sortKey && sortAsc);
  });
}

document.querySelectorAll("#oi-table thead th").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (!key) return;
    if (sortKey === key) sortAsc = !sortAsc;
    else {
      sortKey = key;
      sortAsc = key === "coin"; // текст по возрастанию, числа по убыванию
    }
    renderTable();
  }),
);

document.getElementById("oi-search").addEventListener("input", (e) => {
  filter = e.target.value.trim().toUpperCase();
  renderTable();
});

// ── детализация по монете ──
async function selectCoin(coin) {
  activeCoin = coin;
  renderTable();
  const detail = document.getElementById("oi-detail");
  detail.hidden = false;
  document.getElementById("oi-detail-coin").textContent = coin;
  document.getElementById("oi-detail-sub").textContent = "загрузка…";
  document.getElementById("oi-series-body").innerHTML = "";
  const data = await fetchJson(
    `/api/oi-collector/coin?coin=${encodeURIComponent(coin)}&hours=${detailHours}`,
  );
  if (!data.ok || !data.points.length) {
    document.getElementById("oi-detail-sub").textContent = "нет истории за период";
    document.getElementById("oi-chart").innerHTML = "";
    return;
  }
  const pts = data.points;
  const first = pts[0],
    last = pts[pts.length - 1];
  const dOi = ((last.oiUsd - first.oiUsd) / first.oiUsd) * 100;
  const dPx = ((last.px - first.px) / first.px) * 100;
  document.getElementById("oi-detail-sub").innerHTML =
    `${data.rawCount} точек · OI ${fmtUsd(first.oiUsd)}→${fmtUsd(last.oiUsd)} ` +
    `(${dOi > 0 ? "+" : ""}${dOi.toFixed(1)}%) · цена ${dPx > 0 ? "+" : ""}${dPx.toFixed(1)}%`;
  drawChart(pts);
  renderSeries(pts);
}

// Dual-axis спарклайн: OI ($) синим, цена золотым. Каждая серия нормируется по
// своему min/max — сравниваем ФОРМУ (растёт OI, а цена стоит?), не абсолют.
function drawChart(pts) {
  const W = 800,
    H = 200,
    pad = 6;
  const xs = (i) => pad + (i / (pts.length - 1 || 1)) * (W - 2 * pad);
  const line = (vals, color) => {
    const mn = Math.min(...vals),
      mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const y = (v) => H - pad - ((v - mn) / rng) * (H - 2 * pad);
    const d = vals
      .map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" />`;
  };
  const svg = document.getElementById("oi-chart");
  svg.innerHTML =
    line(
      pts.map((p) => p.oiUsd),
      "#5b9dff",
    ) +
    line(
      pts.map((p) => p.px),
      "#e8b84b",
    );
}

function renderSeries(pts) {
  // Таблица — от свежих к старым, чтобы последнее было сверху.
  document.getElementById("oi-series-body").innerHTML = [...pts]
    .reverse()
    .map(
      (p) => `
      <tr>
        <td>${fmtTime(p.t)}</td>
        <td>${fmtPx(p.px)}</td>
        <td>${fmtTok(p.oi)}</td>
        <td>${fmtUsd(p.oiUsd)}</td>
        <td>${fmtFunding(p.f)}</td>
        <td class="oi-muted">${fmtUsd(p.v)}</td>
      </tr>`,
    )
    .join("");
}

document.querySelectorAll("#oi-ranges .range-btn").forEach((b) =>
  b.addEventListener("click", () => {
    document
      .querySelectorAll("#oi-ranges .range-btn")
      .forEach((r) => r.classList.remove("active"));
    b.classList.add("active");
    detailHours = Number(b.dataset.hours);
    if (activeCoin) selectCoin(activeCoin);
  }),
);

loadOverview();
