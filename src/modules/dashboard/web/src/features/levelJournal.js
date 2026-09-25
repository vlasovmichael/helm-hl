// ─────────────────────────────────────────────────
//  Level journal — сводка исходов разборов по группам сценариев и последние разборы.
//  Группа чего-то стоит, только если бьёт плацебо; до MIN_TRIGGERED срабатываний
//  цифры группы показываются, но вывод не делается.
// ─────────────────────────────────────────────────

import { esc, fmtPx } from "./levelPlan.js";

export const MIN_TRIGGERED = 30;

const GROUPS = [
  ["break-thin", "Break into thin volume"],
  ["break", "Break elsewhere"],
  ["placebo", "Placebo break"],
  ["bounce", "Bounce from zone"],
];

const SCENARIO_NAMES = {
  "bounce-long": "bounce long",
  "bounce-short": "bounce short",
  "break-up": "break up",
  "break-down": "break down",
};

const rFmt = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R` : "—");
const share = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");

/** Сводка по группам: сколько сработало и что было первым за сутки. */
export function renderJournalSummary(node, journal) {
  if (!node) return;
  const sum = journal?.summary || {};
  const rows = GROUPS.filter(([key]) => sum[key]);
  if (!rows.length) {
    node.innerHTML = `<div class="lv-empty">No outcomes yet. Each read resolves a day after it was opened.</div>`;
    return;
  }
  node.innerHTML = `
    <table class="table table--compact">
      <thead><tr>
        <th>Scenario</th><th class="num">Resolved</th><th class="num">Triggered</th>
        <th class="num">Target first</th><th class="num">Stop first</th><th class="num">Open at 24h</th>
        <th class="num">Avg 4h</th><th class="num">Avg 24h</th>
      </tr></thead>
      <tbody>${rows
        .map(([key, label]) => {
          const g = sum[key];
          const d = g.h24;
          const thin = d.triggered < MIN_TRIGGERED;
          return `<tr${thin ? ' class="muted"' : ""}>
            <td class="strong">${esc(label)}</td>
            <td class="num mono">${g.resolved}</td>
            <td class="num mono">${d.triggered}</td>
            <td class="num mono">${share(d.target, d.triggered)}</td>
            <td class="num mono">${share(d.stop, d.triggered)}</td>
            <td class="num mono">${share(d.open, d.triggered)}</td>
            <td class="num mono">${rFmt(g.h4.avgR)}</td>
            <td class="num mono ${d.avgR > 0 ? "up" : d.avgR < 0 ? "down" : ""}">${rFmt(d.avgR)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>
    <div class="lv-note">R is after fees, stop and target in the same bar count as stop. Grey rows have under ${MIN_TRIGGERED} triggers — too few to read anything into.</div>`;
}

/** Что стало с разбором: сработавшие сценарии и их исход за сутки. */
function outcomeCell(r) {
  if (r.status === "open") return `<span class="muted">resolves in a day</span>`;
  if (r.status === "expired") return `<span class="muted">history ran out</span>`;
  const fired = r.scenarios
    .filter((s) => !s.placebo)
    .map((s) => ({ s, o: r.outcome?.[s.id]?.h24 }))
    .filter(({ o }) => o?.triggered);
  if (!fired.length) return `<span class="muted">nothing triggered</span>`;
  return fired
    .map(
      ({ s, o }) =>
        `<span class="mono ${o.r > 0 ? "up" : o.r < 0 ? "down" : ""}">${esc(SCENARIO_NAMES[s.id] || s.id)}${s.thin ? " · thin" : ""}: ${esc(o.how)} ${rFmt(o.r)}</span>`,
    )
    .join("<br>");
}

/** Последние разборы. */
export function renderJournal(node, journal) {
  if (!node) return;
  const rows = journal?.recent || [];
  if (!rows.length) {
    node.innerHTML = "";
    return;
  }
  const time = (ts) =>
    new Date(ts).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  node.innerHTML = `
    <table class="table table--compact">
      <thead><tr><th>Opened</th><th>Coin</th><th>TF</th><th class="num">Price</th><th>After 24h</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
            <td class="mono">${esc(time(r.ts))}</td>
            <td class="strong">${esc(r.coin)}</td>
            <td class="mono">${esc(r.tf)}</td>
            <td class="num mono">${fmtPx(r.price)}</td>
            <td>${outcomeCell(r)}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>`;
}
