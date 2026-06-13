// ─────────────────────────────────────────────────
//  Whale Watch + Leaderboard — мониторинг HL-адресов.
//  Своё состояние; divergence читает позиции через getWhalePositions().
//  Обратную перерисовку divergence делаем через инъектируемый колбэк
//  setOnPositionsUpdated — чтобы не плодить циклический импорт с divergence.
// ─────────────────────────────────────────────────

import { escapeHtml, fmtNotional, fmtSince } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

// Колбэк «китовые позиции обновились» — main.js вешает на него renderBtcDivergence.
let onPositionsUpdated = () => {};
export function setOnPositionsUpdated(cb) {
  onPositionsUpdated = cb;
}
// Аксессор для divergence (divRenderRows показывает китовые позиции по монете).
export function getWhalePositions(coin) {
  return _wwPositionsMap.get(coin);
}

// ── Whale Watch ──────────────────────────────────

let _wwSort = { key: "sizeUsd", desc: true };

const WW_STORAGE_KEY = "ww-addresses-v2";
const WW_DEFAULTS = [
  { label: "Василий", address: "0x3ed4033676d0bdb3938728ca4ac673d00e74bd06" },
];

// Map<COIN, [{label, side, sizeUsd}]> — shared with divRenderRows for BTC Div integration
let _wwPositionsMap = new Map();

// Map<"address:coin", delta> — cleared on next poll if no new delta
let _wwDeltaMap = new Map();

// True after first successful render — prevents error from overwriting real data on poll failure
let _wwHasData = false;

function wwGetList() {
  try {
    const raw = localStorage.getItem(WW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    /* ignore */
  }
  return WW_DEFAULTS;
}

function wwSaveList(list) {
  localStorage.setItem(WW_STORAGE_KEY, JSON.stringify(list));
}

function fmtPnlColored(v) {
  if (v == null || !Number.isFinite(v)) return `<span>—</span>`;
  const color = v >= 0 ? "var(--green)" : "var(--red)";
  const sign = v >= 0 ? "+" : "";
  return `<span style="color:${color}">${sign}${fmtNotional(v)}</span>`;
}

function wwRenderChips() {
  const chips = document.getElementById("ww-chips");
  if (!chips) return;
  const list = wwGetList();
  chips.innerHTML = list
    .map((w, i) => {
      const short = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
      const labelDiffersFromShort = w.label !== short;
      return `<span style="display:inline-flex;align-items:center;gap:3px;background:var(--bg-header);border:1px solid var(--hairline);border-radius:4px;padding:2px 7px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)" title="${escapeHtml(w.address)}">
      ${escapeHtml(w.label)}${labelDiffersFromShort ? ` <span style="opacity:.5;font-size:9px">${short}</span>` : ""}
      <button data-ww-remove="${i}" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:11px;padding:0 0 0 3px;line-height:1" title="Удалить">×</button>
    </span>`;
    })
    .join("");
  chips.querySelectorAll("[data-ww-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.wwRemove, 10);
      const list = wwGetList();
      list.splice(idx, 1);
      wwSaveList(list);
      wwRenderChips();
      fetchWhaleWatch();
    });
  });
}

let _wwLastResults = null;

function renderWhaleWatch(results) {
  _wwLastResults = results;
  _wwHasData = true;
  const tbody = document.getElementById("ww-tbody");
  const biasEl = document.getElementById("ww-bias");
  const footerEl = document.getElementById("ww-footer");
  if (!tbody) return;

  // Rebuild positions map for BTC Divergence integration
  _wwPositionsMap = new Map();
  let totalNotional = 0;
  let totalShortNotional = 0;
  let totalPnl = 0;
  const allRows = [];
  let fetchedAt = null;

  // Build a new delta map for this render cycle
  const newDeltaMap = new Map();

  for (const { label, address, data } of results) {
    if (!data || data.error) continue;
    fetchedAt = Math.max(fetchedAt ?? 0, data.ts ?? 0);
    // Index deltas by "address:coin"
    for (const d of data.delta ?? []) {
      newDeltaMap.set(`${address}:${d.coin}`, d);
    }
    for (const p of data.positions ?? []) {
      const key = p.coin.toUpperCase();
      if (!_wwPositionsMap.has(key)) _wwPositionsMap.set(key, []);
      _wwPositionsMap
        .get(key)
        .push({ label, side: p.side, sizeUsd: p.sizeUsd });
      totalNotional += p.sizeUsd;
      totalPnl += p.unrealizedPnl;
      if (p.side === "SHORT") totalShortNotional += p.sizeUsd;
      allRows.push({ label, address, ...p });
    }
    // Also add "closed" rows from delta (still show for 1 cycle)
    for (const d of data.delta ?? []) {
      if (d.type === "closed") {
        // Only add if not already in positions
        if (!allRows.some((r) => r.address === address && r.coin === d.coin)) {
          allRows.push({
            label,
            address,
            coin: d.coin,
            side: d.side,
            sizeUsd: d.prevSizeUsd ?? 0,
            unrealizedPnl: 0,
            leverage: null,
            entryPrice: 0,
            _closed: true,
          });
        }
      }
    }
  }

  // Merge old deltas for coins still visible, replace with new ones
  _wwDeltaMap = newDeltaMap;

  if (allRows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty-state">нет открытых perp позиций</td></tr>';
    if (biasEl) biasEl.textContent = "";
    if (footerEl) footerEl.textContent = "";
    // Re-render BTC Div to clear whale column
    onPositionsUpdated();
    return;
  }

  // Apply current sort — closed rows always go to the bottom
  allRows.sort((a, b) => {
    if (a._closed !== b._closed) return a._closed ? 1 : -1;
    const { key, desc } = _wwSort;
    const va = a[key] ?? (typeof a[key] === "string" ? "" : -Infinity);
    const vb = b[key] ?? (typeof b[key] === "string" ? "" : -Infinity);
    if (typeof va === "string")
      return desc ? vb.localeCompare(va) : va.localeCompare(vb);
    return desc ? vb - va : va - vb;
  });

  // Sync header indicators
  document.querySelectorAll("#ww-table th[data-ww-sort]").forEach((th) => {
    const active = th.dataset.wwSort === _wwSort.key;
    th.classList.toggle("ww-sort-active", active);
    th.classList.toggle("ww-sort-asc", active && !_wwSort.desc);
    th.classList.toggle("ww-sort-desc", active && _wwSort.desc);
  });

  tbody.innerHTML = allRows
    .map((p) => {
      const sideColor = p.side === "SHORT" ? "var(--red)" : "var(--green)";
      const levStr = p.leverage != null ? `${p.leverage}×` : "—";
      const entryStr =
        p.entryPrice >= 1000
          ? p.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })
          : p.entryPrice >= 1
            ? p.entryPrice.toFixed(2)
            : p.entryPrice > 0
              ? p.entryPrice.toFixed(5)
              : "—";

      // Delta badge
      const deltaKey = `${p.address}:${p.coin}`;
      const d = _wwDeltaMap.get(deltaKey);
      let deltaBadge = "";
      if (d) {
        if (d.type === "opened") {
          deltaBadge = `<span style="margin-left:4px;background:var(--green);color:#000;font-size:9px;font-weight:700;border-radius:3px;padding:1px 4px;vertical-align:middle">NEW</span>`;
        } else if (d.type === "closed" || p._closed) {
          deltaBadge = `<span style="margin-left:4px;background:var(--red);color:#fff;font-size:9px;font-weight:700;border-radius:3px;padding:1px 4px;vertical-align:middle">CLOSED</span>`;
        } else if (d.type === "size_up") {
          const diff = (d.sizeUsd ?? 0) - (d.prevSizeUsd ?? 0);
          deltaBadge = `<span style="margin-left:4px;color:var(--green);font-size:9px;font-weight:700;vertical-align:middle">+${fmtNotional(diff)}</span>`;
        } else if (d.type === "size_down") {
          const diff = (d.sizeUsd ?? 0) - (d.prevSizeUsd ?? 0);
          deltaBadge = `<span style="margin-left:4px;color:var(--red);font-size:9px;font-weight:700;vertical-align:middle">${fmtNotional(diff)}</span>`;
        }
      } else if (p._closed) {
        deltaBadge = `<span style="margin-left:4px;background:var(--red);color:#fff;font-size:9px;font-weight:700;border-radius:3px;padding:1px 4px;vertical-align:middle">CLOSED</span>`;
      }

      const sinceStr = p._closed ? "—" : fmtSince(p.firstSeenAt);
      const rowOpacity = p._closed ? "opacity:.5;" : "";
      return `<tr style="${rowOpacity}">
      <td style="color:var(--text-muted);font-size:12px">${escapeHtml(p.label)}</td>
      <td style="font-weight:700">${escapeHtml(p.coin)}</td>
      <td class="r" style="color:${sideColor};font-weight:700">${p.side}</td>
      <td class="r">${fmtNotional(p.sizeUsd)}${deltaBadge}</td>
      <td class="r" style="color:var(--text-muted)">${levStr}</td>
      <td class="r">${fmtPnlColored(p.unrealizedPnl)}</td>
      <td class="r" style="color:var(--text-muted)">${escapeHtml(entryStr)}</td>
      <td class="r" style="color:var(--text-faint);font-size:11px">${sinceStr}</td>
    </tr>`;
    })
    .join("");

  if (biasEl) {
    const shortPct =
      totalNotional > 0 ? (totalShortNotional / totalNotional) * 100 : 0;
    const longPct = 100 - shortPct;
    const col =
      shortPct > 60
        ? "var(--red)"
        : longPct > 60
          ? "var(--green)"
          : "var(--text-muted)";
    biasEl.style.color = col;
    const pnlSign = totalPnl >= 0 ? "+" : "";
    biasEl.textContent = `SHORT ${shortPct.toFixed(0)}% · LONG ${longPct.toFixed(0)}% · ${fmtNotional(totalNotional)} · uPnL ${pnlSign}${fmtNotional(totalPnl)}`;
  }

  if (footerEl) {
    const age = fetchedAt ? Math.round((Date.now() - fetchedAt) / 1000) : null;
    footerEl.textContent = `${results.length} address${results.length > 1 ? "es" : ""}${age != null ? ` · ${age}s ago` : ""}`;
  }

  // Re-render BTC Div with updated whale data
  onPositionsUpdated();
}

async function fetchWhaleWatch() {
  const list = wwGetList();
  wwRenderChips();
  if (list.length === 0) {
    renderWhaleWatch([]);
    return;
  }

  // Single batch request — sequential on the server, doesn't block hlInfo semaphore
  const addrs = list.map((w) => w.address).join(",");
  try {
    const batch = await fetchJson(
      `/api/whale-watch/batch?addresses=${encodeURIComponent(addrs)}`,
    );
    const byAddr = new Map(
      (batch.results ?? []).map((r) => [r.address, r.data]),
    );
    const mapped = list.map((w) => ({
      label: w.label,
      address: w.address,
      data: byAddr.get(w.address) ?? null,
    }));
    if (mapped.every((m) => !m.data)) {
      if (!_wwHasData) {
        const tbody = document.getElementById("ww-tbody");
        if (tbody)
          tbody.innerHTML =
            '<tr><td colspan="8" class="empty-state" style="color:var(--red)">ошибка загрузки — HL API недоступен</td></tr>';
      }
      return;
    }
    renderWhaleWatch(mapped);
  } catch (err) {
    if (!_wwHasData) {
      const tbody = document.getElementById("ww-tbody");
      if (tbody)
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:var(--red)">ошибка: ${err?.message ?? "неизвестно"}</td></tr>`;
    }
  }
}

export function initWhaleWatch() {
// Add address form UI
(function initWhaleWatchUi() {
  const addBtn = document.getElementById("ww-add-btn");
  const form = document.getElementById("ww-form");
  const labelInput = document.getElementById("ww-form-label");
  const addrInput = document.getElementById("ww-form-addr");
  const saveBtn = document.getElementById("ww-form-save");
  const cancelBtn = document.getElementById("ww-form-cancel");
  if (!addBtn || !form) return;

  addBtn.addEventListener("click", () => {
    form.style.display = "flex";
    labelInput.value = "";
    addrInput.value = "";
    labelInput.focus();
  });

  cancelBtn?.addEventListener("click", () => {
    form.style.display = "none";
  });

  saveBtn?.addEventListener("click", () => {
    const addr = addrInput.value.trim().toLowerCase();
    const label =
      labelInput.value.trim() || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      addrInput.style.borderColor = "var(--red)";
      setTimeout(() => {
        addrInput.style.borderColor = "";
      }, 1500);
      return;
    }
    const list = wwGetList();
    if (!list.some((w) => w.address === addr)) {
      list.push({ label, address: addr });
      wwSaveList(list);
    }
    form.style.display = "none";
    fetchWhaleWatch();
  });
})();

fetchWhaleWatch();
setInterval(fetchWhaleWatch, 30_000);

// Sortable column headers — re-sort without a new fetch
document.getElementById("ww-table")?.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-ww-sort]");
  if (!th) return;
  const key = th.dataset.wwSort;
  if (_wwSort.key === key) {
    _wwSort.desc = !_wwSort.desc;
  } else {
    _wwSort = { key, desc: key !== "coin" }; // strings default asc, numbers default desc
  }
  if (_wwLastResults) renderWhaleWatch(_wwLastResults);
});

// ── Whale Leaderboard ─────────────────────────────

async function fetchAndRenderLeaderboard() {
  const loadBtn = document.getElementById("ww-lb-load");
  const metaEl = document.getElementById("ww-lb-meta");
  const wrap = document.getElementById("ww-lb-table-wrap");
  const tbody = document.getElementById("ww-lb-tbody");
  if (!loadBtn || !tbody) return;

  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";
  if (metaEl) metaEl.textContent = "";

  try {
    const data = await fetchJson("/api/whale-leaderboard");
    const rows = data.rows ?? [];
    const list = wwGetList();
    const watchedAddresses = new Set(list.map((w) => w.address.toLowerCase()));

    tbody.innerHTML = rows
      .map((r, idx) => {
        const short = `${r.address.slice(0, 6)}…${r.address.slice(-4)}`;
        const nameStr = r.displayName
          ? `${escapeHtml(r.displayName)} <span style="opacity:.5;font-size:10px">${short}</span>`
          : short;
        const roi = Number.isFinite(r.roi30d)
          ? `${(r.roi30d * 100).toFixed(1)}%`
          : "—";
        const pnlColor = r.pnl30d >= 0 ? "var(--green)" : "var(--red)";
        const pnlSign = r.pnl30d >= 0 ? "+" : "";
        const alreadyAdded = watchedAddresses.has(r.address.toLowerCase());
        const addBtn = alreadyAdded
          ? `<button disabled style="font-size:10px;padding:2px 7px;border:1px solid var(--hairline);border-radius:4px;background:none;color:var(--text-faint);cursor:default">✓</button>`
          : `<button data-lb-add="${escapeHtml(r.address)}" data-lb-name="${escapeHtml(r.displayName || short)}" style="font-size:10px;padding:2px 7px;border:1px solid var(--hairline);border-radius:4px;background:none;color:var(--text-muted);cursor:pointer">+ Add</button>`;
        return `<tr>
        <td style="color:var(--text-faint);font-size:11px">${idx + 1}</td>
        <td style="font-family:var(--font-mono);font-size:11px">${nameStr}</td>
        <td class="r">${fmtNotional(r.accountValue)}</td>
        <td class="r" style="color:${pnlColor}">${pnlSign}${fmtNotional(r.pnl30d)}</td>
        <td class="r" style="color:${pnlColor}">${roi}</td>
        <td class="r" style="color:var(--text-muted)">${fmtNotional(r.vlm30d)}</td>
        <td>${addBtn}</td>
      </tr>`;
      })
      .join("");

    // Bind add buttons
    tbody.querySelectorAll("[data-lb-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const addr = btn.dataset.lbAdd.toLowerCase();
        const name =
          btn.dataset.lbName || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
        const list = wwGetList();
        if (!list.some((w) => w.address === addr)) {
          list.push({ label: name, address: addr });
          wwSaveList(list);
        }
        btn.disabled = true;
        btn.textContent = "✓";
        btn.style.color = "var(--text-faint)";
        btn.style.cursor = "default";
        fetchWhaleWatch();
      });
    });

    if (wrap) wrap.style.display = "";
    if (metaEl) {
      const age = data.ts
        ? `${Math.round((Date.now() - data.ts) / 1000)}s ago`
        : "";
      metaEl.textContent = `${rows.length} accounts${data.stale ? " (stale)" : ""}${age ? " · " + age : ""}`;
    }
    loadBtn.textContent = "Refresh";
  } catch (err) {
    loadBtn.textContent = "Error — retry";
    if (metaEl) metaEl.textContent = err.message;
  } finally {
    loadBtn.disabled = false;
  }
}

(function initLeaderboardUi() {
  const loadBtn = document.getElementById("ww-lb-load");
  if (!loadBtn) return;
  loadBtn.addEventListener("click", fetchAndRenderLeaderboard);
})();
}
