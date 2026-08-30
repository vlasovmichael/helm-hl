// ─────────────────────────────────────────────────
//  Day Desk — бюджет дня, комиссии, защита, соблюдение правил
// ─────────────────────────────────────────────────
// Читает /api/day-desk (30-дневное окно fills, дороже обычного статуса —
// поэтому опрашивается раз в минуту, а не в WS-броадкасте).
//
// Порядок плиток не косметический: сначала то, что ограничивает сегодняшние
// действия (сделки, остаток до стопа), потом издержки, потом защита. Идея
// сделки на этом экране не появляется вовсе — она ниже, в Screen.

import { fetchJson } from "../net/api.js";

const REFRESH_MS = 60_000;

const money = (v) =>
  v == null || !Number.isFinite(v) ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;

/** Плитка: значение + подпись + необязательная сноска. */
function tile({ k, v, sub, tone = "", title = "" }) {
  return `
    <div class="dd-tile ${tone}"${title ? ` title="${title}"` : ""}>
      <div class="dd-k">${k}</div>
      <div class="dd-v">${v}</div>
      <div class="dd-sub">${sub ?? ""}</div>
    </div>`;
}

/** Точки-счётчик сделок: состояние дня видно, не читая цифр. */
function dots(n, cap) {
  return Array.from({ length: Math.max(cap, n) }, (_, i) => {
    const cls = i < n ? (i >= cap ? "is-over" : "is-on") : "";
    return `<i class="dd-dot ${cls}"></i>`;
  }).join("");
}

function renderTiles(d) {
  const t = d.trades;
  const m = d.money;
  const s = d.stop;
  const p = d.protection;

  const tradesTone = t.over ? "bad" : t.today >= t.cap ? "warn" : "";
  const stopTone = s.halted ? "bad" : s.remainingUsd <= s.limitUsd * 0.34 ? "warn" : "";

  // Комиссии — первоклассная метрика: доллары ничего не говорят, пока рядом нет
  // цены круга в bp и доли от валового результата.
  const feeSub =
    m.feesBp == null
      ? "no turnover yet"
      : `${m.feesBp.toFixed(1)} bp of turnover` +
        (m.feeShareOfGross != null
          ? ` · ${Math.round(m.feeShareOfGross * 100)}% of gross`
          : "");
  const feeTone = m.feeShareOfGross != null && m.feeShareOfGross >= 1 ? "bad" : "";

  const protTone = p.unprotected > 0 ? "bad" : "";
  const protSub =
    p.open === 0
      ? "nothing open"
      : p.unprotected > 0
        ? `${p.unprotected} without a stop`
        : "all have a stop";

  return [
    tile({
      k: "Trades today",
      v: `${t.today} <span class="dd-of">/ ${t.cap}</span>`,
      sub: `<span class="dd-dots">${dots(t.today, t.cap)}</span>`,
      tone: tradesTone,
      title: "Round trips closed or opened today, against the daily budget",
    }),
    tile({
      k: "Left before daily stop",
      v: s.halted ? "stop hit" : money(s.remainingUsd),
      sub: s.known ? `limit ${money(s.limitUsd)}` : "counter has not run yet",
      tone: stopTone,
      title: "How much more today can lose before new entries are closed",
    }),
    tile({
      k: "Net today",
      v: money(m.net),
      sub: `gross ${money(m.gross)}`,
      tone: m.net < 0 ? "bad" : m.net > 0 ? "good" : "",
    }),
    tile({
      k: "Fees today",
      v: money(m.fees),
      sub: feeSub,
      tone: feeTone,
      title: "Fees were 100%+ of the historical loss — this is the number to keep small",
    }),
    tile({
      k: "Protection",
      v: `${p.open} open`,
      sub: protSub,
      tone: protTone,
      title: "Positions without a stop on the exchange carry unbounded risk",
    }),
  ].join("");
}

function renderRules(a) {
  if (!a || !a.n) {
    return `<div class="dd-rules-empty">No closed trades in the last ${a?.days ?? 30} days — nothing to score yet.</div>`;
  }
  const chips = a.rules
    .map(
      (r) => `
      <div class="dd-rule ${r.ok ? "is-ok" : "is-off"}" title="${r.metric}">
        <span class="dd-rule-n">${r.n}</span>
        <span class="dd-rule-t">${r.title}</span>
        <span class="dd-rule-m">${r.metric}</span>
      </div>`,
    )
    .join("");
  return `
    <div class="dd-rules-head">
      <span class="dd-rules-title">My rules · last ${a.days} days</span>
      <span class="dd-rules-score ${a.followed === 5 ? "is-ok" : a.followed <= 2 ? "is-off" : ""}">${a.followed}/5 followed</span>
      <span class="dd-rules-n">${a.n} trades over ${a.tradingDays} days</span>
    </div>
    <div class="dd-rules-list">${chips}</div>`;
}

export async function renderDayDesk() {
  const host = document.getElementById("day-desk");
  const rulesHost = document.getElementById("day-rules");
  const meta = document.getElementById("day-meta");
  if (!host) return;

  let d;
  try {
    d = await fetchJson("/api/day-desk");
  } catch {
    host.innerHTML = `<div class="dd-empty">Day desk unavailable.</div>`;
    return;
  }
  if (!d || d.error) {
    host.innerHTML = `<div class="dd-empty">Day desk unavailable.</div>`;
    return;
  }

  host.innerHTML = renderTiles(d);
  if (rulesHost) rulesHost.innerHTML = renderRules(d.adherence);
  if (meta) meta.textContent = d.dayKey;
}

/** Поднимает опрос. Отдельно от общего tick: срез дороже и меняется медленно. */
export function startDayDesk() {
  renderDayDesk();
  setInterval(renderDayDesk, REFRESH_MS);
}
