// ─────────────────────────────────────────────────
//  «А если взять троих?» — витрина предзаявленного форвардного теста.
//  Список заморожен 13.08.2026, правила в docs/winners-preregistration.md.
//
//  Витрина намеренно показывает ТРИ вещи рядом: результат выбранных, результат
//  контрольной группы и дату решения. Первое без второго — это история успеха,
//  а не измерение; без третьего — соблазн объявить победу в удачный день.
// ─────────────────────────────────────────────────

import { fetchJson } from "../net/api.js";

const bp = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}` : "—");
const col = (v) =>
  !Number.isFinite(v) || v === 0 ? "" : `color:${v > 0 ? "var(--green)" : "var(--red)"}`;

const usd = (v) => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
  return `${s}$${Math.round(a)}`;
};

const short = (addr) => `${addr.slice(0, 8)}…${addr.slice(-4)}`;

const VERDICT_STYLE = {
  "подтверждено": "var(--green)",
  "не подтверждено": "var(--red)",
  "рано": "var(--text-muted)",
};

function renderRows(tbody, res) {
  tbody.innerHTML = res.selected
    .map((s) => `<tr>
      <td style="font-family:var(--font-mono)"><a href="https://app.hyperliquid.xyz/explorer/address/${s.address}" target="_blank" rel="noopener" style="color:inherit">${short(s.address)}</a></td>
      <td class="r">${bp(s.selectionEdgeBp)}</td>
      <td class="r" style="${col(s.forwardEdgeBp)}">${s.forwardEdgeBp === null ? "<span style='color:var(--text-muted)'>не торговал</span>" : bp(s.forwardEdgeBp)}</td>
      <td class="r" style="${col(s.forwardPnl)}">${s.forwardPnl === null ? "—" : usd(s.forwardPnl)}</td>
      <td class="r">${s.forwardVolume === null ? "—" : usd(s.forwardVolume)}</td>
    </tr>`)
    .join("");
}

function renderSummary(res) {
  const f = res.forward;
  const rows = [];

  if (f) {
    const beatsControl =
      Number.isFinite(f.selectedMedianBp) && Number.isFinite(f.controlMedianBp)
        ? f.selectedMedianBp > f.controlMedianBp
        : null;

    rows.push(
      `Форвард ${f.from} → ${f.to} (${f.days} дн.): медиана выбранных <b style="${col(f.selectedMedianBp)}">${bp(f.selectedMedianBp)} бп</b> · ` +
      `контроль (${f.controlCount} адресов, те же фильтры) <b style="${col(f.controlMedianBp)}">${bp(f.controlMedianBp)} бп</b>` +
      (beatsControl === null ? "" : beatsControl ? " → отбор пока впереди" : " → отбор пока не помогает"),
    );
  } else {
    rows.push("Форвард ещё не считался: <code>node tools/winners.mjs track</code>");
  }

  rows.push(
    `Отобраны 13.08 из ${res.poolSize} прошедших фильтры (счёт ≥ $${(res.rules.minAccountValue / 1e3).toFixed(0)}k, ` +
    `оборот ≥ ${res.rules.minTurnover}× счёта, эдж ≤ ${res.rules.maxPlausibleEdgeBp} бп) по окну ${res.selectionFrom}–${res.selectionTo}.`,
  );
  rows.push(
    `Промежуточный взгляд ${res.interimDate} <b>ничего не решает</b>. Дата решения — <b>${res.decisionDate}</b>: ` +
    `нужно обогнать контроль И превысить +${res.successEdgeBp} бп, иначе гипотеза закрывается.`,
  );
  rows.push(
    "⚠️ Даже подтверждение ≠ деньги: маркет-мейкеров скопировать нечем (прибыль в спреде), " +
    "сделки видны постфактум, а на тонком эдже комиссии съедают результат первыми.",
  );

  return rows.map((r) => `<div>${r}</div>`).join("");
}

export async function refreshWinners() {
  const tbody = document.getElementById("win-tbody");
  const meta = document.getElementById("win-meta");
  const stats = document.getElementById("win-stats");
  if (!tbody) return;

  const fail = (msg) => {
    if (meta) meta.textContent = msg;
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${msg}</td></tr>`;
    if (stats) stats.innerHTML = "";
  };

  let res;
  try {
    res = await fetchJson("/api/winners");
  } catch {
    fail("нет связи");
    return;
  }
  if (!res?.ok) {
    fail(res?.reason === "not-frozen" ? "список не заморожен" : "нет данных");
    return;
  }

  const verdict = res.forward?.verdict ?? "рано";
  if (meta) {
    meta.textContent = `вердикт: ${verdict}`;
    meta.style.color = VERDICT_STYLE[verdict] ?? "var(--text-muted)";
  }
  renderRows(tbody, res);
  if (stats) stats.innerHTML = renderSummary(res);
}
