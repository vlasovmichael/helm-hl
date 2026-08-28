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
    body.innerHTML = `<div class="empty-state">нет связи</div>`;
    return;
  }
  if (!res?.ok) {
    body.innerHTML = `<div class="empty-state">нет данных</div>`;
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
      ? "старт 29.08"
      : stale
        ? `последняя запись ${Math.round(res.staleHours)} ч назад`
        : `${res.n} из ${res.target}`;
    meta.style.color = stale ? "var(--red)" : "var(--text-muted)";
  }

  const bar =
    `<div style="height:6px;background:var(--bg-elevated);border-radius:3px;overflow:hidden;margin:6px 0 10px">` +
    `<div style="height:100%;width:${pct.toFixed(1)}%;background:var(--accent)"></div></div>`;

  const rows = [
    `<b>${res.n}</b> из ${res.target} сделок · ${pct.toFixed(1)}%`,
    res.perDay
      ? `темп ${res.perDay.toFixed(1)}/день · при нём порог около <b>${res.etaISO}</b>`
      : `темп будет виден, когда наберутся первые сутки`,
    res.decisionRule +
      ` — E[R], winrate и знак сделок здесь не показываются <b>намеренно</b>: ` +
      `подглядывание в промежуточный результат обесценивает форвард целиком.`,
  ];
  if (stale) {
    rows.push(
      `<span style="color:var(--red)">Коллектор молчит больше трёх суток — проверь logs/fvg-forward.log на Oracle.</span>`,
    );
  }

  body.innerHTML =
    bar + rows.map((r) => `<div style="line-height:1.7">${r}</div>`).join("");
}
