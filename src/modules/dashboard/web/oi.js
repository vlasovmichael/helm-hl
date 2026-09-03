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
import { drawOiChart, clearOiChart, applyOiChartTheme } from "./src/charts/oiChart.js";

mountTopnav("oi");
bindTheme([applyOiChartTheme]);

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
    `<span class="oi-sub${loud ? " oi-sub-loud" : ""}">${sub}</span>`
  );
};
// Местное время, не UTC: страницу читает человек, сверяющий её со своими
// часами. На UTC-метках свежий снимок (13:45 UTC при 15:56 на часах) читался
// как двухчасовое отставание коллектора.
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

/**
 * Полоски силы сигнала: закрашено ровно score из 5, цвет — по стороне сделки.
 * Класс-обёртка обязателен: правило .ss-seg.on живёт под .cod-segs--*,
 * без обёртки полоски остаются серыми при любом score.
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
    <tr><td>R:R</td><td class="${rrOk ? "cod-rr-ok" : "cod-rr-bad"}">${l.rr.toFixed(2)}</td></tr>`
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
    meta.textContent = codData.scanned == null
      ? ""
      : `reviewed ${codData.scanned} of ${codData.universe}${age}`;
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



// ── entry filter ──
// Карточка не выбирает монету и не предлагает вход: она помечает сторону, за
// которую журнал уже заплатил (вход в сторону случившегося движения). Молчание
// фильтра — это молчание, а не разрешение.
const EF_LVL_LABEL = { extreme: "extreme", strong: "strong", fast: "fast 15m", quiet: "quiet" };

function efPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function efRenderBody(data) {
  const body = document.getElementById("ef-body");
  const rows = data.rows || [];
  if (!rows.length) {
    body.innerHTML = `<div class="ef-empty">No price history buffered yet — the filter needs about an hour of ticks after a restart.</div>`;
    return;
  }

  const held = data.holdingBlocked || [];
  const verdict = held.length
    ? {
        cls: "warn",
        head: `You are in ${held.map((h) => `${h.position.side} ${h.coin}`).join(", ")} — entered with the move`,
        detail: held
          .map((h) => `${h.coin}: ${h.text}. In the journal this side averaged −0.18 per trade; the extreme slice −0.49.`)
          .join(" "),
      }
    : data.flagged
      ? {
          cls: "calm",
          head: `${data.flagged} of ${data.scanned} coins are running hard right now`,
          detail: "No open position sits on the flagged side. The table below marks which side would be an entry into a move that already happened — it does not suggest the opposite side as a trade.",
        }
      : {
          cls: "calm",
          head: "Nothing is running hard — the filter is silent",
          detail: "No coin exceeds 3% on the hour or 1.5% on 15 minutes. Silence means the journal has nothing to say here, not that an entry is good.",
        };

  const trs = rows
    .map((r) => {
      const side = r.blockedSide
        ? `<span class="ef-side ${r.blockedSide.toLowerCase()}">${r.blockedSide}</span>`
        : `<span class="ef-side none">—</span>`;
      const pos = r.position
        ? `<span class="ef-side ${r.position.side.toLowerCase()}">${r.position.side}</span>`
        : `<span class="oi-muted">—</span>`;
      return `<tr class="${r.holdingBlocked ? "ef-held" : ""}">
        <td>${r.coin}</td>
        <td>${efPct(r.trend15m)}</td>
        <td>${efPct(r.trend1h)}</td>
        <td>${efPct(r.dayChangePct)}</td>
        <td>${side}</td>
        <td><span class="ef-lvl ${r.level}">${EF_LVL_LABEL[r.level] || r.level}</span></td>
        <td>${pos}</td>
      </tr>`;
    })
    .join("");

  body.innerHTML = `
    <div class="ef-verdict ${verdict.cls}">
      <div class="ef-vh">${verdict.head}</div>
      <div class="ef-vd">${verdict.detail}</div>
    </div>
    <div class="ef-table-wrap">
      <table class="ef-t">
        <thead>
          <tr>
            <th>Coin</th><th>15m</th><th>1h</th><th>24h</th>
            <th title="Side that would be an entry into the move that already happened">Costly side</th>
            <th>Move</th>
            <th title="Your open position on the exchange">You hold</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
}

function efRenderForward(data) {
  const el = document.getElementById("ef-fwd");
  const fw = data.forward;
  if (!fw || fw.n == null) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>Forward check:</b> <b>${fw.n}</b> of <b>${fw.target}</b> fresh trades logged since the hypothesis
    was registered. The rule was found in past data, so it is judged <b>once</b>, at ${fw.target} — looking earlier
    is what turned five previous ideas into noise.`;
}

async function loadEntryFilter() {
  const meta = document.getElementById("ef-meta");
  meta.textContent = "reading…";
  try {
    const data = await fetchJson("/api/entry-filter");
    if (data.error) throw new Error(data.error);
    meta.textContent = data.marketAgeSec == null ? "" : `market ${data.marketAgeSec}s old · ${data.scanned} coins`;
    efRenderBody(data);
    efRenderForward(data);
  } catch (err) {
    meta.textContent = "error";
    document.getElementById("ef-body").innerHTML = `<div class="ef-empty">Failed: ${err.message}</div>`;
  }
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
    `<span class="${stale ? "oi-stale" : "oi-fresh"}">${fmtAge(last.t)}</span>`;
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
            ? ' <span class="oi-live" title="This bucket is still filling — it covers the hour that has not ended yet.">filling</span>'
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

// Подпись зоны в шапке таблицы: без неё «14:00» не отличить от UTC-метки.
{
  const tzEl = document.getElementById("oi-tz");
  if (tzEl) tzEl.textContent = TZ_LABEL;
}

document.getElementById("ef-refresh")?.addEventListener("click", () => loadEntryFilter());

loadCoinOfDay();
loadEntryFilter();
loadOverview();
