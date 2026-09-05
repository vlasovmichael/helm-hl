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

const signed = (v, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;

const toneOf = (v) => (v == null ? "" : v >= 0 ? "num-pos" : "num-neg");

/**
 * Интервальная шкала вокруг нуля: полоса от lo до hi, точка на среднем.
 * Пока полоса пересекает ноль, это видно раньше, чем читается число — ради
 * этого она и стоит, а не ради украшения.
 */
function ciTrack(st) {
  if (!st || st.lo == null) return `<div class="cmp-track cmp-track--empty"></div>`;
  // Шкала симметрична: половина ширины на каждую сторону от нуля, предел —
  // самый дальний конец интервала. Так ноль всегда ровно посередине.
  const span = Math.max(Math.abs(st.lo), Math.abs(st.hi)) * 1.15 || 1;
  const pos = (v) => 50 + (v / span) * 50;
  const left = Math.min(pos(st.lo), pos(st.hi));
  const width = Math.abs(pos(st.hi) - pos(st.lo));
  const crossesZero = st.lo <= 0 && st.hi >= 0;
  return `
    <div class="cmp-track" data-card="95% confidence interval for the mean; the line marks zero">
      <div class="cmp-track__zero"></div>
      <div class="cmp-track__band${crossesZero ? " is-flat" : st.mean >= 0 ? " is-pos" : " is-neg"}"
           style="left:${left.toFixed(2)}%;width:${Math.max(width, 1.5).toFixed(2)}%"></div>
      <div class="cmp-track__dot" style="left:${pos(st.mean).toFixed(2)}%"></div>
    </div>`;
}

/** Одна колонка сравнения. */
function lane({ title, sub, st, hero, heroNote, foot, muted = false, track = true }) {
  const n = st?.n || 0;
  return `
    <div class="cmp-lane${muted ? " cmp-lane--claim" : ""}">
      <div class="cmp-lane__head">
        <span class="cmp-lane__title">${title}</span>
        <span class="cmp-lane__sub">${sub}</span>
      </div>
      <div class="cmp-lane__hero ${muted ? "" : toneOf(st?.mean)}">${hero}</div>
      <div class="cmp-lane__heronote">${heroNote}</div>
      ${track ? ciTrack(st) : `<div class="cmp-track cmp-track--note">not on the same scale</div>`}
      <dl class="cmp-lane__facts">
        <div><dt>Trades</dt><dd>${n || "—"}</dd></div>
        <div><dt>Win rate</dt><dd>${n ? `${st.winRate.toFixed(0)}%` : "—"}</dd></div>
        <div><dt>Median</dt><dd>${n ? signed(st.median) : "—"}</dd></div>
        <div><dt>Best · worst</dt><dd>${n ? `${signed(st.best, 1)} · ${signed(st.worst, 1)}` : "—"}</dd></div>
      </dl>
      <div class="cmp-lane__foot">${foot}</div>
    </div>`;
}

/**
 * Две колонки: что звонки канала сделали у нас и что канал публикует о себе.
 * Общей шкалы у них нет намеренно — проценты справа плечевые и посчитаны самим
 * каналом. Свои бумажные сделки сюда не попадают: другой источник входа.
 */
function comparisonHtml(c) {
  const theirs = c?.theirs || { n: 0 };
  const claimed = c?.claimed || { n: 0 };

  const lanes =
    lane({
      title: "What the calls did",
      sub: "taken at 1&times;, exited by the bot",
      st: theirs,
      hero: theirs.n ? signed(theirs.mean) : "—",
      heroNote: "mean per trade, net, 1&times;",
      foot: verdict(theirs).text,
    }) +
    lane({
      title: "What they post",
      sub: "the channels' own numbers",
      st: claimed,
      muted: true,
      track: false,
      hero: claimed.n ? signed(claimed.mean, 1) : "—",
      heroNote: "mean per claim, leveraged",
      foot: claimed.withLeverage
        ? `${claimed.withLeverage} state their leverage &rarr; ${signed(claimed.at1x.mean)} at 1&times;`
        : "leverage not stated on these posts",
    });

  return `<div class="cmp-grid cmp-grid--pair">${lanes}</div>${punchline(theirs, claimed)}`;
}

/**
 * Разрыв между витриной и фактом одной фразой. Пишется только когда обе стороны
 * посчитаны: без сделок это было бы обвинение без замера.
 */
function punchline(theirs, claimed) {
  if (!theirs.n || !claimed.n) return "";
  const at1x = claimed.at1x?.n ? claimed.at1x : null;
  return `
    <p class="cmp-punch">
      The channels post <b>${signed(claimed.mean, 1)}</b> per call across
      <b>${claimed.n}</b> results and call <b>${claimed.winRate.toFixed(0)}%</b> of them wins.
      ${at1x ? `Where they state the leverage, that is <b>${signed(at1x.mean)}</b> on unlevered size. ` : ""}
      The same calls, taken at 1&times; the moment they were posted and exited by the bot,
      did <b class="${toneOf(theirs.mean)}">${signed(theirs.mean)}</b> per trade
      over <b>${theirs.n}</b> trades.
    </p>`;
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
  const cmp = data?.comparison || null;
  const traded = cmp?.theirs?.n || 0;

  if (meta) {
    meta.textContent = data?.enabled
      ? `${traded} closed · ${(data.positions || []).length} open`
      : "watcher off";
    meta.style.color = data?.enabled ? "var(--text-muted)" : "var(--red)";
  }

  const head =
    comparisonHtml(cmp) +
    `<p class="tg-lab-note">
      Left is our measurement of the channels' own calls: net return per trade as a share of its
      own notional, entered at the market price the moment the post is seen and exited by the bot.
      Right is not our measurement at all — it is what those channels publish about themselves, on
      their own leverage and their own accounting, so the two share no axis. Your own paper trades
      are deliberately absent: different entries, closed by hand, not comparable to either.
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
