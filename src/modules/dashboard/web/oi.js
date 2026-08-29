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

// ── Нянька (карточка 01) ──
// Панель ведения ОТКРЫТЫХ позиций из /api/position-nanny. Пришла на смену
// «Монете дня» 29.08.2026: та искала входы и на двух замерах дала ноль при
// сломанной конструкции (реплей n=103 → −0.046R, цель достигнута 1 раз).
// Здесь нет ни скоринга, ни предсказаний — только факт о позиции и её плане.
const nanPx = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};
const nanPct = (n, digits = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
const nanSigned = (n, digits = 2) => {
  if (n == null || !Number.isFinite(n)) return '<span class="oi-muted">—</span>';
  return `<span class="${n > 0 ? "oi-pos" : n < 0 ? "oi-neg" : "oi-muted"}">${nanPct(n, digits)}</span>`;
};
// Знак ПЕРЕД долларом: иначе минус уезжает внутрь ($-1.20).
const nanUsd = (n, digits = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(digits)}`;
const nanUsdSigned = (n) => {
  if (n == null || !Number.isFinite(n)) return '<span class="oi-muted">—</span>';
  return `<span class="${n > 0 ? "oi-pos" : n < 0 ? "oi-neg" : "oi-muted"}">${n > 0 ? "+" : ""}${nanUsd(n)}</span>`;
};

const NAN_STATUS = {
  unprotected:    "unprotected",
  orders_unknown: "orders_unknown",
  stop_only:      "stop_only",
  armed:          "armed",
};

/**
 * Шкала стоп → вход → цена → цель. Масштаб линейный по цене, поэтому длина
 * плеч честно показывает, что до чего ближе — ради этого она и рисуется.
 * Без стопа или без цели шкала не строится: половина шкалы врала бы о риске.
 */
function nanScale(p) {
  const pl = p.plan;
  const pos = p.position;
  if (pl.stop == null || pl.target == null) return "";
  const lo = Math.min(pl.stop, pl.target);
  const hi = Math.max(pl.stop, pl.target);
  const span = hi - lo;
  if (!(span > 0)) return "";
  const at = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const isShort = p.side === "SHORT";
  const entryAt = at(pos.entryPx);
  const priceAt = at(pos.price);
  // Заливка от входа до цены: зелёная, если сделка в плюсе.
  const good = isShort ? pos.price < pos.entryPx : pos.price > pos.entryPx;
  const from = Math.min(entryAt, priceAt);
  const width = Math.abs(priceAt - entryAt);
  const label = (v, name, px) =>
    `<span class="nan-tick" style="left:${at(v)}%"><b>${name}</b>${nanPx(px)}</span>`;
  return `
    <div class="nan-scale">
      <div class="nan-bar">
        <div class="nan-bar-fill ${good ? "pos" : "neg"}" style="left:${from}%;width:${width}%"></div>
        <div class="nan-mark entry" style="left:${entryAt}%"></div>
        <div class="nan-mark" style="left:${priceAt}%"></div>
        ${label(pl.stop, "стоп", pl.stop)}
        ${label(pl.target, "цель", pl.target)}
      </div>
      <div class="nan-scale-pad"></div>
    </div>`;
}

function nanRenderPosition(p) {
  const pos = p.position;
  const pl = p.plan;
  const st = NAN_STATUS[p.status] || "armed";

  const posRows = `
    <tr><td>Твой вход</td><td>${nanPx(pos.entryPx)}</td></tr>
    <tr><td>Сейчас</td><td>${nanPx(pos.price)} · ${nanSigned(pos.gainPct)}</td></tr>
    <tr><td>Объём позиции</td><td>${nanUsd(pos.notionalUsd)}</td></tr>
    <tr class="nan-strong"><td>Нереализованный</td><td>${nanUsdSigned(pos.unrealizedPnl)}</td></tr>`;

  // Риск в долларах стоит первым: это единственное число, которое напрямую
  // отвечает на вопрос «сколько я теряю, если ошибся».
  const planRows = `
    <tr class="nan-strong"><td>Риск до стопа</td><td>${
      pl.riskUsd == null
        ? '<span class="oi-neg">не ограничен</span>'
        : `<span class="oi-neg">-$${pl.riskUsd.toFixed(2)}</span>`
    }</td></tr>
    <tr><td>Стоп</td><td>${
      pl.stop == null
        ? '<span class="oi-neg">нет</span>'
        : `${nanPx(pl.stop)}${pl.toStopPct == null ? "" : ` · ${pl.toStopPct.toFixed(2)}% отсюда`}`
    }</td></tr>
    <tr><td>Цель</td><td>${
      pl.target == null
        ? '<span class="oi-muted">нет</span>'
        : `${nanPx(pl.target)}${pl.toTargetPct == null ? "" : ` · ${pl.toTargetPct.toFixed(2)}% отсюда`}`
    }</td></tr>
    <tr><td>Отдача до цели</td><td>${pl.rewardUsd == null ? "—" : `+$${pl.rewardUsd.toFixed(2)}`}</td></tr>
    <tr><td>R:R плана</td><td>${
      pl.rr == null ? "—" : `<span class="${pl.rr >= 1.5 ? "oi-pos" : "oi-neg"}">${pl.rr.toFixed(2)}</span>`
    }</td></tr>
    <tr><td>Сейчас в R</td><td>${
      pl.stopLocksProfit
        ? '<span class="oi-pos">стоп в прибыли</span>'
        : pl.rNow == null
          ? "—"
          : `<span class="${pl.rNow >= 0 ? "oi-pos" : "oi-neg"}">${pl.rNow >= 0 ? "+" : ""}${pl.rNow.toFixed(2)}R</span>`
    }</td></tr>
    <tr><td>Пройдено до цели</td><td>${pl.progressPct == null ? "—" : `${pl.progressPct.toFixed(0)}%`}</td></tr>`;

  const notes = (p.notes || []).length
    ? `<ul class="nan-notes">${p.notes
        .map((t) => `<li class="${/НЕТ|без защиты|не ограничен|одна свеча/.test(t) ? "warn" : ""}">${t}</li>`)
        .join("")}</ul>`
    : "";

  return `
    <div class="nan-pos nan-pos--${st}">
      <div class="nan-head">
        <span class="nan-coin">${p.coin}</span>
        <span class="nan-side ${p.side === "SHORT" ? "short" : "long"}">${p.side}</span>
        <span class="nan-status ${st}">${p.headline}</span>
      </div>
      <p class="nan-detail">${p.detail}</p>
      ${nanScale(p)}
      <div class="nan-grid">
        <div>
          <p class="nan-sub">Твоя позиция</p>
          <table class="nan-t">${posRows}</table>
        </div>
        <div>
          <p class="nan-sub">План на бирже</p>
          <table class="nan-t">${planRows}</table>
        </div>
      </div>
      ${notes}
    </div>`;
}

function nanRenderTotals(t) {
  if (!t || !t.count) return "";
  const risk =
    t.riskUsd == null
      ? '<span class="oi-muted">—</span>'
      : `<span class="oi-neg">-$${Math.abs(t.riskUsd).toFixed(2)}</span>`;
  const unp = t.unprotected
    ? `<span class="oi-neg">${t.unprotected}</span>`
    : '<span class="oi-pos">0</span>';
  return `
    <div class="nan-totals">
      <span><span class="nan-total-k">Позиций</span><span class="nan-total-v">${t.count}</span></span>
      <span><span class="nan-total-k">Объём</span><span class="nan-total-v">$${t.notionalUsd.toFixed(2)}</span></span>
      <span><span class="nan-total-k">Риск, если сработают все стопы</span><span class="nan-total-v">${risk}</span></span>
      <span><span class="nan-total-k">Без стопа</span><span class="nan-total-v">${unp}</span></span>
    </div>`;
}

async function loadNanny(force = false) {
  const meta = document.getElementById("nan-meta");
  const body = document.getElementById("nan-body");
  meta.textContent = "чтение…";
  try {
    const data = await fetchJson(`/api/position-nanny${force ? "?refresh=1" : ""}`);
    if (data.error) throw new Error(data.error);
    const age = data.cached ? ` · из кэша ${data.ageSec}с` : "";
    const list = data.positions || [];
    meta.textContent = `${list.length} ${list.length === 1 ? "позиция" : "позиций"}${age}`;
    if (!list.length) {
      body.innerHTML =
        '<div class="nan-empty">Открытых позиций нет — вести нечего.</div>';
      return;
    }
    body.innerHTML = nanRenderTotals(data.totals) + list.map(nanRenderPosition).join("");
  } catch (err) {
    meta.textContent = "ошибка";
    body.innerHTML = `<div class="nan-empty">Не удалось прочитать позиции: ${err.message}</div>`;
  }
}

document.getElementById("nan-refresh").addEventListener("click", () => loadNanny(true));

// ── Setup Scanner radar (карточка 02) ──
// Данные из /api/scanner (score-логика на бэке). Радар, не сигнал.
const SS_CLS = { hit: "oi-pos", miss: "oi-muted", warm: "ss-warm" };
const ssCell = (c) =>
  `<span class="${SS_CLS[c.cls] || "oi-muted"}">${c.text}</span>`;
const ssScoreCls = (n) => (n >= 3 ? "ss-s3" : n === 2 ? "ss-s2" : "ss-s0");
const ssSegs = (n) =>
  Array.from({ length: 4 }, (_, i) => `<span class="ss-seg${i < n ? " on" : ""}"></span>`).join("");

function renderScannerHero(top) {
  const hero = document.getElementById("ss-hero");
  if (!top) {
    hero.className = "ss-hero ss-hero--none";
    hero.innerHTML =
      '<div class="ss-hero-empty">Нет сетапов со score ≥ 1 прямо сейчас — радар пуст.</div>';
    return;
  }
  const side = top.dir === "LONG" ? "long" : top.dir === "SHORT" ? "short" : "none";
  const arrow = side === "long" ? "▲" : side === "short" ? "▼" : "■";
  const stat = (k, v) =>
    `<div class="ss-stat"><span class="ss-stat-k">${k}</span><span class="ss-stat-v">${v}</span></div>`;
  hero.className = `ss-hero ss-hero--${side}`;
  hero.innerHTML =
    `<div class="ss-hero-main">
       <div class="ss-hero-eyebrow">Top setup <span class="ss-segs">${ssSegs(top.score)}</span> ${top.score}/4</div>
       <div class="ss-hero-headline">
         <span class="ss-badge ss-badge--${side}">${arrow} ${top.dir || "WAIT"}</span>
         <span class="ss-coin">${top.coin}</span>
       </div>
     </div>
     <div class="ss-hero-stats">
       ${stat("funding", top.funding != null ? `${top.funding >= 0 ? "+" : ""}${Math.round(top.funding)}%` : "—")}
       ${stat("basis", top.basis != null ? `${top.basis >= 0 ? "+" : ""}${(top.basis * 100).toFixed(2)}%` : "—")}
       ${stat("vol", top.vol != null ? `${top.vol.toFixed(1)}x` : "—")}
     </div>`;
}

// Score 0 = ничего не сошлось (шум радара) → по умолчанию прячем, тумблер вернёт.
let ssRows = [];
let ssShowZero = false;

function rowHtml(r) {
  return `
      <tr>
        <td>${r.coin}</td>
        <td class="ss-scorecell ${ssScoreCls(r.score)}">${r.score}</td>
        <td>${ssCell(r.funding)}</td>
        <td>${ssCell(r.oiRamp)}</td>
        <td>${ssCell(r.basis)}</td>
        <td>${ssCell(r.vol)}</td>
        <td class="oi-muted">${r.vlm}</td>
      </tr>`;
}

function renderScannerRows() {
  const tbody = document.getElementById("ss-tbody");
  const shown = ssShowZero ? ssRows : ssRows.filter((r) => r.score > 0);
  const hidden = ssRows.length - shown.length;
  if (!shown.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="oi-empty">${
      ssRows.length ? "Нет сетапов со score ≥ 1 (всё score 0)." : "No coins."
    }</td></tr>`;
    return;
  }
  let html = shown.map(rowHtml).join("");
  if (!ssShowZero && hidden > 0) {
    html += `<tr><td colspan="7" class="oi-muted" style="text-align:center;padding:10px">
      + ${hidden} монет со score 0 скрыто · <span style="text-decoration:underline;cursor:pointer" id="ss-showzero-link">показать все</span></td></tr>`;
  }
  tbody.innerHTML = html;
  const link = document.getElementById("ss-showzero-link");
  if (link)
    link.addEventListener("click", () => {
      ssShowZero = true;
      document.getElementById("ss-showzero").checked = true;
      renderScannerRows();
    });
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
  ssRows = data.rows;
  renderScannerRows();
}

document.getElementById("ss-showzero").addEventListener("change", (e) => {
  ssShowZero = e.target.checked;
  renderScannerRows();
});

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

loadNanny();
loadScanner();
loadOverview();
