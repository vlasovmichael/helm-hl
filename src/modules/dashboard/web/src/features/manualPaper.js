// ─────────────────────────────────────────────────
//  My paper (Rabbit-style) — entry modal + management card
// ─────────────────────────────────────────────────
// "See movement in Hot Movers → hit the button → popup: coin, side, leverage,
//  slider off the real equity → open a paper trade." The bot doesn't trade it —
//  I hold/close by hand. Open positions + live mark-to-market show up in the
//  Active Position card (index); the archive lands in the Strategies table.
//
// The modal injects its own DOM into body (works on both index and lab without
// touching HTML) and reuses the shared .trade-modal shell — flat, theme-aware
// panel like "What if…". REST: GET/POST /api/manual-paper(/open|/close).

import { escapeHtml, fmtUsd, fmtPct, fmtPrice } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

let busy = false;
let lastEquity = 0;
// coin (UPPERCASE) → max leverage allowed (from HL universe). Used to clamp the
// leverage slider after a coin is picked — most coins on the wallet cap at 3–10×.
let coinLeverage = {};

const WALLET_LEV_CAP = 10; // practical cap on the wallet; never offer more
const DEFAULT_LEV = 3;     // most positions ride 3×

// ── helpers ──
function pickNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function postJson(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 401) window.location.href = "/login";
  return r.json();
}

// ── Modal DOM (singleton) ──
function ensureModal() {
  let modal = document.getElementById("mp-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "mp-modal";
  modal.className = "trade-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="trade-modal__backdrop" data-mp-close></div>
    <div class="trade-modal__panel" role="dialog" aria-modal="true" aria-label="New paper trade">
      <button class="trade-modal__close" type="button" data-mp-close aria-label="Close">×</button>
      <div class="mp-body" id="mp-body"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-mp-close")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });
  return modal;
}

function closeModal() {
  const m = document.getElementById("mp-modal");
  if (!m) return;
  m.hidden = true;
  document.body.style.overflow = "";
}

function formHtml(prefill = {}) {
  const coin = prefill.coin || "";
  const side = prefill.side === "short" ? "short" : "long";
  const sideBtn = (val, label) =>
    `<button type="button" class="mp-side-btn mp-side-${val} ${side === val ? "is-on" : ""}" data-side="${val}">${label}</button>`;
  return `
    <div class="mp-title">New paper trade</div>
    <div class="mp-lead">Like Rabbit, but on paper. Entry at the current price. The bot manages the exit (ATR stop + breakeven ratchet + trail), same as adopt — you can also close it yourself anytime.</div>
    <form id="mp-form" autocomplete="off">
      <label class="mp-label">Coin</label>
      <input id="mp-coin" class="mp-input" type="text" list="mp-coin-list" placeholder="e.g. BTC, SOL, kBONK" value="${escapeHtml(coin.toUpperCase())}" autocomplete="off" spellcheck="false" />
      <datalist id="mp-coin-list"></datalist>

      <label class="mp-label">Side</label>
      <div class="mp-sides">${sideBtn("long", "▲ Long")}${sideBtn("short", "▼ Short")}</div>

      <label class="mp-label">Leverage: <span id="mp-lev-val">${DEFAULT_LEV}×</span> <span class="mp-lev-hint" id="mp-lev-hint"></span></label>
      <input id="mp-lev" class="mp-range" type="range" min="1" max="${WALLET_LEV_CAP}" step="1" value="${DEFAULT_LEV}" />

      <label class="mp-label">Margin of equity: <span id="mp-margin-val">10%</span></label>
      <input id="mp-size" class="mp-range" type="range" min="1" max="100" step="1" value="10" />

      <div class="mp-calc" id="mp-calc"></div>
      <div class="mp-err" id="mp-err" hidden></div>
      <button type="submit" class="mp-submit" id="mp-submit">Open paper position</button>
    </form>`;
}

// Clamp the leverage slider to what the picked coin allows (HL max, capped at
// the wallet's practical WALLET_LEV_CAP). Shows a hint when the coin caps lower.
function applyCoinLeverageCap() {
  const coin = (document.getElementById("mp-coin")?.value || "").trim().toUpperCase();
  const lev = document.getElementById("mp-lev");
  const hint = document.getElementById("mp-lev-hint");
  if (!lev) return;
  const coinMax = coinLeverage[coin];
  const cap = Math.min(WALLET_LEV_CAP, Number.isFinite(coinMax) && coinMax > 0 ? coinMax : WALLET_LEV_CAP);
  lev.max = String(cap);
  if (Number(lev.value) > cap) lev.value = String(cap);
  if (hint) {
    // Show the binding constraint: the coin's HL cap when it's the lower one,
    // otherwise the wallet's practical cap.
    if (coin && Number.isFinite(coinMax) && coinMax < WALLET_LEV_CAP)
      hint.textContent = `· ${coin} caps at ${coinMax}×`;
    else if (coin) hint.textContent = `· cap ${cap}×`;
    else hint.textContent = "";
  }
  recalc();
}

function recalc() {
  const lev = pickNum(document.getElementById("mp-lev")?.value, 1);
  const pct = pickNum(document.getElementById("mp-size")?.value, 0);
  const margin = (lastEquity * pct) / 100;
  const notional = margin * lev;
  const levVal = document.getElementById("mp-lev-val");
  const mVal = document.getElementById("mp-margin-val");
  const calc = document.getElementById("mp-calc");
  if (levVal) levVal.textContent = `${lev}×`;
  if (mVal) mVal.textContent = `${pct}%`;
  if (calc) {
    calc.innerHTML = lastEquity > 0
      ? `Equity <strong>${fmtUsd(lastEquity)}</strong> · margin <strong>${fmtUsd(margin)}</strong> · position size <strong>${fmtUsd(notional)}</strong>`
      : `Equity unavailable — set the size manually with leverage × %.`;
  }
  return { lev, notional, margin };
}

// Fill the <datalist> for the coin autocomplete (typed input, not a long list).
function populateCoins(coins) {
  const list = document.getElementById("mp-coin-list");
  if (!list) return;
  list.innerHTML = coins.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

async function openModal(prefill = {}) {
  const modal = ensureModal();
  document.getElementById("mp-body").innerHTML = formHtml(prefill);
  modal.hidden = false;
  document.body.style.overflow = "hidden";

  // Equity for the slider + coin list (autocomplete) + per-coin max leverage.
  try {
    const data = await fetchJson("/api/manual-paper");
    lastEquity = pickNum(data?.equity, 0);
    coinLeverage = data?.leverage && typeof data.leverage === "object" ? data.leverage : {};
    populateCoins(Array.isArray(data?.coins) ? data.coins : []);
  } catch {
    lastEquity = 0;
    coinLeverage = {};
    populateCoins([]);
  }
  applyCoinLeverageCap(); // honors prefill coin + refreshes the calc line

  const form = document.getElementById("mp-form");
  form.querySelectorAll(".mp-side-btn").forEach((b) =>
    b.addEventListener("click", () => {
      form.querySelectorAll(".mp-side-btn").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
    }),
  );
  // Re-check the coin's leverage cap whenever the typed coin changes.
  document.getElementById("mp-coin").addEventListener("change", applyCoinLeverageCap);
  document.getElementById("mp-coin").addEventListener("input", applyCoinLeverageCap);
  document.getElementById("mp-lev").addEventListener("input", recalc);
  document.getElementById("mp-size").addEventListener("input", recalc);
  form.addEventListener("submit", onSubmit);
  document.getElementById("mp-coin").focus();
}

async function onSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const err = document.getElementById("mp-err");
  const showErr = (m) => { if (err) { err.textContent = m; err.hidden = false; } };
  err.hidden = true;

  const coin = (document.getElementById("mp-coin").value || "").trim().toUpperCase();
  const side = document.querySelector(".mp-side-btn.is-on")?.dataset.side || "long";
  const { lev, notional } = recalc();
  if (!coin) return showErr("Pick a coin from the list.");
  if (!(notional > 0)) return showErr("Position size is 0 — move the margin slider (or equity is unavailable).");

  busy = true;
  const submit = document.getElementById("mp-submit");
  submit.disabled = true;
  submit.textContent = "Opening…";
  try {
    const res = await postJson("/api/manual-paper/open", {
      coin, side, leverage: lev, sizeUsd: notional,
    });
    if (res?.ok) {
      closeModal();
      refreshActive(); // refresh the paper-positions block if it's on this page
    } else {
      showErr(res?.error || "Couldn't open.");
    }
  } catch (e2) {
    showErr(e2.message || "Network error.");
  } finally {
    busy = false;
    submit.disabled = false;
    submit.textContent = "Open paper position";
  }
}

/** Открыть модалку извне (напр. с конкретной монетой из Hot Movers). */
export function openManualPaperModal(prefill = {}) {
  openModal(prefill);
}

/** Повесить кнопку-триггер по id. */
export function initManualPaperTrigger(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => openModal());
}

// ── Бумажные позы в карточке Active Position (главная): live-PnL + Close ──
let listTimer = null;

function rowHtml(p) {
  const isShort = p.side === "SHORT";
  const sideCls = isShort ? "num-neg" : "num-pos";
  const arrow = isShort ? "▼" : "▲";
  const pnl = p.unrealized;
  const pnlCls = pnl == null ? "" : pnl >= 0 ? "num-pos" : "num-neg";
  const roe = p.roePct;
  // Если бот ведёт выход — под uPnL показываем пик (MFE) и виртуальный стоп.
  const sub =
    p.managed && (p.stopPrice != null || p.peakPct)
      ? `<span class="mp-sub">peak ${p.peakPct ? fmtPct(p.peakPct) : "0%"}${
          p.stopPrice != null ? ` · stop ${fmtPrice(p.stopPrice)}` : ""
        }</span>`
      : "";
  return `
    <tr>
      <td><span class="signals-price">#${escapeHtml(p.coin)}</span></td>
      <td class="c ${sideCls}"><strong>${arrow} ${escapeHtml(p.side)}</strong></td>
      <td class="r">${p.leverage}×</td>
      <td class="r">${fmtUsd(p.sizeUsd)}</td>
      <td class="r">${fmtPrice(p.entryPrice)}</td>
      <td class="r" data-mp-mark>${p.markPrice != null ? "$" + fmtPrice(p.markPrice) : "—"}</td>
      <td class="r ${pnlCls}"><strong>${pnl == null ? "—" : fmtUsd(pnl)}</strong>${
        roe == null ? "" : `<span class="mp-roe">${fmtPct(roe)}</span>`
      }${sub}</td>
      <td class="c"><button type="button" class="mp-close-btn" data-mp-close-id="${p.id}" data-mp-coin="${escapeHtml(p.coin)}" data-mp-side="${escapeHtml(p.side)}" data-mp-lev="${p.leverage}" data-mp-size="${p.sizeUsd}" data-mp-entry="${p.entryPrice}" data-mp-mark-px="${p.markPrice ?? ""}" data-mp-pnl="${pnl ?? ""}" data-mp-roe="${roe ?? ""}">Close</button></td>
    </tr>`;
}

async function refreshActive() {
  const container = document.getElementById("mp-active-container");
  if (!container) return; // не на этой странице
  try {
    const data = await fetchJson("/api/manual-paper");
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    if (!positions.length) {
      container.innerHTML = ""; // нет бумажных поз — блок не мозолит глаза
      return;
    }
    const used = data?.slots?.used ?? positions.length;
    const max = data?.slots?.max ?? 8;
    const managed = positions.some((p) => p.managed);
    container.innerHTML = `
      <div class="mp-active">
        <div class="mp-active-head">
          <span>Paper positions · paper</span>
          <span class="mp-active-meta">${used}/${max} · ${managed ? "🤖 bot manages exit" : "bot hands-off"}</span>
        </div>
        <div class="u-scroll-x">
          <table class="data-table mp-active-table">
            <thead>
              <tr>
                <th>Coin</th><th class="c">Side</th><th class="r">Lev</th>
                <th class="r">Size</th><th class="r">Entry</th><th class="r">Price</th>
                <th class="r" title="Unrealized P&L (net) + ROE on margin">uPnL</th>
                <th class="c"></th>
              </tr>
            </thead>
            <tbody>${positions.map(rowHtml).join("")}</tbody>
          </table>
        </div>
      </div>`;
  } catch {
    /* fail-soft — блок не критичен */
  }
}

// ── Close confirmation (styled; replaces window.confirm/alert) ──
// Держим отдельный shell от формы открытия: диалог может всплыть поверх неё.
let confirmResolve = null;

function ensureConfirm() {
  let modal = document.getElementById("mp-confirm");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "mp-confirm";
  modal.className = "trade-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="trade-modal__backdrop" data-mp-cancel></div>
    <div class="trade-modal__panel" role="dialog" aria-modal="true" aria-label="Close paper position">
      <button class="trade-modal__close" type="button" data-mp-cancel aria-label="Cancel">×</button>
      <div id="mp-confirm-body"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-mp-cancel")) settleConfirm(false);
    if (e.target.hasAttribute("data-mp-confirm")) settleConfirm(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) settleConfirm(false);
  });
  return modal;
}

function hideConfirm() {
  const modal = document.getElementById("mp-confirm");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

// Отмена закрывает диалог; подтверждение — нет: пока идёт запрос, оператор видит
// тот же диалог в busy-состоянии, а ошибка ложится прямо в него.
function settleConfirm(ok) {
  const modal = document.getElementById("mp-confirm");
  if (!modal || modal.hidden) return;
  if (!ok) hideConfirm();
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(ok);
}

function setConfirmBusy(busyNow) {
  const btn = document.querySelector("#mp-confirm [data-mp-confirm]");
  const cancel = document.querySelector("#mp-confirm .mp-btn-ghost");
  if (btn) {
    btn.disabled = busyNow;
    btn.textContent = busyNow ? "Closing…" : "Close position";
  }
  if (cancel) cancel.disabled = busyNow;
}

function confirmClose(info, errMsg) {
  const modal = ensureConfirm();
  const isShort = info.side === "SHORT";
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const pnl = num(info.pnl);
  const roe = num(info.roe);
  const mark = num(info.mark);
  const entry = num(info.entry);
  const size = num(info.size);
  const pnlCls = pnl == null ? "" : pnl >= 0 ? "num-pos" : "num-neg";
  const cell = (label, value, cls = "") =>
    `<div class="mp-confirm-cell"><span class="mp-confirm-cell-label">${label}</span><span class="mp-confirm-cell-value ${cls}">${value}</span></div>`;
  document.getElementById("mp-confirm-body").innerHTML = `
    <div class="mp-title">Close #${escapeHtml(info.coin || "")}?</div>
    <div class="mp-lead">Closes the paper position at the current mark price. The result lands in the journal — this can't be undone.</div>
    <div class="mp-confirm-grid">
      ${cell("Side", `${isShort ? "▼" : "▲"} ${escapeHtml(info.side || "—")}${info.lev ? " " + info.lev + "×" : ""}`, isShort ? "num-neg" : "num-pos")}
      ${cell("Size", size == null ? "—" : fmtUsd(size))}
      ${cell("Entry", entry == null ? "—" : "$" + fmtPrice(entry))}
      ${cell("Mark", mark == null ? "—" : "$" + fmtPrice(mark))}
      ${cell("uPnL", pnl == null ? "—" : fmtUsd(pnl) + (roe == null ? "" : ` (${fmtPct(roe)})`), pnlCls)}
    </div>
    <div class="mp-err"${errMsg ? "" : " hidden"}>${escapeHtml(errMsg || "")}</div>
    <div class="mp-confirm-actions">
      <button type="button" class="mp-btn-ghost" data-mp-cancel>Keep it</button>
      <button type="button" class="mp-btn-danger" data-mp-confirm>${errMsg ? "Retry close" : "Close position"}</button>
    </div>`;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#mp-confirm [data-mp-confirm]")?.focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

async function onCloseClick(e) {
  const btn = e.target.closest("[data-mp-close-id]");
  if (!btn) return;
  const id = Number(btn.dataset.mpCloseId);
  if (!Number.isFinite(id)) return;
  const d = btn.dataset;
  const info = {
    coin: d.mpCoin,
    side: d.mpSide,
    lev: d.mpLev,
    size: d.mpSize,
    entry: d.mpEntry,
    mark: d.mpMarkPx,
    pnl: d.mpPnl,
    roe: d.mpRoe,
  };
  let err = "";
  // Ошибку показываем в том же диалоге и даём повторить, не гоняя через alert.
  for (;;) {
    const ok = await confirmClose(info, err);
    if (!ok) {
      btn.disabled = false;
      btn.textContent = "Close";
      return;
    }
    setConfirmBusy(true);
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await postJson("/api/manual-paper/close", { id });
      if (res?.ok) {
        hideConfirm();
        refreshActive();
        return;
      }
      err = res?.error || "Couldn't close.";
    } catch {
      err = "Network error — the position is still open.";
    }
    setConfirmBusy(false);
  }
}

/**
 * Бумажные позы в карточке Active Position (главная): рендер + Close + поллинг 15с.
 * Вызывать из index.js (контейнер #mp-active-container в секции Active Position).
 */
export function initManualPaperActive() {
  const container = document.getElementById("mp-active-container");
  if (!container || container.dataset.bound) return;
  container.dataset.bound = "1";
  container.addEventListener("click", onCloseClick);
  refreshActive();
  if (listTimer) clearInterval(listTimer);
  listTimer = setInterval(() => {
    if (!document.hidden) refreshActive();
  }, 15_000);
}
