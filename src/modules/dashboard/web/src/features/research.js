// ─────────────────────────────────────────────────
// Research — витрина прогресса форвард-тестов
// Осталась одна витрина — счётчик предзаявленного форварда, и метрик она
// намеренно не показывает.
// ─────────────────────────────────────────────────
// 🚨 Карточка обязана показывать ВОЗРАСТ данных и статус «отличимо ли от нуля»,
// а не только красивое среднее: без возраста замёрзший снимок неделями
// выглядит живым.

import { fetchJson } from "../net/api.js";
import { escapeHtml } from "../utils/format.js";
import { emptyState } from "../core/placeholders.js";

export async function refreshFvgForward() {
  const body = document.getElementById("fvg-body");
  const meta = document.getElementById("fvg-meta");
  if (!body) return;

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
    `<div style="margin-top:10px;line-height:1.7;color:var(--text-muted)">` +
    `E[R], winrate and trade signs are hidden <b>on purpose</b>: peeking at an interim ` +
    `result invalidates the forward test. ${escapeHtml(res.decisionRule || "")}</div>`;
}

/** Одна строка накопителя. Метрик результата здесь нет и быть не должно. */
function renderForward(f) {
  const pct = Math.min(100, f.pct || 0);
  // Молчание коллектора видно сразу и красным: замёрзший снимок, выданный за
  // живой, уже стоил трёх недель на Spike-Fade. Порог щедрый — сделки редки.
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

  const barColor = ready ? "var(--green)" : "var(--accent)";
  return (
    `<div style="margin-bottom:12px">` +
      `<div style="display:flex;justify-content:space-between;gap:8px">` +
        `<span>${escapeHtml(f.label)}</span>` +
        `<span style="color:${stale ? "var(--red)" : "var(--text-muted)"}">` +
          `<b>${f.n}</b> / ${f.target} ${escapeHtml(f.unit)}</span>` +
      `</div>` +
      `<div style="height:6px;background:var(--bg-elevated);border-radius:3px;overflow:hidden;margin:5px 0 4px">` +
        `<div style="height:100%;width:${pct.toFixed(1)}%;background:${barColor}"></div></div>` +
      `<div style="color:var(--text-muted);line-height:1.6">${pace}` +
        (gates.length ? ` · still needs ${escapeHtml(gates.join(", "))}` : "") +
        (stale ? ` · <span style="color:var(--red)">silent ${Math.round(f.staleHours)}h</span>` : "") +
      `</div>` +
    `</div>`
  );
}
