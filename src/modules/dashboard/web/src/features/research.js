// ─────────────────────────────────────────────────
//  Research — витрины трёх накопителей, запущенных 11.08.2026
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

// ── 03 / Качество исполнения ────────────────────────────────────────────────

export async function refreshExecutionQuality() {
  const tbody = document.getElementById("eq-tbody");
  if (!tbody) return;
  let d;
  try { d = await fetchJson("/api/execution-quality"); } catch { return; }
  if (!d?.ok || !d.coins?.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">коллектор ещё не писал</td></tr>`;
    setMeta("eq-meta", "нет данных", true);
    return;
  }
  // Возраст — первое, что должно бросаться в глаза. Крон ходит раз в минуту,
  // поэтому больше 10 минут молчания значит «встал», а не «редко пишет».
  const stale = d.ageMin != null && d.ageMin > 10;
  setMeta(
    "eq-meta",
    stale
      ? `⚠ молчит ${d.ageMin} мин — коллектор встал`
      : `${d.samples} снимков · свежесть ${d.ageMin ?? "?"} мин`,
    stale,
  );

  tbody.innerHTML = d.coins.map((c) => {
    const verdictColor = c.worth === true ? "var(--green)" : c.worth === false ? "var(--red)" : "var(--text-muted)";
    return `<tr>
      <td>${c.coin}</td>
      <td class="r">${num(c.medSpreadBp)}</td>
      <td class="r" style="color:var(--text-muted)">${num(c.p90SpreadBp)}</td>
      <td class="r">$${Math.round(c.medBidDepth ?? 0)} / $${Math.round(c.medAskDepth ?? 0)}</td>
      <td style="color:${verdictColor}">${c.verdict}</td>
    </tr>`;
  }).join("");
}

// ── 04 / Дисциплина ─────────────────────────────────────────────────────────

export async function refreshDiscipline() {
  const tbody = document.getElementById("disc-tbody");
  if (!tbody) return;
  let d;
  try { d = await fetchJson("/api/discipline"); } catch { return; }
  if (!d?.ok || d.empty) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">срез не построен</td></tr>`;
    setMeta("disc-meta", "нет данных", true);
    return;
  }
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "?");
  setMeta("disc-meta", `окно ${day(d.windowFrom)} … ${day(d.windowTo)} · ${d.total} сделок`);

  tbody.innerHTML = d.buckets.map((b) => {
    if (b.weak) return `<tr><td>${b.key}</td><td class="r">${b.n}</td><td colspan="3" class="empty-state">мало</td></tr>`;
    // «ноль внутри CI» выводится словами, потому что цветной минус читается
    // как вывод, а на этих n он им не является.
    return `<tr>
      <td>${b.key}</td>
      <td class="r">${b.n}</td>
      <td class="r" style="${col(b.mean)}">${num(b.mean, 3)}</td>
      <td class="r" style="color:var(--text-muted)">[${num(b.lo, 2)}, ${num(b.hi, 2)}]</td>
      <td class="r" style="${col(b.sum)}">${usd(b.sum)}</td>
    </tr>`;
  }).join("");

  const summary = document.getElementById("disc-summary");
  if (summary) {
    summary.innerHTML =
      `Без защитного ордера прожили <b>${d.nakedCount} из ${d.total}</b> сделок ` +
      `(${d.nakedShare != null ? (100 * d.nakedShare).toFixed(0) : "?"}%), суммарно ${usd(d.nakedSum)}. ` +
      `Медианная задержка постановки стопа — <b>${num(d.medianDelayMin, 1)} мин</b>.` +
      (d.clamped
        ? `<br><span style="color:var(--red)">Окно обрезано по архиву ордеров: раньше него стопы сопоставлять не с чем, и «не было» там означало бы «неизвестно».</span>`
        : "");
  }
}

// ── 05 / Чужие прогнозы ─────────────────────────────────────────────────────

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
