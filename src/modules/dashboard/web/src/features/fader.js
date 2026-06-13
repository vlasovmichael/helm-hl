// ─────────────────────────────────────────────────
//  Fader (Strategy #5) — PAPER-only card. Чистый рендер карточки + сабсекций.
//  renderFaderCard зовёт WS-хендлер; остальное внутреннее.
// ─────────────────────────────────────────────────

import { fmtPct, fmtUsd } from "../utils/format.js";

// ── Fader (Strategy #5) — PAPER-only card ───────────────────
export function renderFaderCard(f) {
  const card = document.getElementById("sec-fader");
  if (!card) return;
  if (!f || !f.enabled) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const equityEl = document.getElementById("fader-equity-pill");
  if (equityEl) {
    if (f.virtualEquity) {
      const ve = f.virtualEquity;
      const sign = ve.pnlTotal >= 0 ? "+" : "-";
      equityEl.style.display = "";
      equityEl.textContent = `$${ve.equity.toFixed(2)} (${sign}$${Math.abs(ve.pnlTotal).toFixed(2)} · ${sign}${Math.abs(ve.pnlPct * 100).toFixed(1)}%)`;
      equityEl.style.color = ve.pnlTotal >= 0 ? "var(--green)" : "var(--red)";
    } else {
      equityEl.style.display = "none";
    }
  }

  renderFaderActivePos(f.paperPosition);
  renderFaderWatchlist(f.heartbeat?.watchlist);
  renderFaderConfig(f.config);
  renderFaderHistory(f.paperTrades, f.paperStats);
  renderFaderHeartbeatRaw(f.heartbeat);
}

function renderFaderActivePos(pos) {
  const section = document.getElementById("fader-active-section");
  const body = document.getElementById("fader-active-body");
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

  body.innerHTML = `
    <div class="cb-kv">
      <div class="k">Coin / side</div>     <div class="v"><b>${pos.coin}</b> · ${pos.side}</div>
      <div class="k">Notional</div>        <div class="v">$${pos.sizeUsd.toFixed(2)}</div>
      <div class="k">Entry / current</div> <div class="v">${fmtPx(pos.entryPrice)} → ${fmtPx(pos.currentPrice)}</div>
      <div class="k">Unrealized</div>      <div class="v"><span class="${pnlCls}">${fmtUsd(pos.unrealUsd)} (${fmtPct(pos.unrealPct)})</span></div>
      <div class="k">MFE / MAE</div>       <div class="v">
        <span style="color:var(--green)">${fmtUsd(pos.mfeUsd)} (${fmtPct(pos.mfePct)})</span> /
        <span style="color:var(--red)">${fmtUsd(pos.maeUsd)} (${fmtPct(pos.maePct)})</span>
      </div>
      <div class="k">Held</div>            <div class="v">${heldStr}</div>
      <div class="k">TP</div>              <div class="v">${fmtPx(pos.tpPrice)} ${pos.tpDistPct != null ? `(${pos.tpDistPct.toFixed(2)}% away)` : ""}</div>
      <div class="k">Impulse@entry</div>   <div class="v">${fmtPct(pos.entry_spike_pct)}</div>
    </div>
  `;
}

function renderFaderWatchlist(items) {
  const body = document.getElementById("fader-watchlist-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<div class="empty-state">no green setups</div>';
    return;
  }
  const rows = items
    .map(
      (w) => `<tr>
    <td><b>${w.coin}</b></td>
    <td>chop ${(w.chopRatio ?? 0).toFixed(2)}</td>
  </tr>`,
    )
    .join("");
  body.innerHTML = `<table class="cb-table"><thead><tr><th>Coin</th><th>chopRatio</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFaderConfig(cfg) {
  const body = document.getElementById("fader-config-body");
  if (!body) return;
  if (!cfg) {
    body.textContent = "—";
    return;
  }
  body.innerHTML =
    `nominal $${cfg.nominalUsd} × ${cfg.leverage}x · ` +
    `spike ≥ ${cfg.spikePctMin}% · chop > ${cfg.chopRatioMin} · ` +
    `TP = impulse × ${cfg.tpReclaimFrac} · ` +
    `adverse-kill ${Math.round(cfg.adverseKillPct * 100)}% · ` +
    `time-stop ${cfg.timeStopHours}h`;
}

function renderFaderHistory(trades, stats) {
  const body = document.getElementById("fader-history-body");
  const inline = document.getElementById("fader-stats-inline");
  if (!body) return;

  if (inline && stats && stats.n > 0) {
    const fmt = (v) =>
      v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    inline.textContent = `n=${stats.n} · net ${fmt(stats.sumNet)} · avg ${fmt(stats.avgNet)} · win ${(stats.winRate * 100).toFixed(0)}% · best ${fmt(stats.bestNet)} · worst ${fmt(stats.worstNet)}`;
  } else if (inline) {
    inline.textContent = "";
  }

  if (!Array.isArray(trades) || trades.length === 0) {
    body.innerHTML = '<div class="empty-state">no closed trades yet</div>';
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
      <td>
        <span style="color:var(--green)">${fmtUsd(t.mfe_usd)}</span><br>
        <span style="color:var(--red)">${fmtUsd(t.mae_usd)}</span>
      </td>
      <td>${fmtHold(t.hold_seconds)}</td>
      <td style="opacity:.75">${t.reason || "—"}</td>
    </tr>`;
    })
    .join("");
  body.innerHTML = `
    <table class="cb-table">
      <thead><tr><th>Open / Close</th><th>Coin</th><th>Entry / Exit</th><th>Net</th><th>MFE / MAE</th><th>Held</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderFaderHeartbeatRaw(hb) {
  const el = document.getElementById("fader-heartbeat");
  if (!el) return;
  if (!hb) {
    el.textContent = "warming up…";
    return;
  }
  const ageSec = Math.floor((Date.now() - hb.ts) / 1000);
  const age =
    ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  el.textContent =
    `tracked ${hb.tracked} · GREEN ${hb.green} · YELLOW ${hb.yellow} · RED ${hb.red} · ` +
    `slot ${hb.slot} · cooldowns ${hb.cooldowns} · recentLosses ${hb.recentLosses} · ${age}`;
}
