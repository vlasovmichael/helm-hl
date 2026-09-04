// ─────────────────────────────────────────────────
//  My paper (Rabbit-style) — entry modal + management card
// ─────────────────────────────────────────────────
// "See movement in Hot Movers → hit the button → popup: coin, side, leverage,
//  slider off the real equity → open a paper trade." The bot doesn't trade it —
//  I hold/close by hand. Open positions + live mark-to-market show up in the
//  Active Position card (index); the archive lands in the Strategies table.
//
// The modal injects its own DOM into body (works on both index and lab without
// touching HTML) and reuses the shared .modal shell — flat, theme-aware
// panel like "What if…". REST: GET/POST /api/manual-paper(/open|/close).

import { escapeHtml, fmtUsd, fmtPct, fmtPrice } from "../utils/format.js";
import { fetchJson } from "../net/api.js";
import * as dialog from "../core/dialog.js";
import { icon } from "../core/icon.js";
import { button, segmented, field, slider, card } from "../core/ui.js";

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

// Оболочки диалогов больше нет: её строит ядро (core/dialog.js → shell/show).
function closeModal() {
  dialog.close(dialog.shell("mp-modal"));
}

function formHtml(prefill = {}) {
  const coin = prefill.coin || "";
  const side = prefill.side === "short" ? "short" : "long";
  // Форма из тех же карточек, что «Open Position» (core/ui.js).
  return `
    <div class="mp-lead">Like Rabbit, but on paper. The bot manages the exit (ATR stop + breakeven ratchet + trail), same as adopt — you can also close it yourself anytime.</div>
    <form id="mp-form" autocomplete="off">
      ${segmented({
        name: "side",
        value: side,
        wide: true,
        cls: "mp-sides",
        options: [
          { value: "long", label: "Long", icon: "long", tone: "long" },
          { value: "short", label: "Short", icon: "short", tone: "short" },
        ],
      })}

      ${card({
        label: "Coin",
        below:
          field({
            id: "mp-coin",
            value: coin.toUpperCase(),
            placeholder: "e.g. BTC, SOL, kBONK",
            ticker: true,
            block: true,
            cls: "field--coin",
            attrs: { "data-autofocus": true, list: "mp-coin-list" },
          }) + `<datalist id="mp-coin-list"></datalist>`,
      })}

      ${card({
        label: "Margin of equity",
        accent: true,
        minorValue: "—",
        minorNote: "equity",
        major: "10%",
        attrs: { id: "mp-margin-card" },
        below: slider({ name: "size", value: 10, min: 1, max: 100, step: 1, cls: "mp-range" }),
      })}

      ${card({
        label: "",
        minorValue: "Leverage",
        minorNote: `up to ${WALLET_LEV_CAP}x`,
        major: String(DEFAULT_LEV),
        majorUnit: "x",
        attrs: { id: "mp-lev-card" },
        below: slider({
          name: "lev",
          value: DEFAULT_LEV,
          min: 1,
          max: WALLET_LEV_CAP,
          step: 1,
          cls: "mp-range",
        }),
      })}

      <div class="modal__rows" id="mp-calc"></div>
      <div class="mp-err" id="mp-err" hidden></div>
      ${button({ label: "Open paper position", type: "submit", variant: "primary", cta: true, cls: "mp-submit", attrs: { id: "mp-submit" } })}
    </form>`;
}

/** Слайдеры внутри карточек — по data-slider, ids больше не нужны. */
const levEl = () => document.querySelector('#mp-form [data-slider="lev"]');
const sizeEl = () => document.querySelector('#mp-form [data-slider="size"]');

/** Заливка до бегунка живёт в --fill (см. ui.js slider) — двигаем её руками. */
function paintSlider(el) {
  if (!el) return;
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--fill", `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
}

// Clamp the leverage slider to what the picked coin allows (HL max, capped at
// the wallet's practical WALLET_LEV_CAP). Shows a hint when the coin caps lower.
function applyCoinLeverageCap() {
  const coin = (document.getElementById("mp-coin")?.value || "").trim().toUpperCase();
  const lev = levEl();
  const hint = document.querySelector("#mp-lev-card .modal__card-minor span");
  if (!lev) return;
  const coinMax = coinLeverage[coin];
  const cap = Math.min(WALLET_LEV_CAP, Number.isFinite(coinMax) && coinMax > 0 ? coinMax : WALLET_LEV_CAP);
  lev.max = String(cap);
  if (Number(lev.value) > cap) lev.value = String(cap);
  if (hint) {
    // Show the binding constraint: the coin's HL cap when it's the lower one,
    // otherwise the wallet's practical cap.
    // Подпись стоит всегда: пустое место читается как «ограничения нет».
    if (coin && Number.isFinite(coinMax) && coinMax < WALLET_LEV_CAP)
      hint.textContent = `${coin} caps at ${coinMax}x`;
    else hint.textContent = `up to ${cap}x`;
  }
  recalc();
}

function recalc() {
  const lev = pickNum(levEl()?.value, 1);
  const pct = pickNum(sizeEl()?.value, 0);
  const margin = (lastEquity * pct) / 100;
  const notional = margin * lev;

  const levMajor = document.querySelector("#mp-lev-card .modal__card-major");
  const marginMajor = document.querySelector("#mp-margin-card .modal__card-major");
  const equityCell = document.querySelector("#mp-margin-card .modal__card-minor b");
  if (levMajor) levMajor.innerHTML = `${lev}<i>x</i>`;
  if (marginMajor) marginMajor.textContent = `${pct}%`;
  if (equityCell) equityCell.textContent = lastEquity > 0 ? fmtUsd(lastEquity) : "—";
  paintSlider(levEl());
  paintSlider(sizeEl());

  // Строки-факты: слева что, справа сколько.
  const calc = document.getElementById("mp-calc");
  if (calc) {
    calc.innerHTML = lastEquity > 0
      ? `<div class="modal__row"><span>Margin</span><b>${fmtUsd(margin)}</b></div>
         <div class="modal__row"><span>Position size</span><b>${fmtUsd(notional)}</b></div>`
      : `<div class="modal__row"><span>Equity unavailable</span><b>set the size by hand</b></div>`;
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
  dialog.show({
    id: "mp-modal",
    glyph: "add",
    title: "New paper trade",
    sub: "Entry at the current price; the bot manages the exit",
    body: formHtml(prefill),
  });

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
  form.querySelectorAll(".seg--wide .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      form.querySelectorAll(".seg--wide .seg__btn").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
    }),
  );
  // Re-check the coin's leverage cap whenever the typed coin changes.
  document.getElementById("mp-coin").addEventListener("change", applyCoinLeverageCap);
  document.getElementById("mp-coin").addEventListener("input", applyCoinLeverageCap);
  levEl().addEventListener("input", recalc);
  sizeEl().addEventListener("input", recalc);
  form.addEventListener("submit", onSubmit);
}

async function onSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const err = document.getElementById("mp-err");
  const showErr = (m) => { if (err) { err.textContent = m; err.hidden = false; } };
  err.hidden = true;

  const coin = (document.getElementById("mp-coin").value || "").trim().toUpperCase();
  const side = document.querySelector("#mp-form .seg--wide .seg__btn.is-on")?.dataset.side || "long";
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
  const arrow = icon(isShort ? "short" : "long");
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
      <td class="c">${button({
        label: "Close",
        size: "sm",
        cls: "mp-close-btn",
        attrs: {
          "data-mp-close-id": p.id,
          "data-mp-coin": p.coin,
          "data-mp-side": p.side,
          "data-mp-lev": p.leverage,
          "data-mp-size": p.sizeUsd,
          "data-mp-entry": p.entryPrice,
          "data-mp-mark-px": p.markPrice ?? "",
          "data-mp-pnl": pnl ?? "",
          "data-mp-roe": roe ?? "",
        },
      })}</td>
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
          <span class="mp-active-meta">${used}/${max} · ${managed ? `${icon("bot")} bot manages exit` : "bot hands-off"}</span>
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
  const modal = dialog.shell("mp-confirm");
  if (modal.dataset.mpBound) return modal;
  modal.dataset.mpBound = "1";
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-mp-cancel]")) settleConfirm(false);
    if (e.target.closest("[data-mp-confirm]")) settleConfirm(true);
  });
  // 🚨 Escape тут разрешает промис отказом, иначе вызывающий код навсегда
  // останется ждать ответа — поэтому свой обработчик, а не bindClose.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) settleConfirm(false);
  });
  return modal;
}

function hideConfirm() {
  dialog.close(dialog.shell("mp-confirm"));
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
  const cancel = document.querySelector("#mp-confirm [data-mp-cancel]");
  if (btn) {
    btn.disabled = busyNow;
    btn.textContent = busyNow ? "Closing…" : "Close position";
  }
  if (cancel) cancel.disabled = busyNow;
}

function confirmClose(info, errMsg) {
  ensureConfirm();
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
  dialog.show({
    id: "mp-confirm",
    tone: "danger",
    glyph: "warn",
    title: `Close #${escapeHtml(info.coin || "")}?`,
    sub: "This can't be undone",
    body: `
    <div class="mp-lead">Closes the paper position at the current mark price. The result lands in the journal.</div>
    <div class="mp-confirm-grid">
      ${cell("Side", `${icon(isShort ? "short" : "long")} ${escapeHtml(info.side || "—")}${info.lev ? " " + info.lev + "×" : ""}`, isShort ? "num-neg" : "num-pos")}
      ${cell("Size", size == null ? "—" : fmtUsd(size))}
      ${cell("Entry", entry == null ? "—" : "$" + fmtPrice(entry))}
      ${cell("Mark", mark == null ? "—" : "$" + fmtPrice(mark))}
      ${cell("uPnL", pnl == null ? "—" : fmtUsd(pnl) + (roe == null ? "" : ` (${fmtPct(roe)})`), pnlCls)}
    </div>
    <div class="mp-err"${errMsg ? "" : " hidden"}>${escapeHtml(errMsg || "")}</div>`,
    actions:
      button({ label: "Keep it", variant: "ghost", attrs: { "data-mp-cancel": true } }) +
      button({
        label: errMsg ? "Retry close" : "Close position",
        variant: "danger",
        attrs: { "data-mp-confirm": true, "data-autofocus": true },
      }),
  });
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
