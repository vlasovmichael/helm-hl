// ─────────────────────────────────────────────────
//  BTC Divergence — относительная сила монет к BTC по окнам (5m/15m/1h/all).
//  Своё состояние + вотчлист в localStorage. Китовые позиции в таблице тянет
//  из whaleWatch через getWhalePositions(). renderBtcDivergence/divRefresh
//  зовёт main.js (WS-пуш + bootstrap), UI-биндинг вкладок — initDivergenceUi().
// ─────────────────────────────────────────────────

import { fmtPrice, fmtNotional } from "../utils/format.js";
import { fetchJson } from "../net/api.js";
import { isActiveCoin } from "../state/activeCoins.js";
import { getWhalePositions } from "./whaleWatch.js";

let _divData = null;
let _divWindow = "15m";
const DIV_DEFAULT_WATCHLIST = [
  "BTC",
  "HYPE",
  "ZEC",
  "WLD",
  "NEAR",
  "LIT",
  "ASTER",
];

function divGetWatchlist() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("hl-div-watchlist") || "null",
    );
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DIV_DEFAULT_WATCHLIST];
}

function divSaveWatchlist(list) {
  localStorage.setItem("hl-div-watchlist", JSON.stringify(list));
}

function divRenderWatchlistBar() {
  const bar = document.getElementById("div-watchlist-bar");
  if (!bar || _divWindow === "all") {
    if (bar) bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  const list = divGetWatchlist();
  const defaults = new Set(DIV_DEFAULT_WATCHLIST);
  bar.innerHTML =
    list
      .map((coin) => {
        const removable = !defaults.has(coin);
        return `<span style="display:inline-flex;align-items:center;gap:3px;background:var(--surface-2,rgba(255,255,255,.06));border:1px solid var(--hairline);border-radius:4px;padding:2px 6px;font-family:var(--font-mono);font-size:10px;">
      ${coin}${removable ? `<button data-remove="${coin}" style="background:none;border:none;cursor:pointer;color:var(--text-faint);padding:0;line-height:1;font-size:11px;" title="Убрать">×</button>` : ""}
    </span>`;
      })
      .join("") +
    `<span style="display:inline-flex;align-items:center;gap:3px;">
    <input id="div-add-input" placeholder="+ COIN" style="width:60px;background:transparent;border:1px dashed var(--hairline);border-radius:4px;padding:2px 5px;font-family:var(--font-mono);font-size:10px;color:inherit;outline:none;" maxlength="10" autocomplete="off" spellcheck="false"/>
  </span>`;

  bar.querySelector("#div-add-input")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const val = e.target.value.trim().toUpperCase();
    if (!val) return;
    const l = divGetWatchlist();
    if (!l.includes(val)) {
      l.push(val);
      divSaveWatchlist(l);
    }
    e.target.value = "";
    divRenderWatchlistBar();
    divRefresh();
  });

  bar.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const l = divGetWatchlist().filter((c) => c !== btn.dataset.remove);
      divSaveWatchlist(l);
      divRenderWatchlistBar();
      divRefresh();
    });
  });
}

function divSignalInfo(c, btcPct, hasPast) {
  const rel = c.relPct;
  const isBtc = c.coin === "BTC";
  const relColor =
    !hasPast || rel == null
      ? "var(--text-muted)"
      : rel <= -1.5
        ? "var(--red)"
        : rel >= 1.5
          ? "var(--green)"
          : "var(--text-muted)";
  const coinColor =
    !hasPast || c.coinPct == null
      ? "var(--text-muted)"
      : c.coinPct > 0
        ? "var(--green)"
        : c.coinPct < 0
          ? "var(--red)"
          : "var(--text-muted)";
  let signal = "—";
  if (hasPast && rel != null && btcPct != null && !isBtc) {
    if (btcPct > 0.3 && rel <= -1.5) signal = "SHORT";
    else if (btcPct < -0.3 && rel >= 1.5) signal = "LONG";
  }
  const signalColor =
    signal === "SHORT"
      ? "var(--red)"
      : signal === "LONG"
        ? "var(--green)"
        : "var(--text-faint)";
  return { relColor, coinColor, signal, signalColor, isBtc };
}

function divRenderRows(coins, btcPct, hasPast) {
  const fmtPct = (v) =>
    v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
  return coins
    .map((c) => {
      const { relColor, coinColor, signal, signalColor, isBtc } = divSignalInfo(
        c,
        btcPct,
        hasPast,
      );
      const rel = c.relPct;
      const whaleEntries = getWhalePositions(c.coin.toUpperCase());
      let whaleCell = "";
      if (whaleEntries?.length) {
        const shortSum = whaleEntries
          .filter((w) => w.side === "SHORT")
          .reduce((s, w) => s + w.sizeUsd, 0);
        const longSum = whaleEntries
          .filter((w) => w.side === "LONG")
          .reduce((s, w) => s + w.sizeUsd, 0);
        const parts = [];
        if (shortSum > 0)
          parts.push(
            `<span style="color:var(--red);font-weight:700">↓${fmtNotional(shortSum)}</span>`,
          );
        if (longSum > 0)
          parts.push(
            `<span style="color:var(--green);font-weight:700">↑${fmtNotional(longSum)}</span>`,
          );
        whaleCell = parts.join(" ");
      }
      return `<tr class="${isActiveCoin(c.coin) ? "is-active" : ""}">
      <td style="font-weight:600">${c.coin}</td>
      <td class="r">${fmtPrice(c.price)}</td>
      <td class="r" style="color:${coinColor}">${hasPast ? fmtPct(c.coinPct) : "—"}</td>
      <td class="r" style="color:${relColor};font-weight:${Math.abs(rel ?? 0) >= 1.5 ? 600 : 400}">${hasPast && !isBtc ? fmtPct(rel) : isBtc ? "baseline" : "—"}</td>
      <td class="c" style="color:${signalColor};font-weight:700">${signal}</td>
      <td class="r">${whaleCell}</td>
    </tr>`;
    })
    .join("");
}

let _divAllFetching = false;

async function divFetchAll() {
  if (_divAllFetching) return;
  _divAllFetching = true;
  const win = _divWindow === "all" ? "15m" : _divWindow;
  const tbody = document.getElementById("div-tbody");
  const hasContent =
    tbody && tbody.children.length > 0 && !tbody.querySelector(".empty-state");
  if (!hasContent && tbody)
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">загружаем все монеты…</td></tr>`;
  try {
    const d = await fetchJson(`/api/btc-divergence/all?window=${win}`);
    if (!d?.coins) return;
    const metaEl = document.getElementById("div-meta");
    const thChange = document.getElementById("div-th-change");
    if (thChange) thChange.textContent = `${win} %`;
    if (metaEl) {
      const label =
        d.btcPct != null
          ? `BTC ${win} ${d.btcPct > 0 ? "+" : ""}${d.btcPct.toFixed(2)}% · ${d.coins.length} монет`
          : `${d.coins.length} монет · накапливаем историю…`;
      metaEl.textContent = label;
      metaEl.style.color =
        d.btcPct == null
          ? "var(--text-muted)"
          : d.btcPct > 0.3
            ? "var(--green)"
            : d.btcPct < -0.3
              ? "var(--red)"
              : "var(--text-muted)";
    }
    if (d.coins.length === 0) {
      if (tbody)
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">накапливаем историю…</td></tr>`;
      return;
    }
    if (tbody) tbody.innerHTML = divRenderRows(d.coins, d.btcPct, d.hasPast);
  } catch {
    /* silent */
  } finally {
    _divAllFetching = false;
  }
}

// Тянем дивергенцию по ТЕКУЩЕМУ вотчлисту (включая монеты, добавленные оператором).
// WS-пуш шлёт только дефолтный список, поэтому источник истины для табов
// 5m/15m/1h — этот fetch. BTC всегда нужен как baseline.
export async function divRefresh() {
  if (_divWindow === "all") {
    renderBtcDivergence(null);
    return;
  }
  const wl = divGetWatchlist();
  const coins = wl.includes("BTC") ? wl : ["BTC", ...wl];
  try {
    const d = await fetchJson(
      `/api/btc-divergence?coins=${encodeURIComponent(coins.join(","))}`,
    );
    if (d?.windows) renderBtcDivergence(d);
  } catch {
    /* silent */
  }
}

export function renderBtcDivergence(data) {
  if (data) _divData = data;

  divRenderWatchlistBar();

  if (_divWindow === "all") {
    divFetchAll();
    return;
  }

  if (!_divData) return;
  const tbody = document.getElementById("div-tbody");
  const metaEl = document.getElementById("div-meta");
  const thChange = document.getElementById("div-th-change");
  if (!tbody) return;

  const watchlist = divGetWatchlist();
  const windowData = _divData.windows?.[_divWindow];
  if (!windowData?.coins?.length) {
    const mins = _divWindow === "1h" ? 60 : parseInt(_divWindow);
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">накапливаем историю (нужно ${mins} мин)…</td></tr>`;
    return;
  }

  if (thChange) thChange.textContent = `${_divWindow} %`;
  const { coins: allCoins, btcPct, hasPast } = windowData;
  const { updatedAt } = _divData;

  // Фильтруем по вотчлисту, добавляем монеты которые пользователь добавил
  const watchSet = new Set(watchlist);
  const coins = allCoins.filter((c) => watchSet.has(c.coin));

  if (metaEl) {
    const age = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null;
    const btcLabel =
      btcPct != null
        ? `BTC ${_divWindow} ${btcPct > 0 ? "+" : ""}${btcPct.toFixed(2)}%`
        : "BTC —";
    metaEl.textContent = age != null ? `${btcLabel} · ${age}s ago` : btcLabel;
    metaEl.style.color =
      btcPct == null
        ? "var(--text-muted)"
        : btcPct > 0.3
          ? "var(--green)"
          : btcPct < -0.3
            ? "var(--red)"
            : "var(--text-muted)";
  }

  tbody.innerHTML = divRenderRows(coins, btcPct, hasPast);
}

export function initDivergenceUi() {
document.getElementById("div-tabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-window]");
  if (!btn) return;
  _divWindow = btn.dataset.window;
  document
    .querySelectorAll("#div-tabs .range-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  divRefresh();
});
}
