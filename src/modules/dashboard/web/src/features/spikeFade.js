// ─────────────────────────────────────────────────
//  Spike-Fade — витрина бумажного замера «скальпа фитилей».
//  Тянет /api/spike-fade (данные от tools/spikeFadeMeasure.mjs, отдельный
//  контейнер-наблюдатель). Показывает expectancy по стороне и по монетам.
//  Это forward-замер гипотезы, НЕ сигнал: n<20 = шум. 2026-07-17.
// ─────────────────────────────────────────────────

import { fetchJson } from "../net/api.js";

const pct = (v, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;

// Знаковая раскраска инлайном (зелёный плюс / красный минус) — как в divergence.
const col = (v) =>
  v == null || !Number.isFinite(v) || v === 0
    ? ""
    : `color:${v > 0 ? "var(--green)" : "var(--red)"}`;

function sideRow(label, s) {
  if (!s) return `<tr><td>${label}</td><td colspan="6" class="empty-state">нет событий</td></tr>`;
  return `<tr>
    <td>${label}</td>
    <td class="r">${s.n}</td>
    <td class="r">${s.winRate.toFixed(0)}%</td>
    <td class="r" style="${col(s.exp)}">${pct(s.exp, 3)}</td>
    <td class="r" style="${col(s.sum)}">${pct(s.sum, 1)}</td>
    <td class="r">${pct(s.avgMfe)}</td>
    <td class="r">${pct(s.avgMae)}</td>
  </tr>`;
}

function coinRow(c) {
  return `<tr>
    <td>${c.coin}</td>
    <td class="r">${c.n}</td>
    <td class="r">${c.winRate.toFixed(0)}%</td>
    <td class="r" style="${col(c.exp)}">${pct(c.exp, 3)}</td>
    <td class="r" style="${col(c.sum)}">${pct(c.sum, 1)}</td>
  </tr>`;
}

export async function refreshSpikeFade() {
  const meta = document.getElementById("sf-meta");
  const sideBody = document.getElementById("sf-side-tbody");
  const coinBody = document.getElementById("sf-coin-tbody");
  if (!sideBody || !coinBody) return;

  let d;
  try {
    d = await fetchJson("/api/spike-fade");
  } catch {
    if (meta) meta.textContent = "нет связи";
    return;
  }

  if (!d || d.ok === false || !d.count) {
    if (meta) meta.textContent = "накапливаем события…";
    sideBody.innerHTML = `<tr><td colspan="7" class="empty-state">пока ни одного вика ≥3% не пойман</td></tr>`;
    coinBody.innerHTML = `<tr><td colspan="5" class="empty-state">—</td></tr>`;
    return;
  }

  const reason = Object.entries(d.byReason || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  if (meta) {
    meta.textContent =
      `${d.count} событий · ~${d.spanHours.toFixed(0)}ч · ${reason}` +
      (d.count < 20 ? " · n<20 = шум" : "");
  }

  sideBody.innerHTML =
    sideRow("Все", d.all) + sideRow("Short (рост)", d.short) + sideRow("Long (падение)", d.long);

  coinBody.innerHTML = (d.coins || []).slice(0, 12).map(coinRow).join("") ||
    `<tr><td colspan="5" class="empty-state">—</td></tr>`;
}
