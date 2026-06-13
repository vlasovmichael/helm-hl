// ─────────────────────────────────────────────────
//  Chill Boy (trend_follow, #4) — детектор пробоев + shadow-trading карточка.
//  · renderChillBoy — строка-heartbeat в P&L Summary (видна только в PROD).
//  · renderChillBoyCard — полная карточка sec-chillboy (radar-лента сигналов,
//    активная paper-поза с MFE/MAE, watchlist squeezed, cooldowns, история).
//  Самодостаточный: только DOM + inline-форматтеры, без внешнего state.
//  Экспорт: renderChillBoy, renderChillBoyCard (WS-хендлер в main зовёт обе).
// ─────────────────────────────────────────────────

// Chill Boy detector heartbeat — строка в P&L Summary. Чисто диагностика, на торговлю не влияет.
export function renderChillBoy(cb) {
  const row = document.getElementById("chillboy-detector");
  if (!row) return;
  // В PAPER-режиме всё переехало в отдельную карточку sec-chillboy — гасим
  // дубль в P&L Summary. В PROD оставляем строку (детектор виден без отдельной
  // карточки, она в PROD скрыта).
  if (!cb || !cb.enabled || !cb.prod) {
    row.style.display = "none";
    return;
  }
  row.style.display = "";

  const modeEl = document.getElementById("chillboy-mode");
  if (modeEl) {
    modeEl.textContent = cb.prod ? "PROD" : "PAPER";
    modeEl.classList.toggle("prod", !!cb.prod);
  }

  const statsEl = document.getElementById("chillboy-stats");
  if (!statsEl) return;
  const hb = cb.heartbeat;
  if (!hb) {
    statsEl.textContent = "warming up…";
    return;
  }
  const ageSec = Math.floor((Date.now() - hb.ts) / 1000);
  const age =
    ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  statsEl.textContent =
    `tracked ${hb.tracked} · squeezed ${hb.squeezed} · breakouts ${hb.breakouts} · ` +
    `slot ${hb.slot} · cooldowns ${hb.reCooldowns}+${hb.postSlCooldowns} · ${age}`;

  const vEl = document.getElementById("chillboy-vbalance");
  if (vEl) {
    if (cb.virtualEquity) {
      vEl.style.display = "";
      const ve = cb.virtualEquity;
      const sign = ve.pnlTotal >= 0 ? "+" : "-";
      const color =
        ve.pnlTotal >= 0
          ? "var(--accent-positive, #4caf50)"
          : "var(--accent-negative, #f44336)";
      vEl.innerHTML =
        `sandbox: <b>$${ve.equity.toFixed(2)}</b> ` +
        `<span style="color:${color}">(${sign}$${Math.abs(ve.pnlTotal).toFixed(2)} · ` +
        `${sign}${Math.abs(ve.pnlPct * 100).toFixed(1)}%)</span> ` +
        `· seed $${ve.startEquity.toFixed(0)} · n=${ve.tradesApplied}`;
    } else if (cb.virtualBalance > 0) {
      vEl.style.display = "";
      vEl.textContent = `virtual $${cb.virtualBalance.toFixed(0)}`;
    } else {
      vEl.style.display = "none";
    }
  }

  const psEl = document.getElementById("chillboy-paper-stats");
  if (psEl && cb.paperStats) {
    const s = cb.paperStats;
    if (s.n > 0) {
      psEl.style.display = "";
      const fmt = (v) =>
        v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
      psEl.innerHTML =
        `<b>Paper:</b> n=${s.n} · net ${fmt(s.sumNet)} · avg ${fmt(s.avgNet)} · ` +
        `worst ${fmt(s.worstNet)} · best ${fmt(s.bestNet)} · ` +
        `win-rate ${(s.winRate * 100).toFixed(0)}%`;
    } else {
      psEl.style.display = "none";
    }
  }

  const ptEl = document.getElementById("chillboy-paper-trades");
  if (ptEl && Array.isArray(cb.paperTrades) && cb.paperTrades.length > 0) {
    ptEl.style.display = "";
    ptEl.innerHTML = cb.paperTrades
      .map((t) => {
        const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
        const sign = net >= 0 ? "+" : "-";
        const dt = new Date(t.closed_at);
        const ts = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
        const color =
          net >= 0
            ? "var(--accent-positive, #4caf50)"
            : "var(--accent-negative, #f44336)";
        return `<div>${ts} · ${t.side.toUpperCase()} ${t.coin} · <span style="color:${color}">${sign}$${Math.abs(net).toFixed(2)}</span> · ${t.reason}</div>`;
      })
      .join("");
  } else if (ptEl) {
    ptEl.style.display = "none";
  }
}

// Chill Boy Shadow Trading card. Полный обзор детектора в PAPER-режиме —
// активная paper-поза с MFE/MAE, watchlist squeezed-монет, cooldowns, история.
// Карточка скрыта в PROD (CHILL_BOY_PROD_ENABLED=true) — там Chill Boy торгует
// реальный slot, эта карточка теряет смысл.
export function renderChillBoyCard(cb) {
  const card = document.getElementById("sec-chillboy");
  if (!card) return;
  // Показываем карточку всегда, когда стратегия включена (paper ИЛИ prod).
  // Раньше в PROD гасилась, но именно в PROD это главный радар находок.
  if (!cb || !cb.enabled) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  // Header pills: mode + equity
  const modeEl = document.getElementById("chillboy-card-mode");
  if (modeEl) modeEl.textContent = cb.prod ? "PROD" : "PAPER";
  const equityEl = document.getElementById("chillboy-card-equity");
  if (equityEl) {
    if (cb.virtualEquity) {
      const ve = cb.virtualEquity;
      const sign = ve.pnlTotal >= 0 ? "+" : "-";
      equityEl.style.display = "";
      equityEl.textContent = `$${ve.equity.toFixed(2)} (${sign}$${Math.abs(ve.pnlTotal).toFixed(2)} · ${sign}${Math.abs(ve.pnlPct * 100).toFixed(1)}%)`;
      equityEl.style.color = ve.pnlTotal >= 0 ? "var(--green)" : "var(--red)";
    } else {
      equityEl.style.display = "none";
    }
  }

  renderChillBoySignals(cb.signals);
  renderChillBoyActivePos(cb.paperPosition);
  renderChillBoyWatchlist(cb.heartbeat?.watchlist);
  renderChillBoyCooldowns(cb.heartbeat?.cooldownList);
  renderChillBoyHistory(cb.paperTrades, cb.paperStats);
  renderChillBoyHeartbeatRaw(cb.heartbeat);
}

// Лента последних пробоев (радар). Главная ценность Chill Boy — находить монеты,
// которых не видно на aggr.trade. Свежайший сигнал также кладём в data-атрибут
// аккордеона для бейджа в свёрнутой шапке (см. inline-скрипт в index.html).
function renderChillBoySignals(signals) {
  const body = document.getElementById("cb-signals-body");
  if (!body) return;
  const acc = document.getElementById("sec-chillboy");
  if (!Array.isArray(signals) || signals.length === 0) {
    body.innerHTML = '<div class="empty-state">no breakouts yet</div>';
    if (acc) acc.removeAttribute("data-badge-text");
    return;
  }
  const fmtAge = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  };
  body.innerHTML = signals
    .map((s) => {
      const dir = s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const tag = s.traded
        ? '<span class="cb-sig-tag traded">бот вошёл</span>'
        : '<span class="cb-sig-tag">сигнал</span>';
      return (
        `<div class="cb-sig-row"><span class="cb-sig-dir">${dir}</span> ` +
        `<b>#${s.coin}</b> <span class="cb-sig-px">@ $${s.price}</span> ${tag} ` +
        `<span class="cb-sig-age">${fmtAge(s.ts)} ago</span></div>`
      );
    })
    .join("");
  // Бейдж: свежайший сигнал (для свёрнутой шапки Radar-аккордеона)
  if (acc) {
    const top = signals[0];
    const d = top.direction === "LONG" ? "▲" : "▼";
    acc.setAttribute("data-badge-text", `${d} ${top.coin} · ${fmtAge(top.ts)}`);
  }
}

function renderChillBoyActivePos(pos) {
  const section = document.getElementById("cb-active-section");
  const body = document.getElementById("cb-active-body");
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
      <div class="k">Coin / side</div>      <div class="v"><b>${pos.coin}</b> · ${pos.side}</div>
      <div class="k">Size</div>             <div class="v">$${pos.sizeUsd.toFixed(2)}</div>
      <div class="k">Entry / current</div>  <div class="v">${fmtPx(pos.entryPrice)} → ${fmtPx(pos.currentPrice)}</div>
      <div class="k">Unrealized</div>       <div class="v"><span class="${pnlCls}">${fmtUsd(pos.unrealUsd)} (${fmtPct(pos.unrealPct)})</span></div>
      <div class="k">MFE / MAE</div>        <div class="v">
        <span style="color:var(--green)">${fmtUsd(pos.mfeUsd)} (${fmtPct(pos.mfePct)})</span> /
        <span style="color:var(--red)">${fmtUsd(pos.maeUsd)} (${fmtPct(pos.maePct)})</span>
      </div>
      <div class="k">Held</div>             <div class="v">${heldStr}</div>
      <div class="k">SL / TP</div>          <div class="v">${fmtPx(pos.slPrice)} (${pos.slDistPct != null ? pos.slDistPct.toFixed(2) + "% away" : "—"}) · ${fmtPx(pos.tpPrice)} (${pos.tpDistPct != null ? pos.tpDistPct.toFixed(2) + "% away" : "—"})</div>
    </div>
  `;
}

function renderChillBoyWatchlist(items) {
  const body = document.getElementById("cb-watchlist-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<div class="empty-state">no squeezed coins</div>';
    return;
  }
  const rows = items
    .map((w) => {
      const ratio = w.ratio != null ? w.ratio.toFixed(2) : "—";
      return `<tr>
      <td><b>${w.coin}</b></td>
      <td>$${w.price.toFixed(6)}</td>
      <td>r=${ratio}</td>
      <td>↑${w.distUpPct.toFixed(2)}%</td>
      <td>↓${w.distDownPct.toFixed(2)}%</td>
    </tr>`;
    })
    .join("");
  body.innerHTML = `
    <table class="cb-table">
      <thead><tr><th>Coin</th><th>Price</th><th>Squeeze</th><th>to high</th><th>to low</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderChillBoyCooldowns(items) {
  const body = document.getElementById("cb-cooldowns-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<div class="empty-state">none</div>';
    return;
  }
  const rows = items
    .map((c) => {
      const remainStr =
        c.remainMs > 60000
          ? `${Math.round(c.remainMs / 60000)}m`
          : `${Math.round(c.remainMs / 1000)}s`;
      const kindLabel = c.kind === "post_sl" ? "post-SL" : "re-entry";
      return `<tr><td><b>${c.coin}</b></td><td>${kindLabel}</td><td>${remainStr}</td></tr>`;
    })
    .join("");
  body.innerHTML = `<table class="cb-table"><thead><tr><th>Coin</th><th>Kind</th><th>Remaining</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderChillBoyHistory(trades, stats) {
  const body = document.getElementById("cb-history-body");
  const inline = document.getElementById("cb-stats-inline");
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
      const cls = net >= 0 ? "positive" : "negative";
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

function renderChillBoyHeartbeatRaw(hb) {
  const el = document.getElementById("cb-heartbeat");
  if (!el) return;
  if (!hb) {
    el.textContent = "warming up…";
    return;
  }
  const ageSec = Math.floor((Date.now() - hb.ts) / 1000);
  const age =
    ageSec < 90 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  el.textContent =
    `tracked ${hb.tracked} · squeezed ${hb.squeezed} · breakouts ${hb.breakouts} · ` +
    `slot ${hb.slot} · cooldowns ${hb.reCooldowns} re + ${hb.postSlCooldowns} post-SL · ${age}`;
}
