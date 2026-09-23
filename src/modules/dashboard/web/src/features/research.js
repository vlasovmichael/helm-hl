// Research — витрина форвард-тестов и разбор теста по клику.
// 🚨 Возраст данных обязателен: без него замёрзший снимок выглядит живым.
// Разбор незакрытого теста — только за подтверждением, просмотр пишется в
// data/hypotheses/peeks.jsonl.

import { fetchJson } from "../net/api.js";
import { escapeHtml } from "../utils/format.js";
import { emptyState } from "../core/placeholders.js";
import * as dialog from "../core/dialog.js";
import { icon } from "../core/icon.js";
import { badge, button } from "../core/ui.js";

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

  const ready = res.items.filter((f) => f.ready).length;
  const silent = res.items.filter((f) => f.silent).length;
  if (meta) {
    meta.textContent = [
      `${res.items.length} running`,
      ready ? `${ready} at threshold` : "",
      silent ? `${silent} silent` : "",
    ].filter(Boolean).join(" · ");
    meta.classList.toggle("is-ready", ready > 0 && !silent);
    meta.classList.toggle("is-stale", silent > 0);
  }

  body.innerHTML =
    (res.items.length ? res.items.map(renderForward).join("") : "") +
    renderFinished(res.finished || []) +
    renderIdle(res.idle || []) +
    `<div class="fw-note">E[R], winrate and trade signs stay off this card <b>on purpose</b>: ` +
    `an interim result invalidates the test. When a stop rule is met, the watcher runs the ` +
    `preregistered evaluation once and pushes the result. Failed verdicts stay listed for a week, ` +
    `passed ones stay. ${escapeHtml(res.decisionRule || "")}</div>`;
}

const RESULT = {
  PASSED_ECONOMICS: { label: "passed", tone: "long" },
  PASSED_STAT: { label: "stat only", tone: "" },
  INCONCLUSIVE: { label: "inconclusive", tone: "" },
  REJECTED: { label: "rejected", tone: "short" },
};

const shortDate = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—");

/** Закрытые недавно: исход из реестра и дата, когда строка уйдёт сама. */
function renderFinished(list) {
  if (!list.length) return "";
  return (
    `<div class="fw-section">Finished</div>` +
    list.map((h) => {
      const r = RESULT[h.resultStatus] || { label: "closed", tone: "" };
      return (
        `<div class="fw-done">` +
          `<span class="fw-label">${escapeHtml(h.label)}</span>` +
          `<span class="fw-done-meta">${badge({ label: r.label, tone: r.tone })}` +
            `<span>closed ${shortDate(h.closedAt)}` +
            (h.hidesAt ? ` · hides ${shortDate(h.hidesAt)}` : " · stays") +
            `</span></span>` +
        `</div>`
      );
    }).join("")
  );
}

/** Открытые в реестре, но без живого сборщика: иначе их не видно нигде. */
function renderIdle(ids) {
  if (!ids.length) return "";
  return (
    `<div class="fw-section">Open without a collector</div>` +
    `<div class="fw-idle">${ids.map((id) => `<code>${escapeHtml(id)}</code>`).join(" ")}</div>`
  );
}

/** Одна строка накопителя. Метрик результата здесь нет и быть не должно. */
function renderForward(f) {
  const pct = Math.min(100, f.pct || 0);
  const notStarted = f.n === 0 && f.daysRunning < 1;

  // Условия сверх счётчика: без них порог можно набрать за неделю внутри
  // одного рыночного режима, и результат будет про погоду, а не про правило.
  const gates = [];
  if (f.minDaysRunning && f.daysRunning < f.minDaysRunning) {
    gates.push(`${Math.floor(f.daysRunning)}/${f.minDaysRunning} days running`);
  }
  if (f.minCalendarDays && f.calendarDays < f.minCalendarDays) {
    gates.push(`${f.calendarDays}/${f.minCalendarDays} calendar days`);
  }
  if (f.minRegimeShare && (f.regimeShare ?? 0) < f.minRegimeShare) {
    gates.push(`regime split ${Math.round((f.regimeShare ?? 0) * 100)}% (needs ${Math.round(f.minRegimeShare * 100)}%)`);
  }
  if (f.groups && !f.groupReady) {
    const cohorts = Object.entries(f.groups)
      .map(([name, n]) => `${name} ${n}/${f.minPerGroup}`)
      .join(", ");
    gates.push(`cohorts ${cohorts || `0/${f.minPerGroup}`}`);
  }

  // Зелёная строка = стоп-правило выполнено целиком, не только счётчик:
  // набранное n при незакрытых гейтах толкает подглядывать в незрелый форвард.
  const status = f.ready
    ? f.autoEvalAt
      ? ` · evaluated ${shortDate(Date.parse(f.autoEvalAt))}, awaiting the registry`
      : " · stop rule met, awaiting evaluation"
    : "";

  const pace = notStarted
    ? "starts with the next collector run"
    : f.perDay
      ? `pace ${f.perDay.toFixed(1)}/day` + (f.etaISO ? ` · threshold near <b>${f.etaISO}</b>` : "")
      : "pace shows up after the first full day";

  const silence = f.silent
    ? ` · <span class="fw-stale">silent ${f.staleHours == null ? "since start" : `${Math.round(f.staleHours)}h`}</span>`
    : "";

  return (
    `<button type="button" class="fw-row${f.ready ? " is-ready" : ""}" data-forward="${escapeHtml(f.id)}">` +
      `<div class="fw-head">` +
        `<span class="fw-label">${escapeHtml(f.label)}</span>` +
        `<span class="fw-count${f.silent ? " is-stale" : ""}"><b>${f.n}</b> / ${f.target} ${escapeHtml(f.unit)}` +
        `${icon("collapsed", { cls: "fw-caret" })}</span>` +
      `</div>` +
      `<progress class="fw-bar" max="100" value="${pct.toFixed(1)}"></progress>` +
      `<div class="fw-meta">${pace}` +
        (gates.length ? ` · still needs ${escapeHtml(gates.join(", "))}` : "") +
        status + silence +
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
    const ev = r.autoEval;
    const lead = ev
      ? `Evaluated once by the watcher on ${escapeHtml(ev.at.slice(0, 16).replace("T", " "))} UTC ` +
        `with <code>${escapeHtml(ev.command)}</code>. The verdict goes into the registry by hand.`
      : r.evalCommand
        ? `The watcher runs <code>${escapeHtml(r.evalCommand)}</code> once, when the stop rule is met.`
        : "No evaluation script yet: when the stop rule is met, the watcher pushes a reminder instead.";
    show(
      r.label,
      `<div class="fw-lead">${lead}</div>` +
        (ev ? `<pre class="fw-output">${escapeHtml(ev.output || "(no output)")}</pre>` : "") +
        (r.note ? `<div class="fw-rule">${escapeHtml(r.note)}</div>` : ""),
      sub,
    );
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
  if (p.minPerGroup) parts.push(`${p.minPerGroup} observations in each cohort`);
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
