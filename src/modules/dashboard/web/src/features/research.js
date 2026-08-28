// ─────────────────────────────────────────────────
//  Research — витрина накопителя чужих прогнозов (11.08.2026)
//  28.08.2026: «Качество исполнения» и «Цена дисциплины» сняты вместе с
//  карточками — вопросы закрыты.
// ─────────────────────────────────────────────────
// Правило этих карточек: они показывают ВОЗРАСТ данных и СТАТУС «отличимо ли
// от нуля», а не только красивое среднее. Причина конкретная: карточка
// Spike-Fade три недели показывала замёрзший снимок как живой, потому что
// возраст нигде не выводился. Здесь протухание видно сразу и красным.

import { fetchJson } from "../net/api.js";

const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const usd = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}` : "—");
const col = (v) => (!Number.isFinite(v) || v === 0 ? "" : `color:${v > 0 ? "var(--green)" : "var(--red)"}`);

function setMeta(id, text, warn = false) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.style.color = warn ? "var(--red)" : "var(--text-muted)";
  }
}
export async function refreshExternalCalls() {
  const tbody = document.getElementById("calls-tbody");
  if (!tbody) return;
  let d;
  try { d = await fetchJson("/api/external-calls"); } catch { return; }
  if (!d?.ok || !d.calls?.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">журнал пуст</td></tr>`;
    return;
  }
  setMeta("calls-meta", `${d.calls.length} записей · истёкших ${d.settled}`);
  tbody.innerHTML = d.calls.map((c) => {
    const status = c.expired ? "истёк" : `${c.daysLeft} дн`;
    return `<tr>
      <td>${c.source}</td>
      <td>${c.coin} ${c.direction === "above" ? "выше" : "ниже"} $${c.target}</td>
      <td class="r">$${c.pxAtStatement ?? "?"}</td>
      <td class="r">${c.statedAt}</td>
      <td class="r">${c.deadline}</td>
      <td class="r">${status}</td>
    </tr>`;
  }).join("");

  const note = document.getElementById("calls-note");
  if (note) {
    note.textContent = d.settled === 0
      ? "Ни один прогноз ещё не истёк — базрейта нет. Это не «источник хорош», а «судить не на чем»."
      : `Истекло ${d.settled}. Базрейт начинает что-то значить примерно с 20 записей на источник.`;
  }
}

/**
 * Форвард FVG — прогресс и только он.
 *
 * Карточка сознательно не показывает ни одной метрики результата: гипотеза
 * предзаявлена со stopRule n=1500, и промежуточный взгляд ломает тест, даже
 * если потом всё посчитать честно. Показываем ровно две вещи, ради которых
 * витрина и нужна: сколько набрано и не замолчал ли коллектор.
 */
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
