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
