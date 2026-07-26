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

// ── Монета дня (карточка 01) ──
// Разбор сетапа «выдохшийся хвост» из /api/coin-of-day. Табы = монеты, прошедшие
// порог score. Карточка обязана показывать не только «за», но и «против» —
// блок флагов не сворачивается и не прячется.
const codFmtPx = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};
const codPct = (n, digits = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
const codSigned = (n, digits = 2) => {
  if (n == null || !Number.isFinite(n)) return '<span class="oi-muted">—</span>';
  return `<span class="${n > 0 ? "oi-pos" : n < 0 ? "oi-neg" : "oi-muted"}">${codPct(n, digits)}</span>`;
};

const COD_HIT_LABEL = {
  move: "Ход за 24ч ≥ 8%",
  edge: "Упёрлась в край диапазона 72ч",
  rollover: "Импульс 4ч уже развернулся",
  structure: "Структура 15м сломана (3+ ноги)",
  volDecay: "Объём распался (≤ 40% пика)",
  notCrowded: "OI не перегрет (памп не на плече)",
};

let codData = null;
let codActive = null;

// Все табы = сначала монеты в позиции (их вести важнее, чем искать новый вход),
// потом кандидаты на вход.
const codAllTabs = () => [...(codData?.held ?? []), ...(codData?.picks ?? [])];

function codRenderTabs() {
  const el = document.getElementById("cod-tabs");
  const tabs = codAllTabs();
  if (tabs.length < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = tabs
    .map(
      (p) => `<button type="button" class="cod-tab${p.coin === codActive ? " active" : ""}${p.held ? " cod-tab--held" : ""}" data-coin="${p.coin}">
        ${p.held ? '<span class="cod-tab-held">в позиции</span>' : ""}
        <span class="cod-tab-coin">${p.coin}</span>
        <span class="cod-tab-side ${p.side.toLowerCase()}">${p.side}</span>
        <span class="oi-muted">${p.score == null ? "—" : `${p.score}/6`}</span>
      </button>`,
    )
    .join("");
  el.querySelectorAll(".cod-tab").forEach((b) =>
    b.addEventListener("click", () => {
      codActive = b.dataset.coin;
      codRenderTabs();
      codRenderBody();
    }),
  );
}

const COD_STATUS = {
  thesis_intact:      { cls: "setup", label: "тезис в силе" },
  thesis_weakened:    { cls: "watch", label: "тезис ослаб" },
  thesis_faded:       { cls: "watch", label: "сетап растворился" },
  thesis_invalidated: { cls: "none",  label: "стоп плана пробит" },
  target_reached:     { cls: "setup", label: "цель достигнута" },
  wrong_side:         { cls: "none",  label: "позиция против разбора" },
};

/** Разбор монеты, в которой оператор сидит: ведение позиции, а не вход. */
function codRenderHeld(p) {
  const st = COD_STATUS[p.status] || { cls: "watch", label: p.status };
  const pos = p.position;
  const f = p.features;
  const pl = p.plan;

  const posRows = `
    <tr><td>Твой вход</td><td>${codFmtPx(pos.entryPx)}</td></tr>
    <tr><td>Сейчас</td><td>${codSigned(pos.gainPct)}</td></tr>
    <tr><td>Объём позиции</td><td>${fmtUsd(pos.notionalUsd)}</td></tr>
    <tr><td>Нереализованный</td><td>${pos.unrealizedPnl >= 0 ? "+" : ""}$${pos.unrealizedPnl.toFixed(2)}</td></tr>`;

  const planRows = pl
    ? `
    <tr><td>Вход по плану</td><td>${codFmtPx(pl.entry)}</td></tr>
    <tr><td>Стоп плана</td><td>${codFmtPx(pl.stop)} · ${pl.toStopPct.toFixed(2)}% отсюда</td></tr>
    <tr><td>Цель плана</td><td>${codFmtPx(pl.target)} · ${pl.toTargetPct.toFixed(2)}% отсюда</td></tr>
    <tr><td>Сейчас в R</td><td class="${pl.rNow >= 0 ? "cod-rr-ok" : "cod-rr-bad"}">${pl.rNow == null ? "—" : `${pl.rNow >= 0 ? "+" : ""}${pl.rNow.toFixed(2)}R`}</td></tr>
    <tr><td>Пройдено до цели</td><td>${pl.progressPct == null ? "—" : `${pl.progressPct.toFixed(0)}%`}</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">Вход был не по карточке — плана для сверки нет</td></tr>`;

  const factRows = f
    ? `
    <tr><td>Ход 24ч</td><td>${codSigned(f.chg24h, 1)}</td></tr>
    <tr><td>Последние 4ч</td><td>${codSigned(f.chg4h)}</td></tr>
    <tr><td>Позиция в диапазоне 72ч</td><td>${(f.rangePos * 100).toFixed(0)}%</td></tr>
    <tr><td>Структура 15м</td><td>${f.structLegs} ${p.side === "SHORT" ? "lower-high" : "higher-low"}</td></tr>
    <tr><td>Объём сейчас / пик</td><td>${f.volDecay == null ? "—" : `${(f.volDecay * 100).toFixed(0)}%`}</td></tr>
    <tr><td>Тренд 1ч</td><td>${f.trend1h === "up" ? "↑ вверх" : f.trend1h === "down" ? "↓ вниз" : "→ боковик"}</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">Монета больше не проходит входной фильтр</td></tr>`;

  const notes = (p.notes || []).concat((p.flags || []).map((x) => x.text));

  return `
    <div class="cod-head">
      <div class="cod-head-main">
        <span class="cod-heldbadge">в позиции</span>
        <span class="ss-badge ss-badge--${p.side.toLowerCase()}">${p.side === "SHORT" ? "▼" : "▲"} ${p.side}</span>
        <span class="ss-coin">${p.coin}</span>
      </div>
      <div class="cod-verdict ${st.cls}">${p.headline}</div>
    </div>
    <p class="cod-detail">${p.detail}</p>
    <div class="cod-grid" style="margin-top:16px">
      <div>
        <p class="cod-sub">Твоя позиция</p>
        <table class="cod-t">${posRows}</table>
      </div>
      <div>
        <p class="cod-sub">План, с которым заходили</p>
        <table class="cod-t cod-levels">${planRows}</table>
      </div>
      <div>
        <p class="cod-sub">Что с монетой сейчас</p>
        <table class="cod-t">${factRows}</table>
        ${
          notes.length
            ? `<p class="cod-sub" style="margin-top:16px">На что смотреть</p>
               <ul class="cod-flags">${notes.map((t) => `<li class="med">${t}</li>`).join("")}</ul>`
            : ""
        }
      </div>
    </div>
    <p class="cod-detail" style="margin-top:14px">
      Новый вход по этой монете карточка не считает намеренно: предлагать долив
      в открытую позицию — это генератор усреднения.
    </p>`;
}

function codRenderBody() {
  const body = document.getElementById("cod-body");
  const tabs = codAllTabs();
  if (!tabs.length) {
    const others = codData?.others?.length ?? 0;
    body.innerHTML = `<div class="cod-empty">
      Сегодня сетапа нет — ни одна монета не набрала ${codData?.thresholds?.SHOW_MIN_SCORE ?? 4}/6.
      ${others ? `Разобрано кандидатов: ${others}, всем чего-то не хватило.` : ""}
      <br />Пропустить день — это тоже решение.
    </div>`;
    return;
  }
  const p = tabs.find((x) => x.coin === codActive) || tabs[0];
  codActive = p.coin;
  if (p.held) {
    body.innerHTML = codRenderHeld(p);
    return;
  }
  const f = p.features;
  const l = p.levels;
  const rrOk = l && l.rr >= (codData?.thresholds?.MIN_RR ?? 1.5);

  const hitRows = Object.entries(COD_HIT_LABEL)
    .map(
      ([k, label]) =>
        `<tr><td class="${p.hits[k] ? "cod-hit" : "cod-miss"}">${label}</td><td>${p.hits[k] ? "да" : "нет"}</td></tr>`,
    )
    .join("");

  const factRows = `
    <tr><td>Цена</td><td>${codFmtPx(f.price)}</td></tr>
    <tr><td>Ход 24ч / 48ч</td><td>${codSigned(f.chg24h, 1)} / ${codSigned(f.chg48h, 1)}</td></tr>
    <tr><td>Последние 4ч</td><td>${codSigned(f.chg4h)}</td></tr>
    <tr><td>Позиция в диапазоне 72ч</td><td>${(f.rangePos * 100).toFixed(0)}%</td></tr>
    <tr><td>Диапазон 72ч</td><td>${codFmtPx(f.lo72)} — ${codFmtPx(f.hi72)}</td></tr>
    <tr><td>Структура 15м</td><td>${f.structLegs} ${p.side === "SHORT" ? "lower-high" : "higher-low"}</td></tr>
    <tr><td>Объём сейчас / пик</td><td>${f.volDecay == null ? "—" : `${(f.volDecay * 100).toFixed(0)}%`}</td></tr>
    <tr><td>ATR(1ч) · ER(24ч)</td><td>${f.atr1hPct == null ? "—" : `${f.atr1hPct.toFixed(2)}%`} · ${f.er24 == null ? "—" : f.er24.toFixed(2)}</td></tr>
    <tr><td>OI / оборот 24ч</td><td>${fmtUsd(f.oiUsd)} / ${fmtUsd(f.volume24hUsd)}${f.oiVolRatio != null ? ` (${f.oiVolRatio.toFixed(2)}×)` : ""}</td></tr>
    <tr><td>Фандинг APR</td><td>${f.fundingApr == null ? "—" : `${f.fundingApr >= 0 ? "+" : ""}${f.fundingApr.toFixed(0)}%`}</td></tr>
    <tr><td>Тренд 1ч</td><td>${f.trend1h === "up" ? "↑ вверх" : f.trend1h === "down" ? "↓ вниз" : "→ боковик"}</td></tr>`;

  const levelRows = l
    ? `
    <tr><td>Вход</td><td>${codFmtPx(l.entry)}</td></tr>
    <tr><td>Стоп <span class="oi-muted">(ставить ДО входа)</span></td><td>${codFmtPx(l.stop)} · ${l.riskPct.toFixed(2)}%</td></tr>
    <tr><td>Цель${l.targetProjected ? ' <span class="oi-muted">(проекция)</span>' : ""}</td><td>${codFmtPx(l.target)} · ${l.rewardPct.toFixed(2)}%</td></tr>
    ${l.farTarget ? `<tr><td>Дальний уровень <span class="oi-muted">(остаток)</span></td><td>${codFmtPx(l.farTarget)}</td></tr>` : ""}
    <tr><td>R:R</td><td class="${rrOk ? "cod-rr-ok" : "cod-rr-bad"}">${l.rr.toFixed(2)}</td></tr>
    <tr><td>Time-stop</td><td>${l.timeStopMin} мин</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">Уровни не построены</td></tr>`;

  const flags = p.flags.length
    ? `<ul class="cod-flags">${p.flags.map((fl) => `<li class="${fl.severity}">${fl.text}</li>`).join("")}</ul>`
    : `<p class="cod-detail">Явных красных флагов движок не нашёл — что не делает сетап безопасным.</p>`;

  body.innerHTML = `
    <div class="cod-head">
      <div class="cod-head-main">
        <span class="ss-badge ss-badge--${p.side.toLowerCase()}">${p.side === "SHORT" ? "▼" : "▲"} ${p.side}</span>
        <span class="ss-coin">${p.coin}</span>
        <span class="ss-segs">${Array.from({ length: 6 }, (_, i) => `<span class="ss-seg${i < p.score ? " on" : ""}"></span>`).join("")}</span>
      </div>
      <div class="cod-verdict ${p.verdict.tone}">${p.verdict.headline}</div>
    </div>
    <p class="cod-detail">${p.verdict.detail}</p>
    <div class="cod-grid" style="margin-top:16px">
      <div>
        <p class="cod-sub">Что сошлось · ${p.score}/6</p>
        <table class="cod-t">${hitRows}</table>
      </div>
      <div>
        <p class="cod-sub">Цифры</p>
        <table class="cod-t">${factRows}</table>
      </div>
      <div>
        <p class="cod-sub">План сделки</p>
        <table class="cod-t cod-levels">${levelRows}</table>
        <p class="cod-sub" style="margin-top:16px">Что против</p>
        ${flags}
      </div>
    </div>`;
}

function codRenderForward() {
  const el = document.getElementById("cod-fwd");
  const fw = codData?.forward;
  if (!fw) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!fw.closed) {
    el.innerHTML = `<b>Форвард-лог:</b> записано пиков — <b>${fw.total}</b>, из них открыто <b>${fw.open}</b>,
      закрытых пока нет. Пока не наберётся 20 закрытых, карточка ничего не доказывает.`;
    return;
  }
  const verdict = fw.enoughForVerdict
    ? ""
    : ` <span class="oi-neg">n = ${fw.closed} &lt; 20 — выводов об эдже НЕТ, это ещё шум.</span>`;
  el.innerHTML = `<b>Форвард-лог:</b> закрыто <b>${fw.closed}</b> пиков (открыто ${fw.open}) ·
    винрейт <b>${fw.winRate.toFixed(0)}%</b> ·
    сумма <b>${fw.sumR >= 0 ? "+" : ""}${fw.sumR.toFixed(2)}R</b> ·
    ожидание <b>${fw.expR >= 0 ? "+" : ""}${fw.expR.toFixed(2)}R</b> на пик ·
    цель/стоп/таймаут = ${fw.byStatus.target}/${fw.byStatus.stop}/${fw.byStatus.timeout} ·
    средний MFE ${fw.avgMfePct == null ? "—" : `${fw.avgMfePct.toFixed(2)}%`}.${verdict}`;
}

async function loadCoinOfDay(force = false) {
  const meta = document.getElementById("cod-meta");
  meta.textContent = "скан…";
  try {
    codData = await fetchJson(`/api/coin-of-day${force ? "?refresh=1" : ""}`);
    if (codData.error) throw new Error(codData.error);
    const age = codData.cached ? ` · из кэша ${codData.ageSec}с` : "";
    meta.textContent = `разобрано ${codData.scanned} из ${codData.universe}${age}`;
      if (!codAllTabs().some((p) => p.coin === codActive)) codActive = codAllTabs()[0]?.coin ?? null;
    codRenderTabs();
    codRenderBody();
    codRenderForward();
  } catch (err) {
    meta.textContent = "ошибка";
    document.getElementById("cod-body").innerHTML =
      `<div class="cod-empty">Скан не удался: ${err.message}</div>`;
  }
}

document.getElementById("cod-refresh").addEventListener("click", () => loadCoinOfDay(true));

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

loadCoinOfDay();
loadScanner();
loadOverview();
