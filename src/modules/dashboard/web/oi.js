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

// ── Setup Scanner radar (карточка 01) ──
// Данные из /api/scanner (score-логика на бэке). Радар, не сигнал.
const SS_CLS = { hit: "oi-pos", miss: "oi-muted", warm: "ss-warm" };
const ssCell = (c) =>
  `<span class="${SS_CLS[c.cls] || "oi-muted"}">${c.text}</span>`;
const ssScoreCls = (n) => (n >= 3 ? "ss-s3" : n === 2 ? "ss-s2" : "ss-s0");
const ssDots = (n) => "●".repeat(n) + "○".repeat(Math.max(0, 4 - n));

function renderScannerHero(top) {
  const hero = document.getElementById("ss-hero");
  if (!top) {
    hero.innerHTML =
      '<div class="oi-muted">Нет заряженных сетапов (score ≥ 1) прямо сейчас.</div>';
    return;
  }
  const isLong = top.dir === "LONG";
  const arrow = isLong ? "▲" : top.dir === "SHORT" ? "▼" : "■";
  const dirCls = isLong ? "oi-pos" : top.dir === "SHORT" ? "oi-neg" : "oi-muted";
  const sub =
    `funding ${top.funding != null ? `${Math.round(top.funding)}%APR` : "—"} · ` +
    `basis ${top.basis != null ? `${(top.basis * 100).toFixed(2)}%` : "—"} · ` +
    `vol ${top.vol != null ? `${top.vol.toFixed(1)}x` : "—"}`;
  hero.innerHTML =
    `<div class="ss-label">Top setup — score ${top.score}/4 <span class="ss-dots">${ssDots(top.score)}</span></div>` +
    `<div class="ss-dir ${dirCls}">${arrow} ${top.dir || "WAIT"} · #${top.coin}</div>` +
    `<div class="ss-sub">${sub}</div>`;
}

async function loadScanner() {
  const tbody = document.getElementById("ss-tbody");
  const meta = document.getElementById("ss-meta");
  let data;
  try {
    data = await fetchJson("/api/scanner");
  } catch {
    tbody.innerHTML =
      '<tr><td colspan="7" class="oi-empty">Scanner unavailable.</td></tr>';
    meta.textContent = "";
    return;
  }
  if (data.error || !Array.isArray(data.rows)) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="oi-empty">No snapshot data yet.</td></tr>';
    meta.textContent = "";
    return;
  }
  meta.textContent =
    `${data.coins} coins · span ${data.dataSpanHours.toFixed(0)}h` +
    (data.updatedAgoSec != null ? ` · updated ${data.updatedAgoSec}s ago` : "");
  renderScannerHero(data.top);
  tbody.innerHTML = data.rows.length
    ? data.rows
        .map(
          (r) => `
      <tr>
        <td>${r.coin}</td>
        <td class="ss-scorecell ${ssScoreCls(r.score)}">${r.score}</td>
        <td>${ssCell(r.funding)}</td>
        <td>${ssCell(r.oiRamp)}</td>
        <td>${ssCell(r.basis)}</td>
        <td>${ssCell(r.vol)}</td>
        <td class="oi-muted">${r.vlm}</td>
      </tr>`,
        )
        .join("")
    : '<tr><td colspan="7" class="oi-empty">No coins.</td></tr>';
}

// ── состояние обзора ──
const PAGE_SIZE = 10;
let overview = [];
let sortKey = "oiUsd";
let sortAsc = false;
let filter = "";
let page = 0;
let activeCoin = null;
let detailHours = 72;

// ── обзор ──
async function loadOverview() {
  const data = await fetchJson("/api/oi-collector/overview");
  const spanEl = document.getElementById("oi-span");
  if (!data.ok) {
    document.getElementById("oi-tbody").innerHTML =
      '<tr><td colspan="8" class="oi-empty">No collector data yet. The first snapshot appears within 15 minutes of startup.</td></tr>';
    spanEl.textContent = "";
    return;
  }
  overview = data.coins;
  const s = data.span;
  const dur = ((s.lastT - s.firstT) / 3600_000).toFixed(0);
  spanEl.textContent = `${data.coins.length} coins · ${s.count} snapshots · ~${dur}h history${
    data.has24h ? "" : " · Δ24h still partial"
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
  const pager = document.getElementById("oi-pager");
  let rows = overview;
  if (filter) rows = rows.filter((r) => r.coin.toUpperCase().includes(filter));
  rows = sortRows(rows);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="oi-empty">Nothing found${
      filter ? ` for “${filter}”` : ""
    }</td></tr>`;
    pager.hidden = true;
    return;
  }
  // пагинация: клампим страницу в диапазон (после фильтра список короче)
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  if (page > pages - 1) page = pages - 1;
  if (page < 0) page = 0;
  const start = page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  tbody.innerHTML = pageRows
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
  // пейджер
  pager.hidden = pages <= 1;
  document.getElementById("oi-pg-info").textContent =
    `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} · page ${page + 1}/${pages}`;
  document.getElementById("oi-prev").disabled = page <= 0;
  document.getElementById("oi-next").disabled = page >= pages - 1;
}

document.getElementById("oi-prev").addEventListener("click", () => {
  if (page > 0) {
    page--;
    renderTable();
  }
});
document.getElementById("oi-next").addEventListener("click", () => {
  page++;
  renderTable();
});

document.querySelectorAll("#oi-table thead th").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (!key) return;
    if (sortKey === key) sortAsc = !sortAsc;
    else {
      sortKey = key;
      sortAsc = key === "coin"; // текст по возрастанию, числа по убыванию
    }
    page = 0;
    renderTable();
  }),
);

document.getElementById("oi-search").addEventListener("input", (e) => {
  filter = e.target.value.trim().toUpperCase();
  page = 0;
  renderTable();
});

// ── детализация по монете ──
async function selectCoin(coin) {
  activeCoin = coin;
  renderTable();
  const detail = document.getElementById("oi-detail");
  detail.hidden = false;
  document.getElementById("oi-detail-coin").textContent = coin;
  document.getElementById("oi-detail-sub").textContent = "loading…";
  document.getElementById("oi-series-body").innerHTML = "";
  const data = await fetchJson(
    `/api/oi-collector/coin?coin=${encodeURIComponent(coin)}&hours=${detailHours}`,
  );
  if (!data.ok || !data.points.length) {
    document.getElementById("oi-detail-sub").textContent = "no history for this range";
    document.getElementById("oi-chart").innerHTML = "";
    return;
  }
  const pts = data.points;
  const first = pts[0],
    last = pts[pts.length - 1];
  const dOi = ((last.oiUsd - first.oiUsd) / first.oiUsd) * 100;
  const dPx = ((last.px - first.px) / first.px) * 100;
  const bucketH = bucketHoursFor(data.hours ?? detailHours);
  document.getElementById("oi-detail-sub").innerHTML =
    `${data.rawCount} points · OI ${fmtUsd(first.oiUsd)}→${fmtUsd(last.oiUsd)} ` +
    `(${dOi > 0 ? "+" : ""}${dOi.toFixed(1)}%) · price ${dPx > 0 ? "+" : ""}${dPx.toFixed(1)}% ` +
    `· <span class="oi-muted">table avg per ${bucketH}h</span>`;
  drawChart(pts);
  renderSeries(pts, bucketH);
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

// Размер бакета таблицы: ~24 строки на любой диапазон, снап к «красивым» часам.
function bucketHoursFor(hours) {
  const nice = [1, 2, 3, 4, 6, 8, 12, 24];
  const target = hours / 24; // часов на бакет, чтобы вышло ~24 строки
  return nice.find((n) => n >= target) ?? 24;
}

// Усредняет ряд по бакетам bucketH часов (px/oi/oiUsd/funding/vol — среднее),
// метка бакета = его начало. Таблица не тонет: 15-мин снимки → ~24 строки.
function bucketSeries(pts, bucketH) {
  const bms = bucketH * 3600_000;
  const map = new Map();
  for (const p of pts) {
    const key = Math.floor(p.t / bms) * bms;
    let b = map.get(key);
    if (!b) {
      b = { t: key, px: 0, oi: 0, oiUsd: 0, f: 0, v: 0, n: 0 };
      map.set(key, b);
    }
    b.px += p.px;
    b.oi += p.oi;
    b.oiUsd += p.oiUsd;
    b.f += p.f ?? 0;
    b.v += p.v ?? 0;
    b.n++;
  }
  return [...map.values()]
    .map((b) => ({
      t: b.t,
      px: b.px / b.n,
      oi: b.oi / b.n,
      oiUsd: b.oiUsd / b.n,
      f: b.f / b.n,
      v: b.v / b.n,
    }))
    .sort((a, b) => b.t - a.t); // от свежих к старым
}

function renderSeries(pts, bucketH) {
  document.getElementById("oi-series-body").innerHTML = bucketSeries(pts, bucketH)
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

loadScanner();
loadOverview();
