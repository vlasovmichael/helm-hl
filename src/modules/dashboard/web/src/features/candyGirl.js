// ─────────────────────────────────────────────────
//  Candy Girl — signal-only радар (1h EMA-тренд + 5m pullback-reclaim).
//  Приватный кэш сигналов; renderSmartSignals (main) читает его через
//  getCandySignals(). Обновление Smart Signals дёргаем через колбэк
//  setOnCandyUpdate (main вешает gated-renderSmartSignals) — без цикла.
// ─────────────────────────────────────────────────

import { fmtPct, fmtUsd } from "../utils/format.js";
import { isActiveCoin } from "../state/activeCoins.js";

let _cgSignalsCache = [];
export function getCandySignals() {
  return _cgSignalsCache;
}
let onCandyUpdate = () => {};
export function setOnCandyUpdate(cb) {
  onCandyUpdate = cb;
}

// ── Candy Girl — signal-only радар (1h EMA-тренд + 5m pullback-reclaim) ──────
export function renderCandyGirl(cg) {
  _cgSignalsCache = Array.isArray(cg?.signals) ? cg.signals : [];
  onCandyUpdate();

  const card = document.getElementById("sec-candygirl");
  if (!card) return;
  if (!cg || !cg.enabled) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const fmtAge = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  };
  const fmtPx = (v) => (v == null ? "—" : `$${Number(v).toFixed(6)}`);
  const trendIcon = (t) =>
    t === "up"
      ? '<span style="color:var(--green,#3ddc84)">▲ up</span>'
      : t === "down"
        ? '<span style="color:var(--red,#ff5c5c)">▼ down</span>'
        : '<span style="opacity:.5">—</span>';

  const tbody = document.getElementById("cg-signals-tbody");
  if (tbody) {
    const signals = Array.isArray(cg.signals) ? cg.signals : [];
    if (signals.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="empty-state">no setups yet</td></tr>';
      card.removeAttribute("data-badge-text");
    } else {
      tbody.innerHTML = signals
        .map((s) => {
          const isLong = s.direction === "LONG";
          const dir = isLong
            ? '<span style="color:var(--green,#3ddc84)">🟢 LONG</span>'
            : '<span style="color:var(--red,#ff5c5c)">🔴 SHORT</span>';
          const risk = Math.abs((s.entry ?? 0) - (s.sl ?? 0));
          const rr =
            risk > 0
              ? (Math.abs((s.tp ?? 0) - (s.entry ?? 0)) / risk).toFixed(1)
              : "?";
          const activeCls = isActiveCoin(s.coin) ? " is-active" : "";
          return (
            `<tr class="cg-sig-row ${isLong ? "dir-long" : "dir-short"}${activeCls}">` +
            `<td>${dir}</td>` +
            `<td><b>#${s.coin}</b></td>` +
            `<td>$${s.price}</td>` +
            `<td>${fmtPx(s.entry)}</td>` +
            `<td>${fmtPx(s.sl)}</td>` +
            `<td>${fmtPx(s.tp)}</td>` +
            `<td>${rr}</td>` +
            `<td>${trendIcon(s.trend4h)}</td>` +
            `<td>${fmtAge(s.ts)}</td>` +
            `</tr>`
          );
        })
        .join("");
      const top = signals[0];
      const d = top.direction === "LONG" ? "▲" : "▼";
      card.setAttribute(
        "data-badge-text",
        `${d} ${top.coin} · ${fmtAge(top.ts)}`,
      );
    }
  }

  // Точность сигналов (TP-before-SL). Показываем только когда есть решённые.
  const accEl = document.getElementById("candygirl-acc");
  if (accEl) {
    const st = cg.stats;
    const decided = st ? (st.win || 0) + (st.loss || 0) : 0;
    if (st && decided > 0) {
      const pct = Math.round((st.winRate ?? 0) * 100);
      accEl.style.display = "";
      accEl.textContent = `acc ${pct}% (${st.win}W/${st.loss}L · ${st.open} open)`;
    } else if (st && st.open > 0) {
      accEl.style.display = "";
      accEl.textContent = `${st.open} open · collecting`;
    } else {
      accEl.style.display = "none";
    }
  }

  const hb = cg.heartbeat;
  const hbEl = document.getElementById("cg-heartbeat");
  if (hbEl) {
    hbEl.textContent = hb
      ? `tracked=${hb.tracked} · trending=${hb.trending} · signals=${hb.signals} · cooldowns=${hb.cooldowns}`
      : "—";
  }
  const pill = document.getElementById("candygirl-hb");
  if (pill) {
    if (hb) {
      pill.style.display = "";
      pill.textContent = `${hb.trending} trending`;
    } else {
      pill.style.display = "none";
    }
  }

  // Paper shadow-слот (Iter 2): equity-пилюля + активная позиция + история.
  const eqPill = document.getElementById("candygirl-card-equity");
  if (eqPill) {
    const ve = cg.virtualEquity;
    if (ve && cg.virtualBalance > 0) {
      const pnl = ve.pnlTotal ?? 0;
      const sign = pnl >= 0 ? "+" : "−";
      eqPill.style.display = "";
      eqPill.textContent = `paper $${ve.equity.toFixed(2)} (${sign}$${Math.abs(pnl).toFixed(2)})`;
      eqPill.style.color =
        pnl >= 0 ? "var(--green,#3ddc84)" : "var(--red,#ff5c5c)";
    } else {
      eqPill.style.display = "none";
    }
  }
  renderCandyGirlActivePos(cg.paperPosition);
  renderCandyGirlHistory(cg.paperTrades, cg.paperStats, cg.paperPeriod);
}

function renderCandyGirlActivePos(pos) {
  const section = document.getElementById("cg-active-section");
  const body = document.getElementById("cg-active-body");
  if (!section || !body) return;
  if (!pos) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const fmtPx = (v) => (v == null ? "—" : `$${v.toFixed(6)}`);
  const pnlCls =
    (pos.unrealUsd ?? 0) >= 0 ? "cb-pos-pnl positive" : "cb-pos-pnl negative";
  const heldStr =
    pos.heldMin >= 60
      ? `${Math.floor(pos.heldMin / 60)}h ${pos.heldMin % 60}m`
      : `${pos.heldMin}m`;
  const sl = `${fmtPx(pos.slPrice)}${pos.slDistPct != null ? ` <span style="opacity:.6">(${pos.slDistPct.toFixed(2)}%)</span>` : ""}`;
  const tp = `${fmtPx(pos.tpPrice)}${pos.tpDistPct != null ? ` <span style="opacity:.6">(${pos.tpDistPct.toFixed(2)}%)</span>` : ""}`;

  body.innerHTML = `
    <table class="cb-table">
      <thead><tr>
        <th>Coin</th><th>Side</th><th>Size</th><th>Entry → Cur</th>
        <th>Unreal</th><th>Held</th><th>SL</th><th>TP</th>
      </tr></thead>
      <tbody><tr>
        <td><b>${pos.coin}</b></td>
        <td>${(pos.side || "").toUpperCase()}</td>
        <td>$${pos.sizeUsd.toFixed(2)}</td>
        <td>${fmtPx(pos.entryPrice)}<br><span style="opacity:.65">${fmtPx(pos.currentPrice)}</span></td>
        <td><span class="${pnlCls}"><b>${fmtUsd(pos.unrealUsd)}</b><br>${fmtPct(pos.unrealPct)}</span></td>
        <td>${heldStr}</td>
        <td>${sl}</td>
        <td>${tp}</td>
      </tr></tbody>
    </table>
  `;
}

function renderCandyGirlHistory(trades, stats, period) {
  const body = document.getElementById("cg-history-body");
  const inline = document.getElementById("cg-stats-inline");
  if (!body) return;

  if (inline && stats && stats.n > 0) {
    const fmt = (v) =>
      v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    inline.textContent = `n=${stats.n} · net ${fmt(stats.sumNet)} · avg ${fmt(stats.avgNet)} · win ${(stats.winRate * 100).toFixed(0)}% · best ${fmt(stats.bestNet)} · worst ${fmt(stats.worstNet)}`;
  } else if (inline) {
    inline.textContent = "";
  }

  // Summary под таблицей: P&L за день и за неделю (профит/убыток paper-слота).
  const periodHtml = (() => {
    if (!period) return "";
    const cell = (label, p) => {
      const net = p?.net ?? 0;
      const n = p?.n ?? 0;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      const txt =
        net >= 0 ? `+$${net.toFixed(2)}` : `-$${Math.abs(net).toFixed(2)}`;
      return (
        `<span class="cg-sum-item"><span class="cg-sum-label">${label}</span>` +
        `<b style="color:${color}">${txt}</b> <span style="opacity:.55">(${n})</span></span>`
      );
    };
    return `<div class="cg-summary">${cell("Today", period.day)}${cell("Week", period.week)}</div>`;
  })();

  if (!Array.isArray(trades) || trades.length === 0) {
    body.innerHTML =
      '<div class="empty-state">no closed trades yet</div>' + periodHtml;
    return;
  }
  const fmtUsd = (v) =>
    v == null
      ? "—"
      : v >= 0
        ? `+$${v.toFixed(2)}`
        : `-$${Math.abs(v).toFixed(2)}`;
  const fmtTs = (ms) => {
    if (!ms) return "—";
    const dt = new Date(ms);
    return `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  };
  const fmtHold = (sec) => {
    if (sec == null) return "—";
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  };
  const rows = trades
    .map((t) => {
      const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
      <td>${fmtTs(t.entry_time)}<br><span style="opacity:.65">${fmtTs(t.closed_at)}</span></td>
      <td><b>${t.coin}</b><br><span style="opacity:.65">${(t.side || "").toUpperCase()}</span></td>
      <td>$${(t.entry_price ?? 0).toFixed(6)}<br><span style="opacity:.65">$${(t.close_price ?? 0).toFixed(6)}</span></td>
      <td style="color:${color}"><b>${fmtUsd(net)}</b></td>
      <td>${fmtHold(t.hold_seconds)}</td>
      <td style="opacity:.75">${t.reason || "—"}</td>
    </tr>`;
    })
    .join("");
  body.innerHTML =
    `
    <table class="cb-table">
      <thead><tr><th>Open / Close</th><th>Coin</th><th>Entry / Exit</th><th>Net</th><th>Held</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  ` + periodHtml;
}
