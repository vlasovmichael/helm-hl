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
    <div class="wi-title">Chart breakdown</div>
    <div class="wi-lead">Coin + side → the coach lays out trend, levels, RSI, a plan with stop/target and where you are wrong. Structure analysis, <strong>not a proven-edge signal</strong> — the decision and the risk are yours.</div>
    <form id="wi-form" class="wi-form" autocomplete="off">
      <label class="wi-label">Coin (Hyperliquid ticker)</label>
      <input id="wi-coin" class="wi-input" type="text" placeholder="e.g. BTC, SOL, kBONK" value="${escapeHtml(coin)}" />
      <label class="wi-label">Side (for the entry plan)</label>
      <div class="wi-sides">
        ${sideBtn("LONG", "Long")}
        ${sideBtn("SHORT", "Short")}
        ${sideBtn("", "No side")}
      </div>
      <input type="hidden" id="wi-side" value="${escapeHtml(side)}" />
      <button type="submit" class="wi-submit">Analyse</button>
      <div id="wi-error" class="wi-error" hidden></div>
    </form>`;
}

// ── Loader: spinner + staged "scanning" steps ──
function loaderHtml(coin) {
  return `
    <div class="wi-title">Analysing #${escapeHtml(coin.toUpperCase())}…</div>
    <div class="wi-loader">
      <span class="wi-spinner" aria-hidden="true"></span>
      <span id="wi-loader-step" class="wi-loader-step">Fetching 15m candles…</span>
    </div>`;
}

const LOADER_STEPS = [
  "Fetching 15m and 1h candles…",
  "Computing trend, RSI, ATR…",
  "Locating support/resistance…",
  "Assembling the breakdown…",
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
function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v >= 100 ? v.toFixed(0) : v.toFixed(2);
}

// tone коуча → класс тона карточки + иконка.
const COACH_TONE_CLS = {
  reasonable: "wi-pat",
  knife: "wi-smack",
  counter: "wi-neutral",
  neutral: "wi-neutral",
};
const COACH_TONE_ICON = {
  reasonable: SVG.check,
  knife: SVG.ban,
  counter: SVG.target,
  neutral: SVG.wait,
};
const TREND_WORD = { up: "up ▲", down: "down ▼", flat: "flat →" };

function resultHtml(r) {
  const sideLine = r.userSide
    ? `<span class="wi-userside">your side: ${r.userSide}</span>`
    : "";
  const head = `<div class="wi-title">#${escapeHtml(r.coin)} <span class="wi-px">${fmtPrice(r.price)}</span> ${sideLine}</div>`;

  const c = r.coach;
  // Фолбэк: если coach не построился (нет свечей) — старый fade-вердикт.
  if (!c || !c.ok) return head + legacyEdgeBlock(r) +
    `<button type="button" class="wi-again" id="wi-again">← Another coin</button>`;

  // ── Коуч-вердикт (ведущий блок) ──
  let verdictBlock = "";
  if (c.verdict) {
    const toneCls = COACH_TONE_CLS[c.verdict.tone] || "wi-neutral";
    const icon = COACH_TONE_ICON[c.verdict.tone] || SVG.wait;
    verdictBlock = `
      <div class="wi-verdict ${toneCls}">
        <div class="wi-verdict-icon">${icon}</div>
        <div class="wi-verdict-text">
          <div class="wi-verdict-head">${escapeHtml(c.verdict.headline)}</div>
          <div class="wi-verdict-detail">${escapeHtml(c.verdict.detail)}</div>
        </div>
      </div>`;
  } else {
    verdictBlock = `<div class="wi-lead">Pick a side (Long/Short) to get an entry plan with stop and target. Chart structure is below.</div>`;
  }

  // ── Структура: тренды / RSI / ATR ──
  const rsiCls = c.rsi14 == null ? "" : c.rsi14 >= 70 ? "off" : c.rsi14 <= 30 ? "off" : "ok";
  const structure = `
    <div class="wi-metrics">
      <div class="wi-metric ok"><div class="wi-metric-label">1h trend</div><div class="wi-metric-val">${TREND_WORD[c.htfTrend] || "—"}</div></div>
      <div class="wi-metric ok"><div class="wi-metric-label">15m trend</div><div class="wi-metric-val">${TREND_WORD[c.ltfTrend] || "—"}</div></div>
      <div class="wi-metric ${rsiCls}"><div class="wi-metric-label">RSI 14</div><div class="wi-metric-val">${c.rsi14 != null ? c.rsi14.toFixed(0) : "—"}</div></div>
    </div>`;

  // ── Уровни ──
  const supLine = c.support != null
    ? `<div><span>Support</span>${fmtPrice(c.support)} <em>(${fmtPct(-Math.abs(c.distToSupport))})</em></div>` : "";
  const resLine = c.resistance != null
    ? `<div><span>Resistance</span>${fmtPrice(c.resistance)} <em>(${fmtPct(Math.abs(c.distToResistance))})</em></div>` : "";
  const levels = (supLine || resLine)
    ? `<div class="wi-plan"><div class="wi-plan-title">Nearest levels</div><div class="wi-plan-grid">${supLine}${resLine}</div></div>` : "";

  // ── План под сторону ──
  let plan = "";
  if (c.plan) {
    const rr = c.plan.rr != null ? `${c.plan.rr.toFixed(2)}R` : "—";
    const stop = c.plan.stop != null ? `${fmtPrice(c.plan.stop)}` : "—";
    const target = c.plan.target != null ? `${fmtPrice(c.plan.target)}` : "—";
    const inval = c.plan.invalidation != null ? `${fmtPrice(c.plan.invalidation)}` : "—";
    // Санити стопа vs ATR — подсветка под строкой стопа.
    const ss = c.stopSanity;
    const ssNote = ss
      ? `<div class="wi-subnote wi-ss-${ss.level}">🛡 ${escapeHtml(ss.note)}</div>` : "";
    // Риск-калькулятор размера.
    const sz = c.sizing;
    const szNote = sz
      ? `<div class="wi-subnote wi-size">📏 Risking ${sz.riskBudgetPct}% of the account ($${fmtNum(sz.riskUsd)}) with this stop, size should be <strong>$${fmtNum(sz.suggestedSizeUsd)}</strong> (account $${fmtNum(sz.equity)}).</div>` : "";
    plan = `
      <div class="wi-plan">
        <div class="wi-plan-title">Plan for ${escapeHtml(c.plan.side)}</div>
        <div class="wi-plan-grid">
          <div><span>Stop (${fmtPct(-Math.abs(c.plan.riskPct))})</span>${stop}</div>
          <div><span>Target (${c.plan.rewardPct != null ? fmtPct(Math.abs(c.plan.rewardPct)) : "—"})</span>${target}</div>
          <div><span>R:R</span>${rr}</div>
          <div><span>Wrong if beyond</span>${inval}</div>
        </div>
        ${ssNote}
        ${szNote}
      </div>`;
  }

  // Order-flow «под капотом» (OI / объём / funding).
  const flow = (c.orderFlow && c.orderFlow.length)
    ? `<div class="wi-flow"><div class="wi-flow-title">⚙️ Under the hood (flow)</div><ul>${c.orderFlow.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`
    : "";

  // ── Сценарии ──
  const caseList = (title, arr, cls) => arr && arr.length
    ? `<div class="wi-case ${cls}"><div class="wi-case-title">${title}</div><ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const cases = `<div class="wi-cases">${caseList("For the trade", c.bull, "wi-case-bull")}${caseList("Against", c.bear, "wi-case-bear")}</div>`;

  // ── Учёба на твоей истории (зеркало привычки) ──
  const learn = c.learn
    ? `<div class="wi-learn"><span class="wi-learn-tag">🪞 Your history (${c.learn.n})</span> ${escapeHtml(c.learn.note)}<span class="wi-learn-meta">winrate ${c.learn.winRate}% · payoff ${c.learn.payoff != null ? c.learn.payoff + "×" : "—"}</span></div>`
    : "";

  // ── Вторичная честная строка: проверенный fade-эдж ──
  const edgeNote = `<div class="wi-edge-note">${r.fired
    ? `⚡ Bonus: a verified fade edge lines up here too (${escapeHtml(r.fadeSide || "")}).`
    : `No verified edge here — this is analysis, not a signal. ${escapeHtml(c.disclaimer)}`}</div>`;

  return head + verdictBlock + structure + flow + levels + plan + cases + learn + edgeNote +
    `<button type="button" class="wi-again" id="wi-again">← Another coin</button>`;
}

// Старый fade-вердикт как фолбэк, если coach не построился.
function legacyEdgeBlock(r) {
  const toneCls = TONE_CLS[r.tone] || TONE_CLS.neutral;
  const icon = VERDICT_ICON[r.verdict] || SVG.wait;
  return `
    <div class="wi-verdict ${toneCls}">
      <div class="wi-verdict-icon">${icon}</div>
      <div class="wi-verdict-text">
        <div class="wi-verdict-head">${escapeHtml(r.headline || "Nothing to analyse")}</div>
        <div class="wi-verdict-detail">${escapeHtml(r.detail || "Could not fetch candles for this coin.")}</div>
      </div>
    </div>`;
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
