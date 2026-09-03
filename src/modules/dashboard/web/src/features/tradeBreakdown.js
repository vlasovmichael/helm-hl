// ─────────────────────────────────────────────────
//  Разбор моих сделок — таблица по стороне/стратегии/монете + Мои правила
// ─────────────────────────────────────────────────
// Данные: /api/my-trades (routes/tradeBreakdown.js). Это единственная аналитика,
// которой нет на TV/Coinglass — считается по собственным сделкам оператора. Правила
// приходят из того же ответа (единый источник), чтобы цифры и выводы не разъехались.

import { fetchJson } from "../net/api.js";
import { emptyState } from "../core/placeholders.js";

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function signCls(v) {
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

function money(v) {
  const n = Number(v) || 0;
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
}

function fmtDay(ts) {
  if (!ts) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

// payoff <1 = винеры мельче лузеров (леак), ≥1.5 = здорово. Подсветка помогает
// глазу: красный payoff при зелёном win% = «выигрываю часто, но по чуть-чуть».
function payoffCls(p) {
  if (p == null) return "";
  return p >= 1.5 ? "positive" : p < 1 ? "negative" : "";
}

function statRow(label, s, { strong = false } = {}) {
  if (!s) {
    return `<tr><td class="mt-label">${esc(label)}</td><td colspan="5" class="mt-empty">no trades</td></tr>`;
  }
  return `
    <tr class="${strong ? "mt-strong" : ""}">
      <td class="mt-label">${esc(label)}</td>
      <td class="mt-num">${s.n}</td>
      <td class="mt-num">${s.winPct}%</td>
      <td class="mt-num ${payoffCls(s.payoff)}">${s.payoff != null ? s.payoff.toFixed(2) : "—"}</td>
      <td class="mt-num ${signCls(s.expectancy)}">${s.expectancy >= 0 ? "+" : "−"}$${Math.abs(s.expectancy).toFixed(3)}</td>
      <td class="mt-num ${signCls(s.net)}">${money(s.net)}</td>
    </tr>`;
}

function coinChip(c) {
  return `<span class="mt-chip ${signCls(c.net)}">${esc(c.coin)} <b>${money(c.net)}</b><i>n=${c.n}</i></span>`;
}

function renderBreakdown(data) {
  const body = document.getElementById("mytrades-body");
  const periodEl = document.getElementById("mytrades-period");
  const rulesEl = document.getElementById("mytrades-rules");
  if (!body) return;

  // Правила рисуем всегда (даже если сделок ещё нет).
  if (rulesEl && Array.isArray(data.rules)) {
    rulesEl.innerHTML =
      `<div class="mt-rules-title">My rules <span>— derived from these numbers, so the account stops bleeding</span></div>` +
      data.rules
        .map(
          (r) => `
        <div class="mt-rule">
          <div class="mt-rule-n">${r.n}</div>
          <div class="mt-rule-txt">
            <div class="mt-rule-head">${esc(r.title)}<span class="mt-rule-metric">${esc(r.metric)}</span></div>
            <div class="mt-rule-body">${esc(r.body)}</div>
          </div>
        </div>`,
        )
        .join("");
  }

  if (data.empty || !data.overall) {
    body.innerHTML = emptyState({
      glyph: "clock",
      title: "No closed trades yet",
      hint: "The breakdown appears once a real trade is opened and closed.",
    });
    return;
  }

  if (periodEl && data.period) {
    periodEl.textContent = `${fmtDay(data.period.from)} → ${fmtDay(data.period.to)}`;
  }

  const o = data.overall;
  const grossCls = o.gross > 0 ? "positive" : "negative";

  body.innerHTML = `
    <div class="mt-headline">
      <div class="mt-hl-item">
        <span class="mt-hl-label">Trades total</span>
        <span class="mt-hl-value">${o.n}</span>
      </div>
      <div class="mt-hl-item">
        <span class="mt-hl-label">Win rate</span>
        <span class="mt-hl-value">${o.winPct}%</span>
      </div>
      <div class="mt-hl-item">
        <span class="mt-hl-label">Payoff</span>
        <span class="mt-hl-value ${payoffCls(o.payoff)}">${o.payoff != null ? o.payoff.toFixed(2) : "—"}</span>
      </div>
      <div class="mt-hl-item">
        <span class="mt-hl-label">Net</span>
        <span class="mt-hl-value ${signCls(o.net)}">${money(o.net)}</span>
      </div>
    </div>
    <div class="mt-fee-note ${grossCls}">
      Before fees: <b>${money(o.gross)}</b> · fees: <b>−$${o.fees.toFixed(2)}</b> ·
      after fees: <b>${money(o.net)}</b>
      ${o.gross > 0 && o.net < 0 ? "<span class=\"mt-flag\">← fees ate the entire gain</span>" : ""}
    </div>

    <div class="mt-table-wrap">
      <table class="mt-table">
        <thead>
          <tr><th>Cut</th><th>n</th><th>Win</th><th>Payoff</th><th>Expect.</th><th>Net</th></tr>
        </thead>
        <tbody>
          ${statRow("TOTAL", o, { strong: true })}
          <tr class="mt-divider"><td colspan="6">By side</td></tr>
          ${data.bySide.map((s) => statRow(s.key === "long" ? "Longs" : s.key === "short" ? "Shorts" : s.key, s)).join("")}
          <tr class="mt-divider"><td colspan="6">By strategy</td></tr>
          ${data.byStrategy.map((s) => statRow(s.key, s)).join("")}
        </tbody>
      </table>
    </div>

    <div class="mt-coins">
      <div class="mt-coins-col">
        <div class="mt-coins-title negative">Black holes</div>
        <div class="mt-chips">${data.byCoin.worst.map(coinChip).join("")}</div>
      </div>
      <div class="mt-coins-col">
        <div class="mt-coins-title positive">Best coins</div>
        <div class="mt-chips">${data.byCoin.best.map(coinChip).join("")}</div>
      </div>
    </div>`;
}

export async function tickTradeBreakdown() {
  try {
    const data = await fetchJson("/api/my-trades");
    renderBreakdown(data);
  } catch (err) {
    const body = document.getElementById("mytrades-body");
    if (body)
      body.innerHTML = emptyState({
        glyph: "danger",
        title: "Breakdown did not load",
        hint: `${esc(err.message)}. Reload the page to try again.`,
      });
  }
}
