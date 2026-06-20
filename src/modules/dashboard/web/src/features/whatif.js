// ─────────────────────────────────────────────────
//  «А что если…» — кнопка-тормоз в Hot Movers.
//  Руки чешутся → вводишь монету (+опц. сторону) → бэкенд (/api/whatif)
//  применяет боевое правило fade-high-ER + гейт режима к этой монете и говорит:
//  погладить (эдж за тебя), по шапке (против эджа / рынок холодный) или
//  «сиди на руках» (сигнала нет). НЕ генератор сигналов — дисциплинарный чек.
//
//  Переиспользует модальный паттерн help/trade-modal (#whatif-modal в index.html):
//  тот же бэкдроп/закрытие. initWhatIf() вешает делегированные listener'ы.
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

let busy = false;

function openModal(html) {
  const modal = document.getElementById("whatif-modal");
  const body = document.getElementById("whatif-modal-body");
  if (!modal || !body) return;
  body.innerHTML = html;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  const modal = document.getElementById("whatif-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

// Стартовая форма: поле монеты + выбор стороны (необязательный) + кнопка.
function formHtml(coin = "", side = "") {
  const sideBtn = (val, label) =>
    `<button type="button" class="wi-side-btn ${side === val ? "is-on" : ""}" data-side="${val}">${label}</button>`;
  return `
    <div class="wi-title">🤔 А что если…</div>
    <div class="wi-lead">Сверка задуманного входа с эджем fade-high-ER (то же правило, что у боевого слота). По умолчанию ответ — «сиди на руках». Это фича, не баг.</div>
    <form id="wi-form" class="wi-form" autocomplete="off">
      <label class="wi-label">Монета (тикер Hyperliquid)</label>
      <input id="wi-coin" class="wi-input" type="text" placeholder="напр. BTC, SOL, kBONK" value="${escapeHtml(coin)}" />
      <label class="wi-label">Сторона (необязательно)</label>
      <div class="wi-sides">
        ${sideBtn("LONG", "▲ LONG")}
        ${sideBtn("SHORT", "▼ SHORT")}
        ${sideBtn("", "— не указывать")}
      </div>
      <input type="hidden" id="wi-side" value="${escapeHtml(side)}" />
      <button type="submit" class="wi-submit">Проверить</button>
      <div id="wi-error" class="wi-error" hidden></div>
    </form>`;
}

function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// tone → класс/эмодзи карточки вердикта.
const TONE = {
  pat: { cls: "wi-pat", icon: "🫶" },
  smack: { cls: "wi-smack", icon: "🫳" },
  neutral: { cls: "wi-neutral", icon: "✋" },
};

function resultHtml(r) {
  const t = TONE[r.tone] || TONE.neutral;
  const th = r.thresholds || {};

  // Сырые цифры — показываем ВСЕГДА (выбор оператора 1.2), даже когда сигнала нет:
  // видно ПОЧЕМУ вердикт такой.
  const moveOk = r.move != null && Math.abs(r.move) >= (th.moveThr ?? 3);
  const erOk = r.er != null && r.er >= (th.erMin ?? 0.47);
  const btcOk = !!r.regimeHot;
  const chip = (label, val, ok, hint) =>
    `<div class="wi-metric ${ok ? "ok" : "off"}" title="${escapeHtml(hint)}">
      <div class="wi-metric-label">${label}</div>
      <div class="wi-metric-val">${val}</div>
    </div>`;

  const metrics = `
    <div class="wi-metrics">
      ${chip("Ход 30м", fmtPct(r.move), moveOk, `Нужен |ход| ≥ ${th.moveThr ?? 3}% за 30м`)}
      ${chip("ER 4ч монеты", r.er != null ? r.er.toFixed(2) : "—", erOk, `Kaufman ER ≥ ${th.erMin ?? 0.47} = чистый направленный ход (выдохшийся хвост)`)}
      ${chip("BTC ER 4ч", r.btcER != null ? r.btcER.toFixed(2) : "—", btcOk, `Рынок «горячий» при BTC ER ≥ ${th.btcErMin ?? 0.55}; иначе fade теряет`)}
    </div>`;

  let plan = "";
  if (r.plan) {
    const zone =
      r.plan.zoneLo != null && r.plan.zoneHi != null
        ? `$${fmtPrice(r.plan.zoneLo)}–$${fmtPrice(r.plan.zoneHi)}`
        : fmtPrice(r.price);
    const stop = r.plan.stop != null ? `$${fmtPrice(r.plan.stop)}` : "—";
    const exitH = r.plan.timeStopMin != null ? `~${Math.round(r.plan.timeStopMin / 60)}ч` : "~2ч";
    plan = `
      <div class="wi-plan">
        <div class="wi-plan-title">Если уж берёшь fade ${escapeHtml(r.fadeSide || "")}:</div>
        <div class="wi-plan-grid">
          <div><span>Зона</span>${zone}</div>
          <div><span>Стоп (${r.plan.stopPct}%)</span>${stop}</div>
          <div><span>Выход по времени</span>${exitH}</div>
        </div>
      </div>`;
  }

  const sideLine = r.userSide
    ? `<span class="wi-userside">твоё: ${r.userSide === "LONG" ? "▲ LONG" : "▼ SHORT"}</span>`
    : "";

  return `
    <div class="wi-title">#${escapeHtml(r.coin)} <span class="wi-px">$${fmtPrice(r.price)}</span> ${sideLine}</div>
    <div class="wi-verdict ${t.cls}">
      <div class="wi-verdict-icon">${t.icon}</div>
      <div class="wi-verdict-text">
        <div class="wi-verdict-head">${escapeHtml(r.headline)}</div>
        <div class="wi-verdict-detail">${escapeHtml(r.detail)}</div>
      </div>
    </div>
    ${metrics}
    ${plan}
    <button type="button" class="wi-again" id="wi-again">← Другая монета</button>`;
}

async function runCheck(coin, side) {
  if (busy) return;
  busy = true;
  try {
    const q = new URLSearchParams({ coin });
    if (side) q.set("side", side);
    const r = await fetchJson(`/api/whatif?${q.toString()}`);
    if (r?.error) {
      const errEl = document.getElementById("wi-error");
      if (errEl) {
        errEl.textContent = r.error;
        errEl.hidden = false;
      } else {
        openModal(formHtml(coin, side));
        const e2 = document.getElementById("wi-error");
        if (e2) { e2.textContent = r.error; e2.hidden = false; }
      }
      return;
    }
    openModal(resultHtml(r));
  } catch (err) {
    openModal(formHtml(coin, side));
    const errEl = document.getElementById("wi-error");
    if (errEl) { errEl.textContent = "Не удалось проверить — попробуй ещё раз"; errEl.hidden = false; }
  } finally {
    busy = false;
  }
}

export function initWhatIf() {
  document.addEventListener("click", (e) => {
    // Открыть форму.
    if (e.target.closest("#whatif-btn")) {
      openModal(formHtml());
      setTimeout(() => document.getElementById("wi-coin")?.focus(), 0);
      return;
    }
    // Закрытие (бэкдроп / ×).
    if (e.target.closest("#whatif-modal [data-close]")) {
      closeModal();
      return;
    }
    // Назад к форме.
    if (e.target.closest("#wi-again")) {
      openModal(formHtml());
      setTimeout(() => document.getElementById("wi-coin")?.focus(), 0);
      return;
    }
    // Выбор стороны (тоггл-кнопки).
    const sideBtn = e.target.closest(".wi-side-btn");
    if (sideBtn) {
      const val = sideBtn.dataset.side ?? "";
      const hidden = document.getElementById("wi-side");
      if (hidden) hidden.value = val;
      for (const b of document.querySelectorAll("#whatif-modal .wi-side-btn"))
        b.classList.toggle("is-on", b === sideBtn);
      return;
    }
  });

  document.addEventListener("submit", (e) => {
    if (!e.target.closest("#wi-form")) return;
    e.preventDefault();
    const coin = (document.getElementById("wi-coin")?.value || "").trim();
    const side = (document.getElementById("wi-side")?.value || "").trim();
    if (!coin) {
      const errEl = document.getElementById("wi-error");
      if (errEl) { errEl.textContent = "Введи тикер монеты"; errEl.hidden = false; }
      return;
    }
    runCheck(coin, side);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}
