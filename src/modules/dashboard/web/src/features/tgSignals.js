// ─────────────────────────────────────────────────
//  Signal positions — форвард по чужим прогнозам
// ─────────────────────────────────────────────────
// Две поверхности из одной ручки /api/tg-signals: таблица открытых поз на
// главной и журнал с итогом в лаборатории.
//
// 🚨 Вердикт читает доверительный интервал, а не среднее.

import { escapeHtml, fmtUsd, fmtPct, fmtPrice, fmtSince } from "../utils/format.js";
import { fetchJson } from "../net/api.js";
import { icon } from "../core/icon.js";
import { button, badge } from "../core/ui.js";
import { emptyRow, emptyState, skeletonRows, settle } from "../core/placeholders.js";
import * as dialog from "../core/dialog.js";

const POLL_MS = 15_000;
let listTimer = null;
let confirmResolve = null;

// ── Открытые позы (главная) ─────────────────────────────────────────────────

function rowHtml(p) {
  const isShort = p.side === "SHORT";
  const arrow = icon(isShort ? "short" : "long");
  const pnl = p.unrealized;
  const pnlCls = pnl == null ? "" : pnl >= 0 ? "num-pos" : "num-neg";
  // Под uPnL — стоп и цель: то же, что нянька держала бы ордерами.
  const plan = [
    p.stopPrice != null ? `SL ${fmtPrice(p.stopPrice)}` : "",
    p.targetPrice != null ? `TP ${fmtPrice(p.targetPrice)}` : "",
  ].filter(Boolean).join(" · ");

  return `
    <tr>
      <td><span class="signals-price">#${escapeHtml(p.coin)}</span></td>
      <td class="center ${isShort ? "num-neg" : "num-pos"}"><strong>${arrow} ${escapeHtml(p.side)}</strong></td>
      <td class="num">${p.leverage}&times;</td>
      <td class="num">${fmtUsd(p.sizeUsd)}</td>
      <td class="num">${fmtPrice(p.entryPrice)}</td>
      <td class="num">${fmtPrice(p.markPrice)}</td>
      <td class="num ${pnlCls}"><strong>${pnl == null ? "—" : fmtUsd(pnl)}</strong>${
        p.roePct == null ? "" : `<span class="tg-roe">${fmtPct(p.roePct)}</span>`
      }${plan ? `<span class="tg-sub">${plan}</span>` : ""}</td>
      <td class="num tg-age">${fmtSince(p.entryTime)}</td>
      <td class="center">${button({
        label: "Close",
        size: "sm",
        cls: "tg-close-btn",
        attrs: {
          "data-tg-close-id": p.id,
          "data-tg-coin": p.coin,
          "data-tg-side": p.side,
          "data-tg-size": p.sizeUsd,
          "data-tg-entry": p.entryPrice,
          "data-tg-mark": p.markPrice ?? "",
          "data-tg-pnl": pnl ?? "",
        },
      })}</td>
    </tr>`;
}

const COLS = 9;

function tableHtml(data) {
  const positions = data.positions || [];
  const src = (data.channels || []).length
    ? `${data.channels.length} channel${data.channels.length > 1 ? "s" : ""}`
    : "no channels";
  const meta = data.enabled
    ? `${src} · ${fmtUsd(data.sizeUsd)} at ${data.leverage}&times; · ${icon("bot")} bot manages exit`
    : "watcher off";

  const body = positions.length
    ? positions.map(rowHtml).join("")
    : emptyRow(COLS, {
        glyph: "clock",
        title: "No signal positions open",
        hint: data.enabled
          ? "A paper position opens by itself the next time a followed channel posts a call."
          : "Set TG_SIGNAL_ENABLED=true to start the forward test.",
      });

  return `
    <div class="tg-active">
      <div class="tg-active-head">
        <span>Signal positions &middot; paper</span>
        <span class="tg-active-meta">${meta}</span>
      </div>
      <div class="u-scroll-x">
        <table class="table table--compact tg-active-table">
          <thead>
            <tr>
              <th>Coin</th><th class="center">Side</th><th class="num">Lev</th>
              <th class="num">Size</th><th class="num">Entry</th><th class="num">Price</th>
              <th class="num" data-card="Unrealized P&amp;L (net) + ROE on margin">uPnL</th>
              <th class="num">Age</th><th class="center"></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

async function refreshActive() {
  const container = document.getElementById("tg-active-container");
  if (!container) return; // не на этой странице
  try {
    const data = await fetchJson("/api/tg-signals");
    // Вотчер выключен и поз нет — блок не мозолит глаза.
    if (!data?.enabled && !(data?.positions || []).length) {
      container.innerHTML = "";
      return;
    }
    settle(container, tableHtml(data));
  } catch {
    /* fail-soft — блок не критичен */
  }
}

// ── Подтверждение закрытия ──────────────────────────────────────────────────

function settleConfirm(ok) {
  const modal = document.getElementById("tg-confirm");
  if (!modal || modal.hidden) return;
  if (!ok) dialog.close(modal);
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(ok);
}

function ensureConfirm() {
  const modal = dialog.shell("tg-confirm");
  if (modal.dataset.tgBound) return modal;
  modal.dataset.tgBound = "1";
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-tg-cancel]")) settleConfirm(false);
    if (e.target.closest("[data-tg-confirm]")) settleConfirm(true);
  });
  // 🚨 Escape обязан разрешить промис, иначе вызывающий код ждёт ответа вечно.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) settleConfirm(false);
  });
  return modal;
}

function confirmClose(info, errMsg) {
  ensureConfirm();
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const pnl = num(info.pnl);
  const isShort = info.side === "SHORT";
  const cell = (label, value, cls = "") =>
    `<div class="tg-confirm-cell"><span class="tg-confirm-cell-label">${label}</span>` +
    `<span class="tg-confirm-cell-value ${cls}">${value}</span></div>`;

  dialog.show({
    id: "tg-confirm",
    tone: "danger",
    glyph: "warn",
    title: `Close #${escapeHtml(info.coin || "")}?`,
    sub: "Closing by hand ends this call early",
    body: `
      <div class="tg-lead">The bot is still managing this exit. Closing now records the result at the current
      mark price and removes the call from the forward test's natural lifetime.</div>
      <div class="tg-confirm-grid">
        ${cell("Side", `${icon(isShort ? "short" : "long")} ${escapeHtml(info.side || "—")}`, isShort ? "num-neg" : "num-pos")}
        ${cell("Size", num(info.size) == null ? "—" : fmtUsd(num(info.size)))}
        ${cell("Entry", fmtPrice(num(info.entry)))}
        ${cell("Mark", fmtPrice(num(info.mark)))}
        ${cell("uPnL", pnl == null ? "—" : fmtUsd(pnl), pnl == null ? "" : pnl >= 0 ? "num-pos" : "num-neg")}
      </div>
      <div class="tg-err"${errMsg ? "" : " hidden"}>${escapeHtml(errMsg || "")}</div>`,
    actions:
      button({ label: "Keep it", variant: "ghost", attrs: { "data-tg-cancel": true } }) +
      button({
        label: errMsg ? "Retry close" : "Close position",
        variant: "danger",
        attrs: { "data-tg-confirm": true, "data-autofocus": true },
      }),
  });
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function setConfirmBusy(busy) {
  const btn = document.querySelector("#tg-confirm [data-tg-confirm]");
  const cancel = document.querySelector("#tg-confirm [data-tg-cancel]");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "Closing…" : "Close position";
  }
  if (cancel) cancel.disabled = busy;
}

async function onCloseClick(e) {
  const btn = e.target.closest("[data-tg-close-id]");
  if (!btn) return;
  const id = Number(btn.dataset.tgCloseId);
  if (!Number.isFinite(id)) return;
  const d = btn.dataset;
  const info = { coin: d.tgCoin, side: d.tgSide, size: d.tgSize, entry: d.tgEntry, mark: d.tgMark, pnl: d.tgPnl };

  let err = "";
  // Ошибку показываем в том же диалоге и даём повторить, не гоняя через alert.
  for (;;) {
    const ok = await confirmClose(info, err);
    if (!ok) return;
    setConfirmBusy(true);
    try {
      const r = await fetch("/api/tg-signals/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (r.status === 401) { window.location.href = "/login"; return; }
      const res = await r.json();
      if (res?.ok) {
        dialog.close(dialog.shell("tg-confirm"));
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

/** Таблица сигнальных поз на главной: рендер + Close + поллинг. */
export function initTgSignalPositions() {
  const container = document.getElementById("tg-active-container");
  if (!container || container.dataset.bound) return;
  container.dataset.bound = "1";
  container.addEventListener("click", onCloseClick);
  refreshActive();
  if (listTimer) clearInterval(listTimer);
  listTimer = setInterval(() => {
    if (!document.hidden) refreshActive();
  }, POLL_MS);
}

// ── Витрина форварда (лаборатория) ──────────────────────────────────────────

/** Вердикт по интервалу: пока он накрывает ноль, показывать нечего. */
function verdict(stats) {
  if (!stats || stats.lo == null) return { tone: "", text: "too few trades to say anything" };
  if (stats.lo > 0) return { tone: "num-pos", text: "above zero at 95% confidence" };
  if (stats.hi < 0) return { tone: "num-neg", text: "below zero at 95% confidence" };
  return { tone: "", text: "not distinguishable from zero yet" };
}

function journalRow(s) {
  const isShort = s.side === "SHORT";
  const opened = s.status === "opened";
  return `
    <tr class="${opened ? "" : "tg-j-skipped"}">
      <td class="tg-j-time">${new Date(s.postedAt).toISOString().slice(5, 16).replace("T", " ")}</td>
      <td class="tg-j-chan">${escapeHtml(s.channel)}</td>
      <td><span class="signals-price">#${escapeHtml(s.coin)}</span></td>
      <td class="center ${isShort ? "num-neg" : "num-pos"}">${icon(isShort ? "short" : "long")} ${escapeHtml(s.side)}</td>
      <td>${opened
        ? badge({ label: "traded", tone: "accent" })
        : badge({ label: "skipped", title: s.skipReason || "" })}</td>
      <td class="tg-j-why">${escapeHtml(opened ? "" : s.skipReason || "")}</td>
    </tr>`;
}

export async function refreshTgSignalLab() {
  const body = document.getElementById("tg-lab-body");
  const meta = document.getElementById("tg-lab-meta");
  if (!body) return;

  let data;
  try {
    data = await fetchJson("/api/tg-signals");
  } catch {
    body.innerHTML = emptyState({
      glyph: "danger",
      title: "Dashboard is not answering",
      hint: "The signal forward could not be read. Reload the page to try again.",
    });
    return;
  }

  const journal = data?.journal || [];
  const stats = data?.stats || null;
  const v = verdict(stats);

  if (meta) {
    meta.textContent = data?.enabled
      ? `${data.closedCount || 0} closed · ${(data.positions || []).length} open`
      : "watcher off";
    meta.style.color = data?.enabled ? "var(--text-muted)" : "var(--red)";
  }

  const head = `
    <div class="tg-lab-summary">
      <div class="tg-lab-stat">
        <span class="tg-lab-stat-label">Closed calls</span>
        <b>${data?.closedCount || 0}</b>
      </div>
      <div class="tg-lab-stat">
        <span class="tg-lab-stat-label">Mean per call</span>
        <b class="${v.tone}">${stats ? fmtPct(stats.mean) : "—"}</b>
      </div>
      <div class="tg-lab-stat">
        <span class="tg-lab-stat-label">95% interval</span>
        <b>${stats && stats.lo != null ? `${fmtPct(stats.lo)} … ${fmtPct(stats.hi)}` : "—"}</b>
      </div>
      <div class="tg-lab-stat tg-lab-stat--wide">
        <span class="tg-lab-stat-label">Verdict</span>
        <b class="${v.tone}">${v.text}</b>
      </div>
    </div>
    <p class="tg-lab-note">
      Result is the net return per call as a share of its own notional, so the tiny fixed size and 1&times;
      leverage cannot flatter it. Only the coin, the side and the post's timestamp come from the channel —
      entry is taken at the market price when the post is seen, and the exit is run by the same nanny that
      manages real positions. Channel entries, targets and stops are ignored on purpose.
    </p>`;

  const table = journal.length
    ? `<div class="u-scroll-x"><table class="table table--compact tg-j-table">
         <thead><tr>
           <th>Posted</th><th>Channel</th><th>Coin</th><th class="center">Side</th><th>Status</th><th>Why not</th>
         </tr></thead>
         <tbody>${journal.map(journalRow).join("")}</tbody>
       </table></div>`
    : emptyState({
        glyph: "clock",
        title: "No calls logged yet",
        hint: "Every parsed post lands here — the traded ones and the skipped ones with their reason.",
      });

  settle(body, head + table);
}

/** Скелетон на месте витрины до первого ответа. */
export function mountTgSignalLabSkeleton() {
  const body = document.getElementById("tg-lab-body");
  if (body) body.innerHTML = `<table class="table table--compact"><tbody>${skeletonRows(6, 4)}</tbody></table>`;
}
