// ─────────────────────────────────────────────────
//  Модалки + Activity-лента.
//  · Help modal — mini-FAQ по карточкам (HELP_CONTENT расширяемый, по data-help).
//  · Trade detail modal — клик по событию в Activity → разбор сделки (+ дозагрузка
//    деталей через /api/trade/:id).
//  · renderActivity — лента последних событий (open/close), кликабельные строки.
//  initModals() вешает один делегированный document-listener на обе модалки +
//  activity-клик + Escape. Экспорт: renderActivity, initModals.
// ─────────────────────────────────────────────────

import {
  strategyDisplayName,
  escapeHtml,
  fmtSince,
  fmtNotional,
} from "../utils/format.js";
import { fetchJson } from "../net/api.js";
import * as dialog from "../core/dialog.js";
import { icon } from "../core/icon.js";

let lastActivityEvents = [];

// Источник сделки → бейдж. bot = бот сам открыл+закрыл; adopted = я вошёл,
// бот подхватил выход (adopt-нянька); manual = вход и выход мои.
const SOURCE_META = {
  bot: { label: "BOT", cls: "src-bot" },
  adopted: { label: "ADOPTED", cls: "src-adopted" },
  manual: { label: "MANUAL", cls: "src-manual" },
};

function eventSource(e) {
  if (e.source) return e.source;
  if (e.strategy_id === "adopt") return "adopted";
  if (e.kind === "manual_close" || e.strategy_id === "manual") return "manual";
  return "bot";
}

function reasonLabel(reason) {
  if (!reason) return "";
  return String(reason).replace(/_/g, " ");
}

export function renderActivity(activity) {
  const container = document.getElementById("activity-container");
  if (!container) return; // нет секции (напр. /strategies.html)
  const events = (activity?.events || []).filter((e) => e && e.coin);
  lastActivityEvents = events;
  if (!events.length) {
    container.innerHTML = '<div class="empty-state">No events</div>';
    return;
  }
  container.innerHTML = events
    .map((e, idx) => {
      const isOpen = e.kind === "open";
      const kindLabel = isOpen ? "OPEN" : "CLOSE";
      const kindClass = isOpen ? "open" : "close";

      const src = eventSource(e);
      const sm = SOURCE_META[src] || SOURCE_META.bot;
      const srcBadge = `<span class="src-badge ${sm.cls}" title="${strategyDisplayName(
        e.strategy_id,
      )}">${sm.label}</span>`;

      const side = (e.side || "").toUpperCase();
      const sideChip = side
        ? `<span class="side-chip side-${side.toLowerCase()}">${side}</span>`
        : "";

      const reason = !isOpen && e.reason
        ? `<span class="activity-reason">${escapeHtml(reasonLabel(e.reason))}</span>`
        : "";

      const metaBits = [];
      if (Number.isFinite(e.sizeUsd) && e.sizeUsd > 0)
        metaBits.push(fmtNotional(e.sizeUsd));
      if (Number.isFinite(e.ts)) metaBits.push(`${fmtSince(e.ts)} ago`);
      const meta = metaBits.length
        ? `<span class="activity-meta">${metaBits.join(" · ")}</span>`
        : "";

      let pnlCell;
      if (isOpen) {
        pnlCell = '<span class="activity-pnl dim">open</span>';
      } else {
        const pnlVal = e.pnl || 0;
        pnlCell = `<span class="activity-pnl ${
          pnlVal >= 0 ? "positive" : "negative"
        }">${pnlVal >= 0 ? "+" : ""}${pnlVal.toFixed(2)}</span>`;
      }

      const canOpen =
        e.kind === "close" || e.kind === "manual_close" || e.kind === "open";
      const clickable = canOpen ? "clickable" : "";
      const idxAttr = canOpen ? `data-activity-idx="${idx}"` : "";
      return `
      <div class="activity-item ${clickable}" ${idxAttr}>
        <span class="activity-kind ${kindClass}">${kindLabel}</span>
        <span class="activity-coin">#${escapeHtml(e.coin)}</span>
        ${sideChip}
        ${srcBadge}
        ${reason}
        ${meta}
        ${pnlCell}
      </div>`;
    })
    .join("");
}

// ── Help modal (mini FAQ per card) ─────────────────────────────────────
// Записи добавляются по мере появления карточек с кнопкой [?] (data-help).
// Setup Scanner-карточка снята 2026-06-26 → справочник пуст, механика жива.
const HELP_CONTENT = {};

function renderHelpSection(s) {
  let html = `<div class="help-section">`;
  html += `<div class="help-section-title">${s.title}</div>`;
  if (s.sub) html += `<div class="help-section-sub">${s.sub}</div>`;
  if (Array.isArray(s.rows) && s.rows.length) {
    html += `<table class="help-table"><tbody>`;
    for (const r of s.rows) {
      html += `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  return html;
}

function openHelpModal(key) {
  const content = HELP_CONTENT[key];
  const modal = document.getElementById("help-modal");
  const body = document.getElementById("help-modal-body");
  if (!content || !modal || !body) return;
  body.innerHTML =
    dialog.head({ glyph: "help", title: content.title, sub: content.lead || "" }) +
    `<div class="modal__body">${content.sections.map(renderHelpSection).join("")}</div>`;
  dialog.open(modal);
}

// ── Trade detail modal ─────────────────────────────────────────────────
function openTradeModal(html) {
  const modal = document.getElementById("trade-modal");
  const body = document.getElementById("trade-modal-body");
  if (!modal || !body) return;
  body.innerHTML = html;
  dialog.open(modal);
}

function tmHeader({ coin, side, kindLabel, strat, isManual, when }) {
  const sideClass = side === "LONG" ? "long" : side === "SHORT" ? "short" : "";
  const sideChip = side
    ? `<span class="tm-side-chip ${sideClass}">${icon(side === "LONG" ? "long" : "short")} ${side}</span>`
    : "";
  // strategyDisplayName('manual') уже отдаёт значок ладони — не дублируем.
  const stratText =
    isManual && !/manual/i.test(strat)
      ? `${strat} · ${icon("manual")} Manual`
      : strat;
  // Шапка та же по устройству, что и dialog.head(): слева опознавательный
  // знак, в середине заголовок с подзаголовком, справа крестик на том же
  // месте. Только вместо кружка с иконкой — тикер монеты: в диалоге про
  // сделку опознаёт именно он.
  return `
    <div class="tm-header">
      <div class="tm-coin-badge">${coin.slice(0, 4)}</div>
      <div class="tm-header-text">
        <div class="tm-title">${kindLabel} #${coin} ${sideChip}</div>
        <div class="tm-sub">${stratText} · ${when}</div>
      </div>
      <button type="button" class="modal__close" data-close="1" aria-label="Close">
        ${icon("close")}
      </button>
    </div>
  `;
}

function tmPnlHero(pnl) {
  const cls = pnl >= 0 ? "positive" : "negative";
  const sign = pnl >= 0 ? "+" : "−";
  return `
    <div class="tm-pnl-hero">
      <div class="tm-pnl-hero-label">Realized PnL</div>
      <div class="tm-pnl-hero-value ${cls}">${sign}$${Math.abs(pnl).toFixed(4)}</div>
    </div>
  `;
}

function tradeModalHtmlFromActivity(e) {
  const kindLabel = e.kind === "open" ? "OPEN" : "CLOSE";
  const isManual = e.kind === "manual_close" || e.strategy_id === "manual";
  const strat = strategyDisplayName(e.strategy_id);
  const pnl = e.pnl || 0;
  const when = new Date(e.ts).toLocaleString();
  const side = e.side ? e.side.toUpperCase() : null;

  const cells = [];
  if (e.entryPrice != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(e.entryPrice)}</div></div>`,
    );
  if (e.closePrice != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(e.closePrice)}</div></div>`,
    );
  if (e.sizeUsd != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${e.sizeUsd.toFixed(2)}</div></div>`,
    );
  if (e.reason)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Reason</div><div class="tm-cell-value">${e.reason}</div></div>`,
    );

  return `
    ${tmHeader({ coin: e.coin, side, kindLabel, strat, isManual, when })}
    ${e.kind !== "open" ? tmPnlHero(pnl) : ""}
    ${cells.length ? `<div class="tm-grid">${cells.join("")}</div>` : ""}
    ${e.id ? `<div class="tm-section" id="tm-detail-slot"><div class="tm-section-title">Details</div><div class="tm-sub">Loading…</div></div>` : ""}
  `;
}

function tradeDetailHtml(t) {
  if (!t) return '<div class="tm-sub">No details available</div>';
  const strat = strategyDisplayName(t.strategy_id);
  const direction = (t.side || t.direction || "long").toUpperCase();
  const entryPx = t.entry_price;
  const closePx = t.close_price;
  const pnl = t.realized_pnl || 0;
  const fee = t.fee_paid || 0;
  const grossPnl = pnl + fee;
  const holdMs =
    t.closed_at && t.entry_time ? t.closed_at - t.entry_time : null;
  const holdStr =
    holdMs == null
      ? "—"
      : holdMs < 60_000
        ? `${Math.round(holdMs / 1000)}s`
        : holdMs < 3600_000
          ? `${Math.round(holdMs / 60_000)}m`
          : `${(holdMs / 3600_000).toFixed(1)}h`;
  const sl = t.sl_price;
  const tp = t.tp_price;
  const opened = t.entry_time ? new Date(t.entry_time).toLocaleString() : "—";
  const closed = t.closed_at ? new Date(t.closed_at).toLocaleString() : "—";
  const isManual = t.strategy_id === "manual";

  const cells = [
    `<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(entryPx)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(closePx)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${(t.size_usd || 0).toFixed(2)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Hold</div><div class="tm-cell-value">${holdStr}</div></div>`,
  ];
  if (sl != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Stop Loss</div><div class="tm-cell-value">$${fmtPx(sl)}</div></div>`,
    );
  if (tp != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Take Profit</div><div class="tm-cell-value">$${fmtPx(tp)}</div></div>`,
    );
  cells.push(
    `<div class="tm-cell"><div class="tm-cell-label">Gross PnL</div><div class="tm-cell-value ${grossPnl >= 0 ? "positive" : "negative"}">${grossPnl >= 0 ? "+" : "−"}$${Math.abs(grossPnl).toFixed(4)}</div></div>`,
  );
  cells.push(
    `<div class="tm-cell"><div class="tm-cell-label">Fees</div><div class="tm-cell-value muted">−$${Math.abs(fee).toFixed(4)}</div></div>`,
  );
  if (t.reason)
    cells.push(
      `<div class="tm-cell full"><div class="tm-cell-label">Close reason</div><div class="tm-cell-value">${t.reason}</div></div>`,
    );

  return `
    ${tmHeader({ coin: t.coin, side: direction, kindLabel: "TRADE", strat, isManual, when: `id ${t.id}` })}
    ${tmPnlHero(pnl)}
    <div class="tm-grid">${cells.join("")}</div>
    <div class="tm-section">
      <div class="tm-section-title">Timeline</div>
      <div class="tm-grid">
        <div class="tm-cell"><div class="tm-cell-label">Opened</div><div class="tm-cell-value muted">${opened}</div></div>
        <div class="tm-cell"><div class="tm-cell-label">Closed</div><div class="tm-cell-value muted">${closed}</div></div>
      </div>
    </div>
  `;
}

function fmtPx(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7;
  return v.toFixed(digits);
}

async function onActivityClick(e) {
  const row = e.target.closest("[data-activity-idx]");
  if (!row) return;
  const idx = parseInt(row.getAttribute("data-activity-idx"), 10);
  const evt = lastActivityEvents[idx];
  if (!evt) return;
  openTradeModal(tradeModalHtmlFromActivity(evt));
  if (evt.id) {
    try {
      const r = await fetchJson(`/api/trade/${evt.id}`);
      const slot = document.getElementById("tm-detail-slot");
      if (slot && r?.trade)
        slot.outerHTML = `<div class="tm-section">${tradeDetailHtml(r.trade)}</div>`;
    } catch (err) {
      const slot = document.getElementById("tm-detail-slot");
      if (slot)
        slot.innerHTML =
          '<div class="tm-sub">Could not load details</div>';
    }
  }
}

// Закрытие (крестик, подложка, Escape, замок прокрутки, возврат фокуса) —
// в core/dialog.js. Здесь остаётся только ОТКРЫТИЕ: что за чем показывать.
export function initModals() {
  ["trade-modal", "help-modal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) dialog.bindClose(el);
  });
  document.addEventListener("click", (e) => {
    const helpBtn = e.target.closest(".help-btn[data-help]");
    if (helpBtn) {
      openHelpModal(helpBtn.dataset.help);
      return;
    }
    if (e.target.closest("#activity-container")) onActivityClick(e);
  });
}
