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
import { emptyRow, settle, skeletonRows } from "../core/placeholders.js";
import { icon } from "../core/icon.js";
import { chip, field } from "../core/ui.js";

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
        return chip({
          label: coin,
          remove: removable
            ? { title: "Remove from the list", attrs: { "data-remove": coin } }
            : null,
        });
      })
      .join("") +
    field({ id: "div-add-input", placeholder: "+ COIN", ticker: true, cls: "field--sm div-add-input", attrs: { maxlength: 10, style: "width:74px" } });

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
            `<span style="color:var(--red);font-weight:700">${icon("short")}${fmtNotional(shortSum)}</span>`,
          );
        if (longSum > 0)
          parts.push(
            `<span style="color:var(--green);font-weight:700">${icon("long")}${fmtNotional(longSum)}</span>`,
          );
        whaleCell = parts.join(" ");
      }
      return `<tr class="${isActiveCoin(c.coin) ?"is-active" : ""}">
      <td style="font-weight:600">${c.coin}</td>
      <td class="num">${fmtPrice(c.price)}</td>
      <td class="num" style="color:${coinColor}">${hasPast ? fmtPct(c.coinPct) : "—"}</td>
      <td class="num" style="color:${relColor};font-weight:${Math.abs(rel ?? 0) >= 1.5 ? 600 : 400}">${hasPast && !isBtc ? fmtPct(rel) : isBtc ? "baseline" : "—"}</td>
      <td class="center" style="color:${signalColor};font-weight:700">${signal}</td>
      <td class="num">${whaleCell}</td>
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
  // Скелетон — это НЕ содержимое: если в теле стоят .sk-row, таблицу надо
  // считать пустой, иначе перезапрос не покажет ожидание.
  const hasContent =
    tbody &&
    tbody.children.length > 0 &&
    !tbody.querySelector(".empty-state, .sk-row");
  if (!hasContent && tbody)
    tbody.innerHTML = skeletonRows(6, 5);
  try {
    const d = await fetchJson(`/api/btc-divergence/all?window=${win}`);
    if (!d?.coins) return;
    const metaEl = document.getElementById("div-meta");
    const thChange = document.getElementById("div-th-change");
    if (thChange) thChange.textContent = `${win} %`;
    if (metaEl) {
      const label =
        d.btcPct != null
          ? `BTC ${win} ${d.btcPct > 0 ? "+" : ""}${d.btcPct.toFixed(2)}% · ${d.coins.length} coins`
          : `${d.coins.length} coins · building history…`;
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
      // Ответ пришёл и он пустой — это уже не ожидание, а состояние: истории
      // цен ещё не набралось. Скелетон здесь врал бы, что данные едут.
      if (tbody)
        tbody.innerHTML = emptyRow(6, {
          glyph: "clock",
          title: "Building price history",
          hint: "Divergence needs a window of ticks after a restart before it can compare anything.",
        });
      return;
    }
    if (tbody) settle(tbody, divRenderRows(d.coins, d.btcPct, d.hasPast));
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
    // Кадр пришёл, но окна в нём нет — истории ещё не набралось. Это
    // состояние, а не ожидание: скелетон обещал бы данные, которых пока нет.
    tbody.innerHTML = emptyRow(5, {
      glyph: "clock",
      title: "Building price history",
      hint: `Nothing to compare over ${_divWindow} yet — the buffer fills as ticks arrive.`,
    });
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

  settle(tbody, divRenderRows(coins, btcPct, hasPast));
}

export function initDivergenceUi() {
document.getElementById("div-tabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-window]");
  if (!btn) return;
  _divWindow = btn.dataset.window;
  document
    .querySelectorAll("#div-tabs .seg__btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  divRefresh();
});
}
