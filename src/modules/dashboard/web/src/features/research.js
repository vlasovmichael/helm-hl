// ─────────────────────────────────────────────────
//  Research — витрина прогресса форварда FVG
//  28.08.2026: «Качество исполнения», «Цена дисциплины» и «Чужие прогнозы»
//  сняты вместе со своими карточками. Осталась одна витрина — счётчик
//  предзаявленного форварда, и она намеренно не показывает метрик.
// ─────────────────────────────────────────────────
// Правило этих карточек: они показывают ВОЗРАСТ данных и СТАТУС «отличимо ли
// от нуля», а не только красивое среднее. Причина конкретная: карточка
// Spike-Fade три недели показывала замёрзший снимок как живой, потому что
// возраст нигде не выводился. Здесь протухание видно сразу и красным.

import { fetchJson } from "../net/api.js";

const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const usd = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}` : "—");
const col = (v) => (!Number.isFinite(v) || v === 0 ? "" : `color:${v > 0 ? "var(--green)" : "var(--red)"}`);
export async function refreshFvgForward() {
  const body = document.getElementById("fvg-body");
  const meta = document.getElementById("fvg-meta");
  if (!body) return;

  let res;
  try {
    res = await fetchJson("/api/fvg-forward");
  } catch {
    body.innerHTML = `<div class="empty-state">no connection</div>`;
    return;
  }
  if (!res?.ok) {
    body.innerHTML = `<div class="empty-state">no data</div>`;
    return;
  }

  const pct = Math.min(100, res.pct || 0);
  // Молчание коллектора должно быть видно сразу. Порог щедрый: сделок мало по
  // самой природе правила (широкие зоны редки), поэтому сутки тишины — норма,
  // а вот трое суток уже повод посмотреть лог крона.
  const stale = res.staleHours != null && res.staleHours > 72;
  const started = res.n === 0 && res.daysRunning < 1;

  if (meta) {
    meta.textContent = started
      ? "started Aug 29"
      : stale
        ? `last entry ${Math.round(res.staleHours)}h ago`
        : `${res.n} of ${res.target}`;
    meta.style.color = stale ? "var(--red)" : "var(--text-muted)";
  }

  const bar =
    `<div style="height:6px;background:var(--bg-elevated);border-radius:3px;overflow:hidden;margin:6px 0 10px">` +
    `<div style="height:100%;width:${pct.toFixed(1)}%;background:var(--accent)"></div></div>`;

  const rows = [
    `<b>${res.n}</b> of ${res.target} trades · ${pct.toFixed(1)}%`,
    res.perDay
      ? `pace ${res.perDay.toFixed(1)}/day · at that rate the threshold lands near <b>${res.etaISO}</b>`
      : `pace shows up after the first full day`,
    res.decisionRule +
      ` — E[R], winrate and trade signs are hidden <b>on purpose</b>: ` +
      `peeking at an interim result invalidates the whole forward test.`,
  ];
  if (stale) {
    rows.push(
      `<span style="color:var(--red)">Collector silent for over three days — check logs/fvg-forward.log on Oracle.</span>`,
    );
  }

  body.innerHTML =
    bar + rows.map((r) => `<div style="line-height:1.7">${r}</div>`).join("");
}
