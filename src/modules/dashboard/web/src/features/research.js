// Research — витрина форвард-тестов и разбор теста по клику.
// 🚨 Возраст данных обязателен: без него замёрзший снимок выглядит живым.
// Разбор незакрытого теста — только за подтверждением, просмотр пишется в
// data/hypotheses/peeks.jsonl.

import { fetchJson } from "../net/api.js";
import { escapeHtml } from "../utils/format.js";
import { emptyState } from "../core/placeholders.js";
import * as dialog from "../core/dialog.js";
import { icon } from "../core/icon.js";
import { button } from "../core/ui.js";

let bound = false;

export async function refreshFvgForward() {
  const body = document.getElementById("fvg-body");
  const meta = document.getElementById("fvg-meta");
  if (!body) return;
  bindOnce();

  let res;
  try {
    res = await fetchJson("/api/forwards");
  } catch {
    body.innerHTML = emptyState({
      glyph: "danger",
      title: "Dashboard is not answering",
      hint: "Forward tests could not be read. Reload the page to try again.",
    });
    return;
  }
  if (!res?.ok || !Array.isArray(res.items)) {
    body.innerHTML = emptyState({
      glyph: "clock",
      title: "No forward tests registered",
      hint: "A test shows up here once a hypothesis is registered with a stop rule.",
    });
    return;
  }

  const done = res.items.filter((f) => f.n >= f.target).length;
  if (meta) {
    meta.textContent = `${res.items.length} running${done ? ` · ${done} at threshold` : ""}`;
    meta.style.color = done ? "var(--green)" : "var(--text-muted)";
  }

  body.innerHTML =
    res.items.map(renderForward).join("") +
    `<div class="fw-note">E[R], winrate and trade signs stay off this card <b>on purpose</b>: ` +
    `an interim result invalidates the test. Click a row for the breakdown — before the ` +
    `threshold it asks first and the peek is logged. ${escapeHtml(res.decisionRule || "")}</div>`;
}

/** Одна строка накопителя. Метрик результата здесь нет и быть не должно. */
function renderForward(f) {
  const pct = Math.min(100, f.pct || 0);
  // Молчание коллектора видно сразу и красным: замёрзший снимок, выданный за
  // живой, уже стоил трёх недель на Spike-Fade.
  const stale = f.staleHours != null && f.staleHours > 72;
  const notStarted = f.n === 0 && f.daysRunning < 1;
  const ready = f.n >= f.target;

  // Условия сверх счётчика: без них порог можно набрать за неделю внутри
  // одного рыночного режима, и результат будет про погоду, а не про правило.
  const gates = [];
  if (f.calendarDays != null && f.minCalendarDays && f.calendarDays < f.minCalendarDays) {
    gates.push(`${f.calendarDays}/${f.minCalendarDays} calendar days`);
  }
  if (f.regimeShare != null && f.minRegimeShare && f.regimeShare < f.minRegimeShare) {
    gates.push(`regime split ${Math.round(f.regimeShare * 100)}% (needs ${Math.round(f.minRegimeShare * 100)}%)`);
  }

  const pace = notStarted
    ? "starts with the next collector run"
    : f.perDay
      ? `pace ${f.perDay.toFixed(1)}/day` + (f.etaISO ? ` · threshold near <b>${f.etaISO}</b>` : "")
      : "pace shows up after the first full day";

  return (
    `<button type="button" class="fw-row${ready ? " is-ready" : ""}" data-forward="${escapeHtml(f.id)}">` +
      `<div class="fw-head">` +
        `<span class="fw-label">${escapeHtml(f.label)}</span>` +
        `<span class="fw-count${stale ? " is-stale" : ""}"><b>${f.n}</b> / ${f.target} ${escapeHtml(f.unit)}` +
        `${icon("collapsed", { cls: "fw-caret" })}</span>` +
      `</div>` +
      `<div class="fw-bar"><span style="width:${pct.toFixed(1)}%"></span></div>` +
      `<div class="fw-meta">${pace}` +
        (gates.length ? ` · still needs ${escapeHtml(gates.join(", "))}` : "") +
        (stale ? ` · <span class="fw-stale">silent ${Math.round(f.staleHours)}h</span>` : "") +
      `</div>` +
    `</button>`
  );
}

// ── Разбор одного теста ─────────────────────────────────────────────────────

function bindOnce() {
  if (bound) return;
  bound = true;
  document.addEventListener("click", (e) => {
    const row = e.target.closest("[data-forward]");
    if (row) { openBreakdown(row.dataset.forward, false); return; }
    const peek = e.target.closest("[data-forward-peek]");
    if (peek) openBreakdown(peek.dataset.forwardPeek, true);
  });
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) : "—");
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—");

function show(title, body, sub = "", tone = "") {
  dialog.show({ id: "fw-modal", glyph: "target", title, sub, tone, wide: true, body });
}

async function openBreakdown(id, peek) {
  show("Breakdown", `<div class="fw-loading">${icon("clock")} Reading the journal…</div>`);
  let r;
  try {
    r = await fetchJson(`/api/forwards/${encodeURIComponent(id)}/breakdown${peek ? "?peek=1" : ""}`);
  } catch {
    show("Breakdown", `<div class="fw-warn">Could not read the journal.</div>`);
    return;
  }
  if (!r?.ok) {
    show("Breakdown", `<div class="fw-warn">${escapeHtml(r?.message || "Unknown forward test.")}</div>`);
    return;
  }
  const p = r.progress || {};
  const sub = p.n != null ? `${p.n} / ${p.target} ${escapeHtml(p.unit || "")} collected` : "";

  if (r.locked) {
    show(
      r.label,
      `<div class="fw-lead">This test has not met its stop rule yet` +
        (p.calendarDays != null ? ` (${p.calendarDays}/${p.minCalendarDays} calendar days` +
          `${p.regimeShare != null ? `, regime split ${pct(p.regimeShare)}` : ""})` : "") +
        `.</div>` +
        `<div class="fw-warn">${icon("warn")}<span>Reading the result now breaks the pre-registration: ` +
        `an interim number cannot be unseen, and stopping on a number you liked is exactly the ` +
        `error the rule protects against. The peek gets written to <code>peeks.jsonl</code>.</span></div>` +
        stopRuleHtml(p) +
        button({ label: "Show it anyway", icon: "eye", variant: "danger", cta: true,
          attrs: { "data-forward-peek": id } }),
      sub,
      "warn",
    );
    return;
  }

  if (!r.hasMetric) {
    show(r.label, `<div class="fw-lead">${escapeHtml(r.note || "No per-row metric for this counter.")}</div>`, sub);
    return;
  }

  const all = r.all || {};
  const ci = all.cluster
    ? `${fmt(all.cluster.lo)} … ${fmt(all.cluster.hi)}`
    : "too few days to bootstrap";
  const zero = all.cluster?.zeroInside !== false;

  const verdict =
    `<div class="fw-verdict ${r.verdict === "passes" ? "is-pass" : "is-fail"}">` +
      `<div class="fw-verdict-icon">${icon(r.verdict === "passes" ? "check" : "blocked")}</div>` +
      `<div><div class="fw-verdict-head">${r.verdict === "passes" ? "Clears the preregistered bar" : "Does not clear the bar"}</div>` +
      `<ul class="fw-checks">${(r.checks || [])
        .map((c) => `<li class="${c.pass ? "fw-pos" : "fw-neg"}">${icon(c.pass ? "check" : "close")}${escapeHtml(c.label)}</li>`)
        .join("")}</ul></div>` +
    `</div>`;

  const headline =
    `<div class="fw-headline">` +
      `<div><span>mean</span><b>${fmt(all.stats?.mean)}${escapeHtml(r.metric?.unit || "")}</b></div>` +
      `<div><span>clustered CI95</span><b class="${zero ? "fw-neg" : "fw-pos"}">${ci}</b></div>` +
      `<div><span>n</span><b>${all.n ?? 0}</b></div>` +
    `</div>` +
    `<div class="fw-metric-note">${escapeHtml(r.metric?.label || "")} · CI is bootstrapped over whole days` +
    `${all.cluster?.days ? ` (${all.cluster.days} days)` : ""}</div>`;

  const winLoseTable =
    `<table class="table table--compact fw-table"><thead><tr>` +
      `<th>Cut</th><th class="num">n</th><th class="num">win</th><th class="num">lose</th>` +
      `<th class="num">winrate</th><th class="num">avg win</th><th class="num">avg lose</th>` +
      `<th class="num">payoff</th><th class="num">mean</th></tr></thead><tbody>` +
      [{ ...all, label: "All" }, ...(r.cells || [])].map(cellRow).join("") +
    `</tbody></table>`;

  const legs = (r.legs || []).length
    ? `<div class="fw-sub-h">Legs of the pair</div>` +
      `<table class="table table--compact fw-table"><thead><tr>` +
      `<th>Leg</th><th class="num">n</th><th class="num">winrate</th><th class="num">mean</th></tr></thead><tbody>` +
      r.legs.map((l) =>
        `<tr><td>${escapeHtml(l.label)}</td><td class="num">${l.n}</td>` +
        `<td class="num">${pct(l.winRate)}</td><td class="num">${fmt(l.stats?.mean)}</td></tr>`).join("") +
      `</tbody></table>`
    : "";

  show(
    r.label,
    (r.peeked ? `<div class="fw-warn">${icon("warn")}<span>Read before the threshold — this peek is logged.</span></div>` : "") +
      verdict + headline + winLoseTable + legs + stopRuleHtml(p),
    sub,
  );
}

/** Стоп-правило словами: в реестре оно по-русски, в интерфейс идут пороги. */
function stopRuleHtml(p) {
  if (p?.target == null) return "";
  const parts = [`${p.target} ${escapeHtml(p.unit || "")}`];
  if (p.minCalendarDays) parts.push(`${p.minCalendarDays} calendar days`);
  if (p.minRegimeShare) parts.push(`both BTC regimes at ${Math.round(p.minRegimeShare * 100)}%+`);
  return `<div class="fw-rule"><b>Stop rule:</b> ${parts.join(" · ")}. Evaluated once, ` +
    `and it clears only with the mean above zero, a clustered CI off zero, and the same sign in both regimes.</div>`;
}

function cellRow(c) {
  return (
    `<tr><td>${escapeHtml(c.label)}</td>` +
    `<td class="num">${c.n}</td>` +
    `<td class="num">${c.wins}</td>` +
    `<td class="num">${c.losses}</td>` +
    `<td class="num">${pct(c.winRate)}</td>` +
    `<td class="num">${fmt(c.meanWin)}</td>` +
    `<td class="num">${fmt(c.meanLoss)}</td>` +
    `<td class="num">${c.payoff != null ? c.payoff.toFixed(2) : "—"}</td>` +
    `<td class="num ${c.stats?.mean > 0 ? "fw-pos" : "fw-neg"}">${fmt(c.stats?.mean)}</td></tr>`
  );
}
