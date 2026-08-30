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
        ${label(pl.stop, "stop", pl.stop)}
        ${label(pl.target, "target", pl.target)}
      </div>
      <div class="nan-scale-pad"></div>
    </div>`;
}

function nanRenderPosition(p) {
  const pos = p.position;
  const pl = p.plan;
  const st = NAN_STATUS[p.status] || "armed";

  const posRows = `
    <tr><td>Your entry</td><td>${nanPx(pos.entryPx)}</td></tr>
    <tr><td>Now</td><td>${nanPx(pos.price)} · ${nanSigned(pos.gainPct)}</td></tr>
    <tr><td>Position size</td><td>${nanUsd(pos.notionalUsd)}</td></tr>
    <tr class="nan-strong"><td>Unrealized</td><td>${nanUsdSigned(pos.unrealizedPnl)}</td></tr>`;

  // Риск в долларах стоит первым: это единственное число, которое напрямую
  // отвечает на вопрос «сколько я теряю, если ошибся».
  const planRows = `
    <tr class="nan-strong"><td>Risk to stop</td><td>${
      pl.riskUsd == null
        ? '<span class="oi-neg">unbounded</span>'
        : `<span class="oi-neg">-$${pl.riskUsd.toFixed(2)}</span>`
    }</td></tr>
    <tr><td>Stop</td><td>${
      pl.stop == null
        ? '<span class="oi-neg">none</span>'
        : `${nanPx(pl.stop)}${pl.toStopPct == null ? "" : ` · ${pl.toStopPct.toFixed(2)}% away`}`
    }</td></tr>
    <tr><td>Target</td><td>${
      pl.target == null
        ? '<span class="oi-muted">none</span>'
        : `${nanPx(pl.target)}${pl.toTargetPct == null ? "" : ` · ${pl.toTargetPct.toFixed(2)}% away`}`
    }</td></tr>
    <tr><td>Reward to target</td><td>${pl.rewardUsd == null ? "—" : `+$${pl.rewardUsd.toFixed(2)}`}</td></tr>
    <tr><td>Plan R:R</td><td>${
      pl.rr == null ? "—" : `<span class="${pl.rr >= 1.5 ? "oi-pos" : "oi-neg"}">${pl.rr.toFixed(2)}</span>`
    }</td></tr>
    <tr><td>Now in R</td><td>${
      pl.stopLocksProfit
        ? '<span class="oi-pos">stop in profit</span>'
        : pl.rNow == null
          ? "—"
          : `<span class="${pl.rNow >= 0 ? "oi-pos" : "oi-neg"}">${pl.rNow >= 0 ? "+" : ""}${pl.rNow.toFixed(2)}R</span>`
    }</td></tr>
    <tr><td>Progress to target</td><td>${pl.progressPct == null ? "—" : `${pl.progressPct.toFixed(0)}%`}</td></tr>`;

  const notes = (p.notes || []).length
    ? `<ul class="nan-notes">${p.notes
        .map((t) => `<li class="${/NO |unprotected|unbounded|single candle/.test(t) ? "warn" : ""}">${t}</li>`)
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
          <p class="nan-sub">Your position</p>
          <table class="nan-t">${posRows}</table>
        </div>
        <div>
          <p class="nan-sub">Plan on the exchange</p>
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
      <span><span class="nan-total-k">Positions</span><span class="nan-total-v">${t.count}</span></span>
      <span><span class="nan-total-k">Notional</span><span class="nan-total-v">$${t.notionalUsd.toFixed(2)}</span></span>
      <span><span class="nan-total-k">Risk if every stop fires</span><span class="nan-total-v">${risk}</span></span>
      <span><span class="nan-total-k">Without a stop</span><span class="nan-total-v">${unp}</span></span>
    </div>`;
}

async function loadNanny(force = false) {
  const meta = document.getElementById("nan-meta");
  const body = document.getElementById("nan-body");
  meta.textContent = "reading…";
  try {
    const data = await fetchJson(`/api/position-nanny${force ? "?refresh=1" : ""}`);
    if (data.error) throw new Error(data.error);
    const age = data.cached ? ` · cached ${data.ageSec}s ago` : "";
    const list = data.positions || [];
    meta.textContent = `${list.length} ${list.length === 1 ? "position" : "positions"}${age}`;
    if (!list.length) {
      body.innerHTML =
        '<div class="nan-empty">No open positions — nothing to babysit.</div>';
      return;
    }
    body.innerHTML = nanRenderTotals(data.totals) + list.map(nanRenderPosition).join("");
  } catch (err) {
    meta.textContent = "error";
    body.innerHTML = `<div class="nan-empty">Could not read positions: ${err.message}</div>`;
  }
}

document.getElementById("nan-refresh").addEventListener("click", () => loadNanny(true));

// ── Монета дня (карточка 02) ──
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

/**
 * Полоски силы сигнала: закрашено ровно score из 5, цвет — по стороне сделки.
 * Класс-обёртка обязателен: базовое правило .ss-seg.on живёт под .ss-hero--*,
 * без своей обёртки полоски остаются серыми при любом score.
 */
const codSegs = (score, side) => {
  const tone = side === "SHORT" ? "short" : side === "LONG" ? "long" : "muted";
  const n = Number.isFinite(score) ? score : 0;
  const segs = Array.from(
    { length: 5 },
    (_, i) => `<span class="ss-seg${i < n ? " on" : ""}"></span>`,
  ).join("");
  return `<span class="ss-segs cod-segs--${tone}" title="${n} of 5 conditions met">${segs}</span>`;
};

// Балла `move` здесь больше нет: он дублировал отсечку по ходу и потому
// начислялся всем, кто до неё дошёл. Осталось 5 независимых признаков.
const COD_HIT_LABEL = {
  edge: "Pinned at the edge of the 72h range",
  rollover: "4h momentum has already rolled over",
  structure: "15m structure broken (3+ legs)",
  volDecay: "Volume decayed (≤ 40% of peak)",
  notCrowded: "OI not overheated (pump is not leverage-driven)",
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
        ${
          p.tradedToday
            ? '<span class="cod-tab-held cod-tab-done">day closed</span>'
            : p.held
              ? '<span class="cod-tab-held">in position</span>'
              : p.dayContext
                ? '<span class="cod-tab-held cod-tab-done">2nd attempt</span>'
                : ""
        }
        <span class="cod-tab-coin">${p.coin}</span>
        ${p.side ? `<span class="cod-tab-side ${p.side.toLowerCase()}">${p.side}</span>` : ""}
        <span class="oi-muted">${p.score == null ? "—" : `${p.score}/5`}</span>
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
  thesis_intact:      { cls: "setup", label: "thesis intact" },
  thesis_weakened:    { cls: "watch", label: "thesis weakened" },
  thesis_faded:       { cls: "watch", label: "setup faded" },
  thesis_invalidated: { cls: "none",  label: "plan stop broken" },
  target_reached:     { cls: "setup", label: "target reached" },
  wrong_side:         { cls: "none",  label: "position against the analysis" },
};

/** Монета, отторгованная сегодня: день закрыт, вход не предлагаем. */
function codRenderTradedToday(p) {
  const f = p.features;
  const d = p.day;
  const factRows = f
    ? `
    <tr><td>24h move</td><td>${codSigned(f.chg24h, 1)}</td></tr>
    <tr><td>Last 4h</td><td>${codSigned(f.chg4h)}</td></tr>
    <tr><td>Position in the 72h range</td><td>${(f.rangePos * 100).toFixed(0)}%</td></tr>
    <tr><td>1h trend</td><td>${f.trend1h === "up" ? "↑ up" : f.trend1h === "down" ? "↓ down" : "→ range"}</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">The coin no longer passes the entry filter</td></tr>`;

  return `
    <div class="cod-head">
      <div class="cod-head-main">
        <span class="cod-donebadge">day closed</span>
        <span class="ss-coin">${p.coin}</span>
        ${codSegs(p.score, null)}
        <span class="oi-muted" style="font-size:13px">${p.score == null ? "—" : `${p.score}/5`}</span>
      </div>
      <div class="cod-verdict none">${p.headline}</div>
    </div>
    <p class="cod-detail">${p.detail}</p>
    <div class="cod-grid" style="margin-top:16px">
      <div>
        <p class="cod-sub">Day result for this coin</p>
        <table class="cod-t">
          <tr><td>Trades</td><td>${d.count}</td></tr>
          <tr><td>Result</td><td class="${d.pnl >= 0 ? "cod-rr-ok" : "cod-rr-bad"}">${d.pnl < 0 ? "-" : "+"}$${Math.abs(d.pnl).toFixed(2)}</td></tr>
          <tr><td>Last exit</td><td>${d.lastCloseAt ? new Date(d.lastCloseAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"}</td></tr>
          ${d.side ? `<tr><td>Side</td><td>${d.side}</td></tr>` : ""}
        </table>
      </div>
      <div>
        <p class="cod-sub">Where the coin stands now</p>
        <table class="cod-t">${factRows}</table>
      </div>
      <div>
        <p class="cod-sub">Why no entry is offered</p>
        <ul class="cod-flags">${(p.notes || []).map((t) => `<li class="med">${t}</li>`).join("")}</ul>
      </div>
    </div>`;
}

/** Разбор монеты, в которой оператор сидит: ведение позиции, а не вход. */
function codRenderHeld(p) {
  const st = COD_STATUS[p.status] || { cls: "watch", label: p.status };
  const pos = p.position;
  const f = p.features;
  const pl = p.plan;

  const posRows = `
    <tr><td>Your entry</td><td>${codFmtPx(pos.entryPx)}</td></tr>
    <tr><td>Now</td><td>${codSigned(pos.gainPct)}</td></tr>
    <tr><td>Position size</td><td>${fmtUsd(pos.notionalUsd)}</td></tr>
    <tr><td>Unrealized</td><td>${pos.unrealizedPnl < 0 ? "-" : "+"}$${Math.abs(pos.unrealizedPnl).toFixed(2)}</td></tr>`;

  const planRows = pl
    ? `
    <tr><td>Planned entry</td><td>${codFmtPx(pl.entry)}</td></tr>
    <tr><td>Plan stop</td><td>${codFmtPx(pl.stop)} · ${pl.toStopPct.toFixed(2)}% away</td></tr>
    <tr><td>Plan target</td><td>${codFmtPx(pl.target)} · ${pl.toTargetPct.toFixed(2)}% away</td></tr>
    <tr><td>Now in R</td><td class="${pl.rNow >= 0 ? "cod-rr-ok" : "cod-rr-bad"}">${pl.rNow == null ? "—" : `${pl.rNow >= 0 ? "+" : ""}${pl.rNow.toFixed(2)}R`}</td></tr>
    <tr><td>Progress to target</td><td>${pl.progressPct == null ? "—" : `${pl.progressPct.toFixed(0)}%`}</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">Entry did not come from this card — no plan to compare against</td></tr>`;

  const factRows = f
    ? `
    <tr><td>24h move</td><td>${codSigned(f.chg24h, 1)}</td></tr>
    <tr><td>Last 4h</td><td>${codSigned(f.chg4h)}</td></tr>
    <tr><td>Position in the 72h range</td><td>${(f.rangePos * 100).toFixed(0)}%</td></tr>
    <tr><td>15m structure</td><td>${f.structLegs} ${p.side === "SHORT" ? "lower-high" : "higher-low"}</td></tr>
    <tr><td>Volume now / peak</td><td>${f.volDecay == null ? "—" : `${(f.volDecay * 100).toFixed(0)}%`}</td></tr>
    <tr><td>1h trend</td><td>${f.trend1h === "up" ? "↑ up" : f.trend1h === "down" ? "↓ down" : "→ range"}</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">The coin no longer passes the entry filter</td></tr>`;

  const notes = (p.notes || []).concat((p.flags || []).map((x) => x.text));

  return `
    <div class="cod-head">
      <div class="cod-head-main">
        <span class="cod-heldbadge">in position</span>
        <span class="ss-badge ss-badge--${p.side.toLowerCase()}">${p.side === "SHORT" ? "▼" : "▲"} ${p.side}</span>
        <span class="ss-coin">${p.coin}</span>
      </div>
      <div class="cod-verdict ${st.cls}">${p.headline}</div>
    </div>
    <p class="cod-detail">${p.detail}</p>
    <div class="cod-grid" style="margin-top:16px">
      <div>
        <p class="cod-sub">Your position</p>
        <table class="cod-t">${posRows}</table>
      </div>
      <div>
        <p class="cod-sub">The plan you entered on</p>
        <table class="cod-t cod-levels">${planRows}</table>
      </div>
      <div>
        <p class="cod-sub">Where the coin stands now</p>
        <table class="cod-t">${factRows}</table>
        ${
          notes.length
            ? `<p class="cod-sub" style="margin-top:16px">What to watch</p>
               <ul class="cod-flags">${notes.map((t) => `<li class="med">${t}</li>`).join("")}</ul>`
            : ""
        }
      </div>
    </div>
    <p class="cod-detail" style="margin-top:14px">
      The card deliberately does not compute a new entry here: suggesting an add to
      an open position is an averaging-down machine.
    </p>`;
}

function codRenderBody() {
  const body = document.getElementById("cod-body");
  const tabs = codAllTabs();
  if (!tabs.length) {
    const others = codData?.others?.length ?? 0;
    body.innerHTML = `<div class="cod-empty">
      No setup today — no coin reached ${codData?.thresholds?.SHOW_MIN_SCORE ?? 3}/5.
      ${others ? `Candidates reviewed: ${others}, each fell short.` : ""}
      <br />Skipping the day is a decision too.
    </div>`;
    return;
  }
  const p = tabs.find((x) => x.coin === codActive) || tabs[0];
  codActive = p.coin;
  if (p.tradedToday) {
    body.innerHTML = codRenderTradedToday(p);
    return;
  }
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
        `<tr><td class="${p.hits[k] ? "cod-hit" : "cod-miss"}">${label}</td><td>${p.hits[k] ? "yes" : "no"}</td></tr>`,
    )
    .join("");

  const factRows = `
    <tr><td>Price</td><td>${codFmtPx(f.price)}</td></tr>
    <tr><td>Move 24h / 48h</td><td>${codSigned(f.chg24h, 1)} / ${codSigned(f.chg48h, 1)}</td></tr>
    <tr><td>Last 4h</td><td>${codSigned(f.chg4h)}</td></tr>
    <tr><td>Position in the 72h range</td><td>${(f.rangePos * 100).toFixed(0)}%</td></tr>
    <tr><td>72h range</td><td>${codFmtPx(f.lo72)} — ${codFmtPx(f.hi72)}</td></tr>
    <tr><td>15m structure</td><td>${f.structLegs} ${p.side === "SHORT" ? "lower-high" : "higher-low"}</td></tr>
    <tr><td>Volume now / peak</td><td>${f.volDecay == null ? "—" : `${(f.volDecay * 100).toFixed(0)}%`}</td></tr>
    <tr><td>ATR(1h) · ER(24h)</td><td>${f.atr1hPct == null ? "—" : `${f.atr1hPct.toFixed(2)}%`} · ${f.er24 == null ? "—" : f.er24.toFixed(2)}</td></tr>
    <tr><td>OI / 24h turnover</td><td>${fmtUsd(f.oiUsd)} / ${fmtUsd(f.volume24hUsd)}${f.oiVolRatio != null ? ` (${f.oiVolRatio.toFixed(2)}×)` : ""}</td></tr>
    <tr><td>Funding APR</td><td>${f.fundingApr == null ? "—" : `${f.fundingApr >= 0 ? "+" : ""}${f.fundingApr.toFixed(0)}%`}</td></tr>
    <tr><td>1h trend</td><td>${f.trend1h === "up" ? "↑ up" : f.trend1h === "down" ? "↓ down" : "→ range"}</td></tr>`;

  const levelRows = l
    ? `
    <tr><td>Entry</td><td>${codFmtPx(l.entry)}</td></tr>
    <tr><td>Stop <span class="oi-muted">(place it BEFORE entry)</span></td><td>${codFmtPx(l.stop)} · ${l.riskPct.toFixed(2)}%</td></tr>
    <tr><td>Target${l.targetProjected ? ' <span class="oi-muted">(projected)</span>' : ""}</td><td>${codFmtPx(l.target)} · ${l.rewardPct.toFixed(2)}%</td></tr>
    ${l.farTarget ? `<tr><td>Far level <span class="oi-muted">(runner)</span></td><td>${codFmtPx(l.farTarget)}</td></tr>` : ""}
    <tr><td>R:R</td><td class="${rrOk ? "cod-rr-ok" : "cod-rr-bad"}">${l.rr.toFixed(2)}</td></tr>
    <tr><td>Time stop</td><td>${l.timeStopMin} min</td></tr>`
    : `<tr><td colspan="2" class="oi-muted">Levels could not be built</td></tr>`;

  const flags = p.flags.length
    ? `<ul class="cod-flags">${p.flags.map((fl) => `<li class="${fl.severity}">${fl.text}</li>`).join("")}</ul>`
    : `<p class="cod-detail">The engine found no obvious red flags — which does not make the setup safe.</p>`;

  body.innerHTML = `
    <div class="cod-head">
      <div class="cod-head-main">
        ${p.dayContext ? '<span class="cod-donebadge">already traded today</span>' : ""}
        <span class="ss-badge ss-badge--${p.side.toLowerCase()}">${p.side === "SHORT" ? "▼" : "▲"} ${p.side}</span>
        <span class="ss-coin">${p.coin}</span>
        ${codSegs(p.score, p.side)}
        <span class="oi-muted" style="font-size:13px">${p.score}/5</span>
      </div>
      <div class="cod-verdict ${p.verdict.tone}">${p.verdict.headline}</div>
    </div>
    <p class="cod-detail">${p.verdict.detail}</p>
    <div class="cod-grid" style="margin-top:16px">
      <div>
        <p class="cod-sub">What lined up · ${p.score}/5</p>
        <table class="cod-t">${hitRows}</table>
      </div>
      <div>
        <p class="cod-sub">Numbers</p>
        <table class="cod-t">${factRows}</table>
      </div>
      <div>
        <p class="cod-sub">Trade plan</p>
        <table class="cod-t cod-levels">${levelRows}</table>
        <p class="cod-sub" style="margin-top:16px">What argues against</p>
        ${flags}
      </div>
    </div>`;
}

// Форвард-лог. Главное число здесь — excess (ход монеты минус ход BTC за то же
// окно), а не сырой ход: без вычета бенчмарка падение альты на общем сливе
// неотличимо от отработавшего фейда.
function codRenderForward() {
  const el = document.getElementById("cod-fwd");
  const fw = codData?.forward;
  if (!fw) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const rows = Object.entries(fw.horizons || {})
    .map(([key, h]) => {
      const hours = key.replace("h", "");
      if (!h.n) return `<div>${hours}h — no data yet</div>`;
      const raw = h.avgPct == null ? "—" : `${h.avgPct >= 0 ? "+" : ""}${h.avgPct.toFixed(2)}%`;
      const ex =
        h.avgExcessPct == null
          ? "—"
          : `<b class="${h.avgExcessPct > 0 ? "oi-pos" : h.avgExcessPct < 0 ? "oi-neg" : ""}">${
              h.avgExcessPct >= 0 ? "+" : ""
            }${h.avgExcessPct.toFixed(2)}%</b>`;
      const wr = h.excessWinRate == null ? "—" : `${h.excessWinRate.toFixed(0)}%`;
      return `<div>${hours}h · n=<b>${h.n}</b> · move <b>${raw}</b> · vs BTC ${ex} · beats market ${wr}</div>`;
    })
    .join("");

  const verdict = fw.enoughForVerdict
    ? ""
    : `<div class="oi-neg" style="margin-top:6px">n &lt; 20 at 24h — NO conclusions about edge, this is still noise.</div>`;

  el.innerHTML = `<b>Forward log:</b> <b>${fw.total}</b> picks, <b>${fw.pending}</b> still maturing.
    ${rows}${verdict}`;
}

async function loadCoinOfDay(force = false) {
  const meta = document.getElementById("cod-meta");
  meta.textContent = "scanning…";
  try {
    codData = await fetchJson(`/api/coin-of-day${force ? "?refresh=1" : ""}`);
    if (codData.error) throw new Error(codData.error);
    const age = codData.cached ? ` · cached ${codData.ageSec}s ago` : "";
    meta.textContent = `reviewed ${codData.scanned} of ${codData.universe}${age}`;
      if (!codAllTabs().some((p) => p.coin === codActive)) codActive = codAllTabs()[0]?.coin ?? null;
    codRenderTabs();
    codRenderBody();
    codRenderForward();
  } catch (err) {
    meta.textContent = "error";
    document.getElementById("cod-body").innerHTML =
      `<div class="cod-empty">Scan failed: ${err.message}</div>`;
  }
}


// ── Setup Scanner radar (карточка 03) ──
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
      '<div class="ss-hero-empty">No setups with score ≥ 1 right now — the radar is empty.</div>';
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
      ssRows.length ? "No setups with score ≥ 1 (everything is score 0)." : "No coins."
    }</td></tr>`;
    return;
  }
  let html = shown.map(rowHtml).join("");
  if (!ssShowZero && hidden > 0) {
    html += `<tr><td colspan="7" class="oi-muted" style="text-align:center;padding:10px">
      + ${hidden} coins with score 0 hidden · <span style="text-decoration:underline;cursor:pointer" id="ss-showzero-link">show all</span></td></tr>`;
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
loadCoinOfDay();
loadScanner();
loadOverview();
