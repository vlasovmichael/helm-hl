import "./src/styles/oi.scss";
import { paintIcons } from "./src/core/icon.js";
import { emptyRow, emptyState, settle } from "./src/core/placeholders.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
// ─────────────────────────────────────────────────
//  OI — витрина истории open interest (все монеты).
//  Читает /api/oi-collector/* (данные от tools/oiCollector.mjs). Сверху —
//  сортируемая таблица-обзор по всем монетам с ΔOI 24ч/1ч; клик по монете →
//  ряд во времени (dual-axis спарклайн OI vs цена + таблица).
//  ЭТО ПОКАЗ ДАННЫХ, не сигнал — вывод про эдж требует месяца разных режимов.
// ─────────────────────────────────────────────────

import { onThemeChange } from "./src/core/shell.js";
import { fetchJson } from "./src/net/api.js";
import { drawOiChart, clearOiChart, destroyOiChart, applyOiChartTheme } from "./src/charts/oiChart.js";

// Экран жив, пока его не сменили. Ответы, приехавшие после ухода, писать
// некуда: разметки этой страницы в документе уже нет.
let alive = false;

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
// Токены с точностью под размах окна (см. тот же приём на оси графика).
function tokenDigitsFor(values) {
  const mn = Math.min(...values),
    mx = Math.max(...values);
  const unit = Math.abs(mx) >= 1e9 ? 1e9 : Math.abs(mx) >= 1e6 ? 1e6 : Math.abs(mx) >= 1e3 ? 1e3 : 1;
  const step = (mx - mn) / unit / 8; // строк в таблице больше, чем делений на оси
  return step > 0 ? Math.min(4, Math.max(1, Math.ceil(-Math.log10(step)))) : 1;
}
const fmtTokAt = (n, digits) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
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
// Медиана |фандинга| по всем монетам последнего снимка. Считается из уже
// загруженного overview — сравнивать не с чем иначе: голое «−0.2144%/ч» не
// отвечает ни на «за какой срок», ни на «это много или норма».
let fundingMedian = null;

function setFundingMedian(coins) {
  const abs = coins.map((c) => Math.abs(c.f)).filter(Number.isFinite).sort((a, b) => a - b);
  fundingMedian = abs.length ? abs[Math.floor(abs.length / 2)] : null;
}

// Множитель показываем только с 5×: на обычной монете он был бы шумом в каждой
// строке, а смысл приписки — заметить те, что стоят вразрез со всей биржей.
const RATIO_FLOOR = 5;
const RATIO_LOUD = 10;

const fmtFunding = (n) => {
  if (n == null || !Number.isFinite(n))
    return '<span class="oi-muted">—</span>';
  const cls = n > 0 ? "oi-pos" : n < 0 ? "oi-neg" : "oi-muted";
  const sign = n > 0 ? "+" : "";
  const daily = n * 100 * 24;
  const ratio = fundingMedian ? Math.abs(n) / fundingMedian : null;
  const loud = ratio != null && ratio >= RATIO_LOUD;
  // Подстрочник стоит в каждой строке, даже скучной: 233 строки с плавающей
  // высотой сканировать глазами невозможно. Но точность по величине — иначе
  // обычная монета печатает «−0.00%/d», что выглядит сломанным, а не спокойным.
  const day = Math.abs(daily) < 0.1 ? "≈0%/d" : `${daily.toFixed(1)}%/d`;
  const sub =
    ratio != null && ratio >= RATIO_FLOOR
      ? `${day} · ×${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}`
      : day;
  return (
    `<span class="${cls}">${sign}${(n * 100).toFixed(4)}%</span>` +
    `<span class="oi-sub${loud ?" oi-sub-loud" : ""}">${sub}</span>`
  );
};
// Местное время, не UTC: страницу читает человек, сверяющий её со своими
// часами. 🚨 UTC-метки читались как отставание коллектора на пару часов.
const pad2 = (n) => String(n).padStart(2, "0");
const fmtTime = (t) => {
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const TZ_LABEL = (() => {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    return z.split("/").pop().replace(/_/g, " ");
  } catch {
    return "local";
  }
})();
// «Сколько минут назад» — единственная подпись, которая не зависит от зоны и
// прямо отвечает на вопрос «данные живые или встали».
const fmtAge = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

// ── Carry (карточка 01) ──
// Спот в лонг + перп в шорт: цена гасится, остаётся фандинг. Карточка считает
// окупаемость круга комиссий по среднему фандингу за неделю, а не «сигнал».
const carryNum = (v, digits = 1) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits));
const carryDays = (v) => (v == null ? "never" : v > 365 ? ">1y" : `${v.toFixed(v < 10 ? 1 : 0)}d`);
const carryBreakEven = (r) =>
  r.dailyBp == null
    ? "—"
    : `${carryDays(r.breakEvenDaysTaker)} <span class="oi-muted">/ ${carryDays(r.breakEvenDaysMaker)}</span>`;

function carryLead(rows) {
  const best = rows.find((r) => r.breakEvenDaysTaker != null);
  if (!best) {
    return rows.some((r) => r.dailyBp != null)
      ? "No pair pays right now: average funding over the week is not positive on any hedgeable coin."
      : "Funding history did not load, so break-even is not computed yet.";
  }
  return (
    `Best now: <b>${best.coin}</b> pays <b>${carryNum(best.dailyBp, 2)} bp/day</b> on the weekly average. ` +
    `The round trip is earned back in <b>${carryDays(best.breakEvenDaysTaker)}</b> with market orders, ` +
    `<b>${carryDays(best.breakEvenDaysMaker)}</b> with post-only.`
  );
}

function carryTable(rows) {
  return `
    <div class="table-wrap"><table class="table table--compact">
      <thead><tr>
        <th>Coin</th><th class="num">Funding now, APR</th><th class="num">Week avg, APR</th>
        <th class="num col-opt">Hours paid</th><th class="num col-opt">Spot vs perp</th>
        <th class="num">Break-even</th><th class="num">Per $1k a day</th>
      </tr></thead>
      <tbody>${rows
        .map((r) => `<tr>
          <td class="strong">${r.coin}</td>
          <td class="num mono ${r.aprNow > 0 ? "up" : "down"}">${carryNum(r.aprNow)}%</td>
          <td class="num mono ${(r.aprAvg ?? 0) > 0 ? "up" : "down"}">${r.aprAvg == null ? "—" : `${carryNum(r.aprAvg)}%`}</td>
          <td class="num mono col-opt">${r.positiveShare == null ? "—" : `${Math.round(r.positiveShare * 100)}%`}</td>
          <td class="num mono col-opt">${carryNum(r.basisBp)} bp</td>
          <td class="num mono">${carryBreakEven(r)}</td>
          <td class="num mono">${r.usdPerDayPer1k == null ? "—" : `$${r.usdPerDayPer1k.toFixed(2)}`}</td>
        </tr>`)
        .join("")}</tbody>
    </table></div>`;
}

async function loadCarry() {
  const body = document.getElementById("carry-body");
  const meta = document.getElementById("carry-meta");
  let data;
  try {
    data = await fetchJson("/api/carry");
  } catch {
    data = null;
  }
  if (!alive || !body) return;
  if (!data?.ok) {
    body.innerHTML = emptyState({
      glyph: "danger",
      title: "Carry is unavailable",
      hint: data?.message || "The dashboard did not answer. Reload the page to try again.",
    });
    return;
  }
  if (meta) {
    const f = data.fees;
    meta.textContent = `fees ${f.source}: perp ${carryNum(f.perpTaker, 2)} / spot ${carryNum(f.spotTaker, 2)} bp taker`;
  }
  body.innerHTML = data.rows.length
    ? `<p class="oi-note">${carryLead(data.rows)}</p>${carryTable(data.rows)}`
    : emptyState({
        glyph: "info",
        title: "No hedgeable pair right now",
        hint: "Spot and perp prices disagree by more than 1% on every pair, so none is shown.",
      });
}

// ── состояние обзора ──
const PAGE_SIZE = 10;
let overview = [];
let sortKey = "oiUsd";
let sortAsc = false;
let filter = "";
let page = 0;
let activeCoin = null;
let detailHours = 24;

// ── обзор ──
async function loadOverview() {
  const spanEl = document.getElementById("oi-span");
  let data;
  try {
    data = await fetchJson("/api/oi-collector/overview");
  } catch (err) {
    // 🚨 Без этого catch запрос падает молча, и скелетон таблицы мигает вечно:
    // «ещё грузится» не отличить от «дашборда не отвечает».
    if (!alive) return;
    document.getElementById("oi-tbody").innerHTML = emptyRow(8, {
      glyph: "danger",
      title: "Overview did not load",
      hint: `${err.message}. Reload the page to try again.`,
    });
    spanEl.textContent = "";
    return;
  }
  if (!alive) return;
  if (!data.ok) {
    document.getElementById("oi-tbody").innerHTML = emptyRow(8, {
      glyph: "clock",
      title: "No collector data yet",
      hint: "The first snapshot appears within 15 minutes of startup.",
    });
    spanEl.textContent = "";
    return;
  }
  overview = data.coins;
  setFundingMedian(overview);
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
    tbody.innerHTML = emptyRow(8, {
      glyph: "search",
      title: filter ? `No coin matches “${filter}”` : "No coins in the snapshot",
      hint: filter ? "Clear the filter to see the full list." : "",
    });
    pager.hidden = true;
    return;
  }
  // пагинация: клампим страницу в диапазон (после фильтра список короче)
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  if (page > pages - 1) page = pages - 1;
  if (page < 0) page = 0;
  const start = page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  settle(
    tbody,
    pageRows
    .map(
      (r) => `
      <tr data-coin="${r.coin}"${r.coin === activeCoin ? ' class="active"' : ""}>
        <td class="oi-coin">#${r.coin}</td>
        <td>${fmtUsd(r.oiUsd)}</td>
        <td>${fmtPctCell(r.dOi24hPct)}</td>
        <td>${fmtPctCell(r.dOi1hPct)}</td>
        <td>${fmtPx(r.px)}</td>
        <td>${fmtPctCell(r.dPx24hPct)}</td>
        <td>${fmtFunding(r.f)}</td>
        <td class="oi-muted">${fmtUsd(r.v)}</td>
      </tr>`,
    )
      .join(""),
  );
  tbody.querySelectorAll("tr[data-coin]").forEach((tr) =>
    tr.addEventListener("click", () => selectCoin(tr.dataset.coin)),
  );
  // Маркер сортировки рисует общий `.table` (core/_table.scss): место под
  // стрелку зарезервировано у каждого заголовка, поэтому колонка не дёргается
  // при смене направления.
  document.querySelectorAll("#oi-table thead th").forEach((th) => {
    const on = th.dataset.key === sortKey;
    th.classList.add("sortable");
    th.classList.toggle("is-sorted", on);
    th.classList.toggle("is-asc", on && sortAsc);
  });
  // пейджер
  pager.hidden = pages <= 1;
  document.getElementById("oi-pg-info").textContent =
    `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} · page ${page + 1}/${pages}`;
  document.getElementById("oi-prev").disabled = page <= 0;
  document.getElementById("oi-next").disabled = page >= pages - 1;
}

// ── детализация по монете ──
async function selectCoin(coin, { scroll = true } = {}) {
  activeCoin = coin;
  renderTable();
  const detail = document.getElementById("oi-detail");
  detail.hidden = false;
  // Карточка с графиком лежит НИЖЕ таблицы, и на десятой строке она за краем
  // экрана: клик «срабатывает», а на вид не происходит ничего. Прокрутка —
  // часть ответа на клик, а не удобство. `smooth` уже включён глобально
  // (html { scroll-behavior }), поэтому системную настройку «меньше движения»
  // браузер учитывает сам.
  if (scroll) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("oi-detail-coin").textContent = coin;
  document.getElementById("oi-to-journal").href = `/journal?coin=${encodeURIComponent(coin)}`;
  const url = new URL(location.href);
  url.searchParams.set("coin", coin);
  history.replaceState(null, "", url);
  document.getElementById("oi-detail-sub").textContent = "loading…";
  document.getElementById("oi-series-body").innerHTML = "";
  const data = await fetchJson(
    `/api/oi-collector/coin?coin=${encodeURIComponent(coin)}&hours=${detailHours}`,
  );
  if (!alive) return;
  if (!data.ok || !data.points.length) {
    document.getElementById("oi-detail-sub").textContent = "no history for this range";
    clearOiChart();
    return;
  }
  const pts = data.points;
  const first = pts[0],
    last = pts[pts.length - 1];
  const dOi = ((last.oiUsd - first.oiUsd) / first.oiUsd) * 100;
  const dTok = ((last.oi - first.oi) / first.oi) * 100;
  const dPx = ((last.px - first.px) / first.px) * 100;
  const bucketH = bucketHoursFor(data.hours ?? detailHours);
  // Токены впереди долларов намеренно: долларовый OI = токены × цена, и на
  // выросшей монете он показывает приток, которого не было. Разница двух этих
  // процентов — ровно вклад цены.
  const sgn = (v) => (v > 0 ? "+" : "");
  const stale = Date.now() - last.t > 45 * 60_000;
  const fresh =
    `last ${fmtTime(last.t).slice(6)} · ` +
    `<span class="${stale ?"oi-stale" : "oi-fresh"}">${fmtAge(last.t)}</span>`;
  document.getElementById("oi-detail-sub").innerHTML =
    `${data.rawCount} points · ${fresh} · OI ${fmtTok(first.oi)}→${fmtTok(last.oi)} tokens ` +
    `(${sgn(dTok)}${dTok.toFixed(1)}%) · price ${sgn(dPx)}${dPx.toFixed(1)}% ` +
    `· <span class="oi-muted">$${""}${fmtUsd(first.oiUsd).slice(1)}→${fmtUsd(last.oiUsd).slice(1)} ` +
    `(${sgn(dOi)}${dOi.toFixed(1)}%) · table avg per ${bucketH}h</span>`;
  drawOiChart(pts);
  renderSeries(pts, bucketH);
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
  const buckets = bucketSeries(pts, bucketH);
  const digits = tokenDigitsFor(buckets.map((b) => b.oi).filter(Number.isFinite));
  document.getElementById("oi-series-body").innerHTML = buckets
    .map(
      (p) => `
      <tr>
        <td>${fmtTime(p.t)}${
          p.t + bucketH * 3600_000 > Date.now()
            ? ' <span class="oi-live" data-card="This bucket is still filling — it covers the hour that has not ended yet.">filling</span>'
            : ""
        }</td>
        <td>${fmtPx(p.px)}</td>
        <td>${fmtTokAt(p.oi, digits)}</td>
        <td>${fmtUsd(p.oiUsd)}</td>
        <td>${fmtFunding(p.f)}</td>
        <td class="oi-muted">${fmtUsd(p.v)}</td>
      </tr>`,
    )
    .join("");
}

const SKELETON_ROW = `<tr class="sk-row">${'<td><span class="sk"></span></td>'.repeat(8)}</tr>`;

function view() {
  return `
    <header id="page-header"></header>

    <section class="card" id="carry-card">
      <div class="card-header">
        <div class="card-title">Carry · hedged funding</div>
        <div class="card-tools">
          <span class="card-meta" id="carry-meta"></span>
        </div>
      </div>
      <div id="carry-body">
        <div class="sk-text">
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
        </div>
      </div>
      <p class="oi-note oi-note--sp">
        Buy the coin on spot and short the same size on the perp: the price cancels out,
        the funding the short collects stays. Only coins with a live spot market on
        Hyperliquid are listed. Break-even is the round trip of both legs divided by the
        week's average funding, market orders / post-only. <b>Funding flips</b> — a pair that
        pays today can cost tomorrow, so the week average and the share of paid hours
        matter more than the rate now.
      </p>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-title">Overview · all coins</div>
        <div class="card-tools">
          <input
            id="oi-search"
            class="field field--ticker"
            type="search"
            placeholder="Filter by coin"
            aria-label="Filter by coin"
            maxlength="12"
          />
          <span class="card-meta" id="oi-span"></span>
        </div>
      </div>
      <div class="oi-table-wrap">
        <table class="table signals-table oi-table" id="oi-table">
          <thead>
            <tr>
              <th data-key="coin">Coin</th>
              <th data-key="oiUsd" class="sorted" data-card="Dollar value of all open positions (both sides). Size of the crowd, not its direction.">OI $</th>
              <th data-key="dOi24hPct" data-card="Change in open interest over 24h. Rising = money coming in; falling = positions being closed.">ΔOI 24h</th>
              <th data-key="dOi1hPct" data-card="Same over the last hour — catches a position being built right now.">ΔOI 1h</th>
              <th data-key="px">Price</th>
              <th data-key="dPx24hPct" data-card="Price change over 24h. Read next to ΔOI: OI up with price flat is the interesting cell.">ΔPrice 24h</th>
              <th data-key="f" data-card="Hourly funding, with the daily cost below it. Positive = longs pay shorts. ×N appears when a coin runs at least 5× the exchange median — that is a real crowd imbalance, and a real cost of holding.">Funding/h</th>
              <th data-key="v" data-card="24h traded volume. On Hyperliquid OI above volume is normal — it is not an anomaly.">Volume 24h</th>
            </tr>
          </thead>
          <tbody id="oi-tbody">${SKELETON_ROW.repeat(6)}</tbody>
        </table>
      </div>
      <div class="oi-pager" id="oi-pager" hidden>
        <button class="btn btn--sm" id="oi-prev" type="button">
          <i data-icon="prev"></i>Prev
        </button>
        <span class="oi-pg-info" id="oi-pg-info"></span>
        <button class="btn btn--sm" id="oi-next" type="button">
          Next<i data-icon="next"></i>
        </button>
      </div>
    </section>

    <section class="card oi-detail" id="oi-detail" hidden>
      <div class="card-header">
        <div class="card-title">Coin history</div>
        <div class="seg" id="oi-ranges" role="group" aria-label="Range">
          <button class="seg__btn active" type="button" data-hours="24">24h</button>
          <button class="seg__btn" type="button" data-hours="72">3d</button>
          <button class="seg__btn" type="button" data-hours="168">7d</button>
          <button class="seg__btn" type="button" data-hours="720">30d</button>
        </div>
      </div>
      <div class="oi-detail-head">
        <h3 id="oi-detail-coin">—</h3>
        <span class="card-meta" id="oi-detail-sub"></span>
        <a
          class="btn btn--sm"
          id="oi-to-journal"
          href="/journal"
          data-card="Open this coin in the chart drill: levels, scenarios, stop and size"
        >
          Chart drill
        </a>
      </div>
      <div class="oi-legend">
        <span><i class="oi-legend-oi"></i> OI (tokens)</span>
        <span><i class="oi-legend-px"></i> Price</span>
      </div>
      <div class="oi-chart" id="oi-chart"></div>
      <p class="oi-note oi-note--sp">
        <b>The blue line counts tokens, not dollars.</b> OI&nbsp;$ is <b>tokens × price</b>,
        so a dollar line would carry price inside it — up 10% on price alone, with not a
        single new position. That is arithmetic, not money arriving, and it makes the two
        lines look related when they are not. Tokens carry no price, so what you see here
        is the real thing. Dollars stay in the header and the table.
      </p>
      <p class="oi-note oi-note--sp">
        <b>Two scales, on purpose:</b> OI on the right, price on the left — not comparable,
        so never one axis. Price sits behind, shaded: it is context here, not the subject.
        Hover for the exact hour and both values; times are <b>local</b>, same as the table.
        What the shape means: lines moving <b>together</b> is ordinary churn — positions
        opened and closed as price moves, no information. Lines <b>diverging</b> is the
        readable case: OI stepping up while price stalls or drops means someone built a
        position and is <b>still holding it</b>. A flat OI shelf is that position sitting
        there; when the shelf breaks down, they left. OI counts <b>both sides at once</b>,
        so it can never tell you long or short — this page shows positioning, not direction.
      </p>
      <div class="oi-table-wrap oi-series-wrap">
        <table class="table signals-table oi-table" id="oi-series">
          <thead>
            <tr>
              <th data-key="t" data-card="Your local time — the chart axis uses it too. Rows are bucket averages, so the newest row is the bucket for the hour that is still running.">Time · <span id="oi-tz">local</span></th>
              <th>Price</th>
              <th data-card="Open positions counted in coins. Price-free, so this is the honest answer to «did anyone actually build a position».">OI (tokens)</th>
              <th data-card="tokens × price. Moves when price moves, even with zero new positions — do not read a rise here as money arriving.">OI $</th>
              <th data-card="Hourly funding. Positive = longs pay shorts, negative = shorts pay longs. Anything past ±0.1%/h is a real crowd imbalance, not noise — and a real cost of holding.">Funding/h</th>
              <th>Volume 24h</th>
            </tr>
          </thead>
          <tbody id="oi-series-body"></tbody>
        </table>
      </div>
    </section>

    <footer id="footer-status">
      <span>Source: OI collector (snapshot every 15 min) · read-only</span>
    </footer>`;
}

/** Слушатели статичной разметки экрана. Живут ровно столько же, сколько она. */
function bindControls() {
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

  document.querySelectorAll("#oi-ranges .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      document
        .querySelectorAll("#oi-ranges .seg__btn")
        .forEach((r) => r.classList.remove("active"));
      b.classList.add("active");
      detailHours = Number(b.dataset.hours);
      // Смена диапазона — не переход к графику: он уже перед глазами.
      if (activeCoin) selectCoin(activeCoin, { scroll: false });
    }),
  );
}

export default {
  title: "OI · Helm",
  nav: "oi",

  render(outlet) {
    alive = true;
    overview = [];
    activeCoin = null;
    filter = "";
    page = 0;
    sortKey = "oiUsd";
    sortAsc = false;
    detailHours = 24;

    outlet.innerHTML = view();
    mountPageHeader({
      eyebrow: "Open Interest",
      title: "OI history · all coins",
      note:
        "Long-term OI snapshot (HL has no historical API). Rising OI on a flat price = leverage building up. <b>This is data, not a signal.</b>",
    });
    bindControls();

    // Подпись зоны в шапке таблицы: без неё «14:00» не отличить от UTC-метки.
    document.getElementById("oi-tz").textContent = TZ_LABEL;
    // <i data-icon="…"> в статической разметке → настоящие svg.
    paintIcons();

    const offTheme = onThemeChange(applyOiChartTheme);

    loadCarry();
    // ?coin= приходит со Screen: история этой монеты открывается сразу.
    const linkedCoin = new URLSearchParams(location.search).get("coin");
    loadOverview().then(() => {
      if (alive && linkedCoin) selectCoin(linkedCoin);
    });

    return () => {
      alive = false;
      offTheme();
      destroyOiChart();
    };
  },
};
