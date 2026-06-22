// ─────────────────────────────────────────────────
//  Мой папер (Rabbit-style) — модалка входа + карточка управления
// ─────────────────────────────────────────────────
// «Вижу движуху в Hot Movers → жму кнопку → попап: монета, сторона, плечо,
//  слайдер от реального депо → открываю бумажную сделку.» Бот её не торгует —
//  держу/закрываю руками. Открытые позы + live mark-to-market показываются на
//  Lab (карточка «Мой папер»), архив — в таблице Strategies (manual_paper).
//
// Модалка инжектит свой DOM в body (работает и на index, и на lab без правки
// HTML). REST: GET/POST /api/manual-paper(/open|/close).

import { escapeHtml, fmtUsd, fmtPct, fmtPrice } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

let busy = false;
let lastEquity = 0;

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
  modal.className = "mp-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="mp-backdrop" data-mp-close></div>
    <div class="mp-panel" role="dialog" aria-label="Новая бумажная сделка">
      <button class="mp-x" type="button" data-mp-close aria-label="Закрыть">×</button>
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
    `<button type="button" class="mp-side-btn ${side === val ? "is-on" : ""}" data-side="${val}">${label}</button>`;
  return `
    <div class="mp-title">Новая бумажная сделка</div>
    <div class="mp-lead">Как в Rabbit, только на бумаге. Вход по текущей цене. Бот ведёт выход (ATR-стоп + безубыток-храповик + трейл), как у adopt — можешь и сам закрыть в любой момент.</div>
    <form id="mp-form" autocomplete="off">
      <label class="mp-label">Монета</label>
      <select id="mp-coin" class="mp-input mp-select" data-prefill="${escapeHtml(coin)}">
        <option value="">загрузка списка…</option>
      </select>

      <label class="mp-label">Сторона</label>
      <div class="mp-sides">${sideBtn("long", "▲ Long")}${sideBtn("short", "▼ Short")}</div>

      <label class="mp-label">Плечо: <span id="mp-lev-val">3×</span></label>
      <input id="mp-lev" class="mp-range" type="range" min="1" max="50" step="1" value="3" />

      <label class="mp-label">Маржа от депо: <span id="mp-margin-val">10%</span></label>
      <input id="mp-size" class="mp-range" type="range" min="1" max="100" step="1" value="10" />

      <div class="mp-calc" id="mp-calc"></div>
      <div class="mp-err" id="mp-err" hidden></div>
      <button type="submit" class="mp-submit" id="mp-submit">Открыть бумажную позу</button>
    </form>`;
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
      ? `Депо <strong>${fmtUsd(lastEquity)}</strong> · маржа <strong>${fmtUsd(margin)}</strong> · размер позы <strong>${fmtUsd(notional)}</strong>`
      : `Депо недоступно — задай размер позиции вручную плечом × %.`;
  }
  return { lev, notional, margin };
}

function populateCoins(coins) {
  const sel = document.getElementById("mp-coin");
  if (!sel) return;
  const prefill = (sel.dataset.prefill || "").toUpperCase();
  if (!coins.length) {
    sel.innerHTML = '<option value="">список недоступен</option>';
    return;
  }
  const opts = ['<option value="" disabled>— выбери монету —</option>'].concat(
    coins.map(
      (c) => `<option value="${escapeHtml(c)}"${c === prefill ? " selected" : ""}>${escapeHtml(c)}</option>`,
    ),
  );
  sel.innerHTML = opts.join("");
  // Если префилла нет/не нашёлся — оставляем плейсхолдер активным.
  if (!prefill || !coins.includes(prefill)) sel.value = "";
}

async function openModal(prefill = {}) {
  const modal = ensureModal();
  document.getElementById("mp-body").innerHTML = formHtml(prefill);
  modal.hidden = false;
  document.body.style.overflow = "hidden";

  // Депо для слайдера + список монет для дропдауна.
  try {
    const data = await fetchJson("/api/manual-paper");
    lastEquity = pickNum(data?.equity, 0);
    populateCoins(Array.isArray(data?.coins) ? data.coins : []);
  } catch {
    lastEquity = 0;
    populateCoins([]);
  }
  recalc();

  const form = document.getElementById("mp-form");
  form.querySelectorAll(".mp-side-btn").forEach((b) =>
    b.addEventListener("click", () => {
      form.querySelectorAll(".mp-side-btn").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
    }),
  );
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
  if (!coin) return showErr("Выбери монету из списка.");
  if (!(notional > 0)) return showErr("Размер позы 0 — двинь слайдер маржи (или депо недоступно).");

  busy = true;
  const submit = document.getElementById("mp-submit");
  submit.disabled = true;
  submit.textContent = "Открываю…";
  try {
    const res = await postJson("/api/manual-paper/open", {
      coin, side, leverage: lev, sizeUsd: notional,
    });
    if (res?.ok) {
      closeModal();
      refreshActive(); // обновить блок бумажных поз, если он на странице
    } else {
      showErr(res?.error || "Не удалось открыть.");
    }
  } catch (e2) {
    showErr(e2.message || "Сетевая ошибка.");
  } finally {
    busy = false;
    submit.disabled = false;
    submit.textContent = "Открыть бумажную позу";
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
      ? `<span class="mp-sub">пик ${p.peakPct ? fmtPct(p.peakPct) : "0%"}${
          p.stopPrice != null ? ` · стоп $${fmtPrice(p.stopPrice)}` : ""
        }</span>`
      : "";
  return `
    <tr>
      <td><span class="signals-price">#${escapeHtml(p.coin)}</span></td>
      <td class="c ${sideCls}"><strong>${arrow} ${escapeHtml(p.side)}</strong></td>
      <td class="r">${p.leverage}×</td>
      <td class="r">${fmtUsd(p.sizeUsd)}</td>
      <td class="r">$${fmtPrice(p.entryPrice)}</td>
      <td class="r" data-mp-mark>${p.markPrice != null ? "$" + fmtPrice(p.markPrice) : "—"}</td>
      <td class="r ${pnlCls}"><strong>${pnl == null ? "—" : fmtUsd(pnl)}</strong>${
        roe == null ? "" : `<span class="mp-roe">${fmtPct(roe)}</span>`
      }${sub}</td>
      <td class="c"><button type="button" class="mp-close-btn" data-mp-close-id="${p.id}" data-mp-coin="${escapeHtml(p.coin)}">Закрыть</button></td>
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
          <span>Бумажные позы · paper</span>
          <span class="mp-active-meta">${used}/${max} · ${managed ? "🤖 бот ведёт выход" : "бот не вмешивается"}</span>
        </div>
        <div class="u-scroll-x">
          <table class="data-table mp-active-table">
            <thead>
              <tr>
                <th>Coin</th><th class="c">Сторона</th><th class="r">Плечо</th>
                <th class="r">Размер</th><th class="r">Вход</th><th class="r">Цена</th>
                <th class="r" title="Нереализованный P&L (нетто) + ROE на маржу">uPnL</th>
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

async function onCloseClick(e) {
  const btn = e.target.closest("[data-mp-close-id]");
  if (!btn) return;
  const id = Number(btn.dataset.mpCloseId);
  if (!Number.isFinite(id)) return;
  if (!window.confirm(`Закрыть бумажную позу #${btn.dataset.mpCoin} по текущей цене?`)) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await postJson("/api/manual-paper/close", { id });
    if (!res?.ok) {
      btn.disabled = false;
      btn.textContent = "Закрыть";
      window.alert(res?.error || "Не удалось закрыть.");
      return;
    }
    refreshActive();
  } catch {
    btn.disabled = false;
    btn.textContent = "Закрыть";
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
