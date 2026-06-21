// ─────────────────────────────────────────────────
//  Fade-лист — выдохшиеся хвосты (forward-вход) ОТДЕЛЬНОЙ карточкой
// ─────────────────────────────────────────────────
// Зачем отдельно от Hot Movers: Hot Movers — OI-классификатор с ~90% LONG-перекосом,
// её continuation бэктестится в МИНУС (см. memory hotmovers_long_bias / darkknight_
// backtest). Единственный forward-вход, переживший OOS — fade выдохшегося хвоста
// (high-ER), и он почти всегда SHORT. Он уже считается сервером (enrichFadeHot →
// signals[].fadeHot), но тонул под-строкой в шумной таблице Hot Movers. Здесь —
// чистый список тех же fired-сетапов: монета + сторона + зона + стоп. Это watchlist,
// а не «вход»: кнопка «Разбор» открывает коуч (whatif-модалку) — между сигналом и
// сделкой всегда стоит разбор графика + стоп. Никакого нового расчёта/HL-веса.

import { escapeHtml } from "../utils/format.js";

function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function renderFadeList(payload, fmtTime) {
  const tbody = document.getElementById("fade-list-tbody");
  const meta = document.getElementById("fade-list-meta");
  if (!tbody) return;

  const signals = Array.isArray(payload?.signals) ? payload.signals : [];
  const fades = signals
    .filter((s) => s.fadeHot?.fired)
    .map((s) => ({ coin: s.coin, price: s.price, ...s.fadeHot }));

  if (meta) {
    meta.textContent = payload?.ts
      ? fades.length
        ? `${fades.length} выдохш. хвост${fades.length === 1 ? "" : "а/ов"} · ${fmtTime(payload.ts)}`
        : `тихо · ${fmtTime(payload.ts)}`
      : "—";
  }

  if (fades.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">Выдохшихся хвостов сейчас нет — это норма (≈0.3% времени). Жди 🔥, не выдумывай вход.</td></tr>';
    return;
  }

  tbody.innerHTML = fades
    .map((f) => {
      const isShort = f.side === "SHORT";
      const sideCls = isShort ? "num-neg" : "num-pos";
      const arrow = isShort ? "▼" : "▲";
      const zone =
        f.zoneLo != null && f.zoneHi != null
          ? `$${fmtPrice(f.zoneLo)}–$${fmtPrice(f.zoneHi)}`
          : `$${fmtPrice(f.price)}`;
      const stop = f.stop != null ? `$${fmtPrice(f.stop)}` : "—";
      const stopPct = f.stopPct != null ? ` (${f.stopPct}%)` : "";
      const er = f.er != null ? f.er.toFixed(2) : "—";
      const exit =
        f.timeStopMin != null ? `~${Math.round(f.timeStopMin / 60)}ч` : "~2ч";
      return `
      <tr>
        <td><span class="signals-price">#${escapeHtml(f.coin)}</span></td>
        <td class="c ${sideCls}"><strong>${arrow} ${escapeHtml(f.side || "")}</strong></td>
        <td class="r">${fmtPct(f.move)}</td>
        <td class="r">${er}</td>
        <td class="fade-plan">
          <span class="fade-zone">${zone}</span>
          <span class="fade-stop">стоп ${stop}${stopPct} · выход ${exit}</span>
        </td>
        <td class="c">
          <button type="button" class="fade-coach-btn" data-fade-coach
            data-coin="${escapeHtml(f.coin)}" data-side="${escapeHtml(f.side || "")}"
            title="Открыть разбор графика #${escapeHtml(f.coin)} (${escapeHtml(f.side || "")}) перед входом">Разбор</button>
        </td>
      </tr>`;
    })
    .join("");
}
