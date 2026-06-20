// ─────────────────────────────────────────────────
//  "What if…" — discipline brake button in Hot Movers.
//  Itchy hands, no signals → type a coin (+optional side) → backend (/api/whatif)
//  applies the LIVE fade-high-ER rule + regime gate to that coin and answers:
//  edge is with you / against the edge / sit on your hands. NOT a signal generator —
//  a discipline check against the existing edge.
//
//  Reuses the help/trade-modal markup pattern (#whatif-modal in index.html) but its
//  panel is theme-aware (see _whatif.scss override). initWhatIf() wires delegated
//  listeners. Copy is English; verdict icons are inline SVG (no emoji).
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

let busy = false;

// ── Inline line-SVG icons (stroke=currentColor → colored by verdict class) ──
const SVG = {
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  ban:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>',
  snow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/></svg>',
  wait:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/></svg>',
  target:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.7" fill="currentColor" stroke="none"/></svg>',
};

// verdict → icon. tone (pat/smack/neutral) drives the card tint via class.
const VERDICT_ICON = {
  aligned: SVG.check,
  against: SVG.ban,
  cold: SVG.snow,
  "no-signal": SVG.wait,
  edge: SVG.target,
};

const TONE_CLS = { pat: "wi-pat", smack: "wi-smack", neutral: "wi-neutral" };

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

// ── Start form: coin field + optional side toggle + submit ──
function formHtml(coin = "", side = "") {
  const sideBtn = (val, label) =>
    `<button type="button" class="wi-side-btn ${side === val ? "is-on" : ""}" data-side="${val}">${label}</button>`;
  return `
    <div class="wi-title">What if…</div>
    <div class="wi-lead">Sanity-check an entry against the fade-high-ER edge (the same rule the live slot trades). The default answer is "sit on your hands" — that's a feature, not a bug.</div>
    <form id="wi-form" class="wi-form" autocomplete="off">
      <label class="wi-label">Coin (Hyperliquid ticker)</label>
      <input id="wi-coin" class="wi-input" type="text" placeholder="e.g. BTC, SOL, kBONK" value="${escapeHtml(coin)}" />
      <label class="wi-label">Side (optional)</label>
      <div class="wi-sides">
        ${sideBtn("LONG", "Long")}
        ${sideBtn("SHORT", "Short")}
        ${sideBtn("", "Either")}
      </div>
      <input type="hidden" id="wi-side" value="${escapeHtml(side)}" />
      <button type="submit" class="wi-submit">Check</button>
      <div id="wi-error" class="wi-error" hidden></div>
    </form>`;
}

// ── Loader: spinner + staged "scanning" steps ──
function loaderHtml(coin) {
  return `
    <div class="wi-title">Scanning #${escapeHtml(coin.toUpperCase())}…</div>
    <div class="wi-loader">
      <span class="wi-spinner" aria-hidden="true"></span>
      <span id="wi-loader-step" class="wi-loader-step">Fetching 15m candles…</span>
    </div>`;
}

const LOADER_STEPS = [
  "Fetching 15m candles…",
  "Computing 30m move & 4h Kaufman ER…",
  "Checking BTC market regime…",
  "Weighing the edge…",
];

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

function resultHtml(r) {
  const toneCls = TONE_CLS[r.tone] || TONE_CLS.neutral;
  const icon = VERDICT_ICON[r.verdict] || SVG.wait;
  const th = r.thresholds || {};

  // Raw numbers — always shown, even when there is no signal: you see WHY.
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
      ${chip("30m move", fmtPct(r.move), moveOk, `Needs |move| ≥ ${th.moveThr ?? 3}% over 30m`)}
      ${chip("Coin 4h ER", r.er != null ? r.er.toFixed(2) : "—", erOk, `Kaufman ER ≥ ${th.erMin ?? 0.47} = clean directional move (exhausted tail)`)}
      ${chip("BTC 4h ER", r.btcER != null ? r.btcER.toFixed(2) : "—", btcOk, `Market is "hot" when BTC ER ≥ ${th.btcErMin ?? 0.55}; otherwise fade loses`)}
    </div>`;

  let plan = "";
  if (r.plan) {
    const zone =
      r.plan.zoneLo != null && r.plan.zoneHi != null
        ? `$${fmtPrice(r.plan.zoneLo)}–$${fmtPrice(r.plan.zoneHi)}`
        : fmtPrice(r.price);
    const stop = r.plan.stop != null ? `$${fmtPrice(r.plan.stop)}` : "—";
    const exitH = r.plan.timeStopMin != null ? `~${Math.round(r.plan.timeStopMin / 60)}h` : "~2h";
    plan = `
      <div class="wi-plan">
        <div class="wi-plan-title">If you do take the fade ${escapeHtml(r.fadeSide || "")}:</div>
        <div class="wi-plan-grid">
          <div><span>Zone</span>${zone}</div>
          <div><span>Stop (${r.plan.stopPct}%)</span>${stop}</div>
          <div><span>Time exit</span>${exitH}</div>
        </div>
      </div>`;
  }

  const sideLine = r.userSide
    ? `<span class="wi-userside">your side: ${r.userSide}</span>`
    : "";

  return `
    <div class="wi-title">#${escapeHtml(r.coin)} <span class="wi-px">$${fmtPrice(r.price)}</span> ${sideLine}</div>
    <div class="wi-verdict ${toneCls}">
      <div class="wi-verdict-icon">${icon}</div>
      <div class="wi-verdict-text">
        <div class="wi-verdict-head">${escapeHtml(r.headline)}</div>
        <div class="wi-verdict-detail">${escapeHtml(r.detail)}</div>
      </div>
    </div>
    ${metrics}
    ${plan}
    <button type="button" class="wi-again" id="wi-again">← Check another coin</button>`;
}

async function runCheck(coin, side) {
  if (busy) return;
  busy = true;

  openModal(loaderHtml(coin));
  // Staged "scanning" feel: cycle step text while the real fetch runs.
  let stepIdx = 0;
  const stepTimer = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, LOADER_STEPS.length - 1);
    const el = document.getElementById("wi-loader-step");
    if (el) el.textContent = LOADER_STEPS[stepIdx];
  }, 480);
  // Minimum dwell so the verdict doesn't flash instantly (deliberate, considered).
  const minDwell = new Promise((res) => setTimeout(res, 1500));

  try {
    const q = new URLSearchParams({ coin });
    if (side) q.set("side", side);
    const [r] = await Promise.all([fetchJson(`/api/whatif?${q.toString()}`), minDwell]);
    clearInterval(stepTimer);

    if (r?.error) {
      openModal(formHtml(coin, side));
      const errEl = document.getElementById("wi-error");
      if (errEl) { errEl.textContent = r.error; errEl.hidden = false; }
      return;
    }
    openModal(resultHtml(r));
  } catch (err) {
    clearInterval(stepTimer);
    openModal(formHtml(coin, side));
    const errEl = document.getElementById("wi-error");
    if (errEl) { errEl.textContent = "Check failed — try again"; errEl.hidden = false; }
  } finally {
    busy = false;
  }
}

export function initWhatIf() {
  document.addEventListener("click", (e) => {
    // Open the form.
    if (e.target.closest("#whatif-btn")) {
      openModal(formHtml());
      setTimeout(() => document.getElementById("wi-coin")?.focus(), 0);
      return;
    }
    // Close (backdrop / ×).
    if (e.target.closest("#whatif-modal [data-close]")) {
      closeModal();
      return;
    }
    // Back to the form.
    if (e.target.closest("#wi-again")) {
      openModal(formHtml());
      setTimeout(() => document.getElementById("wi-coin")?.focus(), 0);
      return;
    }
    // Side toggle.
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
      if (errEl) { errEl.textContent = "Enter a coin ticker"; errEl.hidden = false; }
      return;
    }
    runCheck(coin, side);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}
