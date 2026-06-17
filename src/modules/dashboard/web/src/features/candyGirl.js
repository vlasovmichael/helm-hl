// ─────────────────────────────────────────────────
//  Candy Girl — signal-only радар (1h EMA-тренд + 5m pullback-reclaim).
//  Приватный кэш сигналов; renderSmartSignals (main) читает его через
//  getCandySignals(). Обновление Smart Signals дёргаем через колбэк
//  setOnCandyUpdate (main вешает gated-renderSmartSignals) — без цикла.
// ─────────────────────────────────────────────────

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
}
