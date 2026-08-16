// ─────────────────────────────────────────────────
//  Trade Ticket — модалка «открыть / закрыть позицию» в стиле Rabby
// ─────────────────────────────────────────────────
// Зачем эта штука (важно, иначе через месяц соблазн «дополнить»):
//
// Замер комиссий 11.08.2026: сторонний фронтенд вшивает в ордер builder-fee
// 2 бп (+46% к ставке). Ордера через SDK — не вшивают: 374 бот-филла прошли по
// 4.32 бп при $0.00 надбавки. Сайт биржи надбавку тоже не берёт, но пользоваться
// им неудобно, а Rabby всплывает на каждый клик. Панель закрывает ровно этот
// разрыв: тариф биржи, интерфейс — свой.
//
// 🔒 ГРАНИЦА ОТВЕТСТВЕННОСТИ (решено 16.08.2026, не размывать):
// Модалка ТОЛЬКО кладёт ордер на биржу. Она НЕ пишет в БД, НЕ ставит стопы и НЕ
// ведёт позицию. Сопровождение остаётся у няньки (adopt): она видит новую
// ручную позу так же, как при входе с сайта биржи, и через ~15 секунд вешает
// свой ATR-стоп. Поэтому строка «Стоп-лосс» здесь показывающая, а не вводимая —
// второй стоп на ту же позу породил бы ровно тот класс рассинхрона
// «зеркало ≠ биржа», где уже собрано 8 фиксов за 6 недель.
//
// Модель размера взята у Rabby, потому что она привычна: двигаешь МАРЖУ и
// ПЛЕЧО, нотионал считается сам (size = margin × leverage). Не наоборот.
//
// Модуль чист от сети: всё наружу идёт через инжектируемый `io`. Это позволяет
// гонять его локально на моках (ticket.html), не касаясь биржи.

import { escapeHtml, fmtUsd, fmtPrice } from "../utils/format.js";

// Биржевой минимум ордера на HL. Меньше — отказ, поэтому это блокер, а не
// предупреждение (Rabby показывает ровно его же красным).
const MIN_ORDER_USD = 10;

// Практический потолок плеча на этом кошельке. Депо ~$10-15: выше 10x
// ликвидация приходит раньше, чем стоп няньки (−7% ATR).
const MAX_LEVERAGE = 10;

// ── Чистая математика (экспортируется — на неё есть тесты) ──────────────────

/** Нотионал позиции: маржа × плечо. */
export function notionalUsd(marginUsd, leverage) {
  const m = Number(marginUsd);
  const l = Number(leverage);
  if (!(m > 0) || !(l > 0)) return 0;
  return m * l;
}

/** Размер в монетах при данной цене. null если цены нет. */
export function sizeInCoins(notional, price) {
  const p = Number(price);
  if (!(notional > 0) || !(p > 0)) return null;
  return notional / p;
}

/** Цена, от которой считается вход: лимитка либо рынок. */
export function effectiveEntry({ orderType, limitPx, price }) {
  if (orderType === "limit") {
    const n = Number(limitPx);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Где встанет стоп няньки, если войти сейчас. Не наш стоп — прогноз чужого
 * поведения, чтобы вход не был вслепую. stopDistPct приходит с бэкенда
 * (computeStopDistPct — тот же ATR, что реально применит adopt).
 */
export function projectedBotStop({ side, entry, stopDistPct }) {
  const d = Number(stopDistPct);
  if (!(entry > 0) || !Number.isFinite(d) || d <= 0) return null;
  return side === "short" ? entry * (1 + d / 100) : entry * (1 - d / 100);
}

/** Сколько отдашь, если стоп няньки сработает (от нотионала, не от маржи). */
export function stopRiskUsd({ notional, stopDistPct }) {
  const d = Number(stopDistPct);
  if (!(notional > 0) || !Number.isFinite(d) || d <= 0) return null;
  return (notional * d) / 100;
}

/** Валидация открытия. { ok, blockers[], warnings[], entry, notional } */
export function validateOpen(s, ctx) {
  const blockers = [];
  const warnings = [];
  const entry = effectiveEntry({ orderType: s.orderType, limitPx: s.limitPx, price: ctx?.price });
  const notional = notionalUsd(s.marginUsd, s.leverage);
  const isShort = s.side === "short";

  if (!String(s.coin || "").trim()) blockers.push("pick a coin");
  if (!(Number(s.marginUsd) > 0)) blockers.push("margin not set");
  else if (Number(s.marginUsd) > (ctx?.available ?? 0) + 1e-9) blockers.push("margin exceeds available");

  if (notional > 0 && notional < MIN_ORDER_USD) {
    blockers.push(`the minimum order size is $${MIN_ORDER_USD}`);
  }

  if (s.orderType === "limit") {
    if (!(Number(s.limitPx) > 0)) blockers.push("limit price not set");
    else if (ctx?.price > 0) {
      const px = Number(s.limitPx);
      // Post-only, которая пересекает рынок, отклоняется биржей молча.
      const wouldCross = isShort ? px < ctx.price : px > ctx.price;
      if (wouldCross) blockers.push("post-only would cross the book — exchange will reject it");
    }
  }

  if (ctx?.day?.halted) blockers.push("daily stop hit — entries locked until midnight");

  if (ctx?.adoptEnabled === false) warnings.push("bot sitter is off — nobody will place a stop");
  if (ctx?.hasPosition) warnings.push(`${s.coin} position already open — this adds to it`);

  return { ok: blockers.length === 0, blockers, warnings, entry, notional };
}

/**
 * Валидация закрытия. Выход намеренно почти не гейтится: дневной стоп на него
 * НЕ распространяется — запирать себе выход опасно.
 */
export function validateClose(s, position, ctx) {
  const blockers = [];
  if (!position) blockers.push("no open position");
  const pct = Number(s.pct);
  if (!(pct > 0) || pct > 100) blockers.push("close share must be 1–100%");
  if (s.orderType === "limit") {
    const px = Number(s.limitPx);
    if (!(px > 0)) blockers.push("limit price not set");
    else if (ctx?.price > 0 && position) {
      const isBuy = position.side === "short"; // закрытие шорта = BUY
      const wouldCross = isBuy ? px > ctx.price : px < ctx.price;
      if (wouldCross) blockers.push("post-only would cross the book — exchange will reject it");
    }
  }
  return { ok: blockers.length === 0, blockers, warnings: [] };
}

// ── Хелперы рендера ─────────────────────────────────────────────────────────

function fmtSigned(n) {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
}

function coinAmount(n) {
  if (n == null) return "—";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

function listBlock(cls, items) {
  return `<ul class="${cls}" ${items.length ? "" : "hidden"}>${items
    .map((x) => `<li>${escapeHtml(x)}</li>`)
    .join("")}</ul>`;
}

/** Слайдер с залитой левой частью — залив рисуем градиентом по значению. */
function slider(name, value, min, max, step) {
  const pct = max > min ? ((Number(value) - min) / (max - min)) * 100 : 0;
  return `<input class="tt-slider" data-slider="${name}" type="range"
    min="${min}" max="${max}" step="${step}" value="${value}"
    style="--fill:${Math.max(0, Math.min(100, pct)).toFixed(2)}%">`;
}

// ─────────────────────────────────────────────────
//  Модалка
// ─────────────────────────────────────────────────

function createModal(io) {
  const state = {
    view: "open", // 'open' | 'close'
    coin: "",
    side: "short",
    marginUsd: 0,
    leverage: 3,
    orderType: "market",
    limitPx: "",
    pct: 100,
    submitting: false,
    error: null,
    result: null,
  };
  let ctx = { price: null, available: 0, maxLeverage: MAX_LEVERAGE, day: {}, adoptEnabled: true, positions: [] };
  let el = null;
  let bodyEl = null;

  // ── Каркас модалки (создаётся один раз) ──
  function ensureDom() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "trade-modal tt-modal";
    el.hidden = true;
    el.innerHTML = `
      <div class="trade-modal__backdrop" data-tt-close></div>
      <div class="trade-modal__panel tt-panel" role="dialog" aria-modal="true" aria-label="Position">
        <button class="trade-modal__close" type="button" data-tt-close aria-label="Close">×</button>
        <div class="tt-panel__body"></div>
      </div>`;
    document.body.appendChild(el);
    bodyEl = el.querySelector(".tt-panel__body");
    el.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-tt-close")) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.hidden) close();
    });
    return el;
  }

  // ── Вид «Открыть» ──
  function renderOpen() {
    const v = validateOpen(state, ctx);
    const isShort = state.side === "short";
    const notional = v.notional;
    const coins = sizeInCoins(notional, v.entry ?? ctx.price);
    const botStop = projectedBotStop({ side: state.side, entry: v.entry, stopDistPct: ctx.stopDistPct });
    const risk = stopRiskUsd({ notional, stopDistPct: ctx.stopDistPct });
    const maxLev = Math.min(MAX_LEVERAGE, ctx.maxLeverage || MAX_LEVERAGE);
    const available = Number(ctx.available) || 0;
    const tooSmall = notional > 0 && notional < MIN_ORDER_USD;

    return `
      <h2 class="tt-panel__title">Open ${escapeHtml(state.coin || "")} Position</h2>

      <div class="tt-seg tt-seg--side">
        <button type="button" class="tt-seg__btn ${!isShort ? "is-on is-long" : ""}" data-side="long">Long</button>
        <button type="button" class="tt-seg__btn ${isShort ? "is-on is-short" : ""}" data-side="short">Short</button>
      </div>

      ${!state.coin
        ? `<div class="tt-card">
             <div class="tt-card__label">Coin</div>
             <input class="tt-coin-input" data-f="coin" type="text" placeholder="CHIP"
                    autocomplete="off" spellcheck="false" value="${escapeHtml(state.coin)}">
           </div>`
        : ""}

      <div class="tt-card">
        <div class="tt-card__head">
          <span class="tt-card__label tt-card__label--accent">Margin <i>(USDC)</i></span>
          <span class="tt-chip">Isolated</span>
        </div>
        <div class="tt-card__row">
          <div class="tt-card__minor">
            <b>${available.toFixed(2)}</b>
            <span>available</span>
          </div>
          <div class="tt-card__major ${tooSmall ? "is-bad" : ""}" data-margin>${Number(state.marginUsd).toFixed(2)}</div>
        </div>
        ${tooSmall ? `<div class="tt-card__err">The minimum order size is $${MIN_ORDER_USD}</div>` : ""}
        ${slider("margin", state.marginUsd, 0, Math.max(available, 0.01), 0.01)}
      </div>

      <div class="tt-card">
        <div class="tt-card__row">
          <div class="tt-card__minor">
            <b class="tt-card__label--accent">Leverage</b>
            <span>up to ${maxLev}x</span>
          </div>
          <div class="tt-card__major" data-lev>${state.leverage}<i>x</i></div>
        </div>
        ${slider("leverage", state.leverage, 1, maxLev, 1)}
      </div>

      <div class="tt-rows">
        <div class="tt-row">
          <span>Current Price</span>
          <b>${ctx.price > 0 ? escapeHtml(fmtPrice(ctx.price)) : "—"}</b>
        </div>
        <div class="tt-row">
          <span>Order Type</span>
          <button type="button" class="tt-row__toggle" data-toggle-type>
            ${state.orderType === "limit" ? "Limit post-only" : "Market"} <i>⇄</i>
          </button>
        </div>
        ${state.orderType === "limit"
          ? `<div class="tt-row tt-row--input">
               <span>Limit Price</span>
               <input class="tt-row__input" data-f="limitPx" type="text" inputmode="decimal"
                      placeholder="${ctx.price > 0 ? fmtPrice(ctx.price) : "0.00"}" value="${escapeHtml(state.limitPx)}">
             </div>`
          : ""}
      </div>

      <div class="tt-rows">
        <div class="tt-row">
          <span>Size</span>
          <b data-size>${notional > 0 ? `${fmtUsd(notional)} = ${coinAmount(coins)} ${escapeHtml(state.coin || "")}` : "—"}</b>
        </div>
        <div class="tt-row ${ctx.adoptEnabled === false ? "tt-row--bad" : ""}">
          <span>Stop Loss <i class="tt-row__by">set by bot</i></span>
          <b>${
            ctx.adoptEnabled === false
              ? "nobody will set it"
              : botStop != null
                ? `${escapeHtml(fmtPrice(botStop))} <i class="tt-row__sub">−${Number(ctx.stopDistPct).toFixed(1)}% ATR</i>`
                : "by ATR after entry"
          }</b>
        </div>
        <div class="tt-row">
          <span>Risk at that stop</span>
          <b class="${risk != null ? "is-risk" : ""}">${risk != null ? `−${fmtUsd(risk)}` : "—"}</b>
        </div>
      </div>

      ${listBlock("tt-blockers", v.blockers)}
      ${listBlock("tt-warnings", v.warnings)}
      ${state.error ? `<div class="tt-alert tt-alert--err">${escapeHtml(state.error)}</div>` : ""}
      ${state.result ? `<div class="tt-alert tt-alert--ok">${escapeHtml(state.result)}</div>` : ""}

      <button type="button" class="tt-cta ${isShort ? "tt-cta--short" : "tt-cta--long"}"
              data-submit ${v.ok && !state.submitting ? "" : "disabled"}>
        ${state.submitting ? "Sending…" : `Open ${isShort ? "Short" : "Long"}`}
      </button>
      <div class="tt-foot">${
        state.orderType === "limit"
          ? "post-only · 1.44 bps · may not fill"
          : "taker · 4.32 bps · fills now"
      } · builder fee 0 bps</div>`;
  }

  // ── Вид «Закрыть» ──
  function renderClose() {
    const positions = ctx.positions || [];
    if (!positions.length) {
      return `
        <h2 class="tt-panel__title">Positions</h2>
        <div class="tt-empty">No open positions.<br><span>Everything actually sitting on the exchange shows up here — manual entries and bot entries alike.</span></div>`;
    }
    return `<h2 class="tt-panel__title">Positions</h2>${positions.map(closeCard).join("")}`;
  }

  function closeCard(p) {
    const isShort = p.side === "short";
    const v = validateClose(state, p, { price: p.markPrice });
    const busy = state.submitting && state.coin === p.coin;
    const closingUsd = (Number(p.sizeUsd) * Number(state.pct)) / 100;
    return `
      <div class="tt-pos">
        <div class="tt-pos__head">
          <span class="tt-pos__coin">${escapeHtml(p.coin)}</span>
          <span class="tt-pos__side tt-pos__side--${isShort ? "short" : "long"}">${isShort ? "Short" : "Long"}</span>
          <span class="tt-pos__pnl ${p.unrealized >= 0 ? "is-up" : "is-down"}">${fmtSigned(p.unrealized)}</span>
        </div>
        <div class="tt-rows tt-rows--tight">
          <div class="tt-row"><span>Entry</span><b>${escapeHtml(fmtPrice(p.entryPrice))}</b></div>
          <div class="tt-row"><span>Mark</span><b>${escapeHtml(fmtPrice(p.markPrice))}</b></div>
          <div class="tt-row"><span>Size</span><b>${fmtUsd(p.sizeUsd)}</b></div>
          <div class="tt-row ${p.stopPrice ? "" : "tt-row--bad"}">
            <span>Bot Stop</span>
            <b>${p.stopPrice ? escapeHtml(fmtPrice(p.stopPrice)) : "none — nobody is watching"}</b>
          </div>
        </div>

        <div class="tt-seg tt-seg--pct">
          ${[25, 50, 100]
            .map((n) => `<button type="button" class="tt-seg__btn ${Number(state.pct) === n ? "is-on" : ""}" data-pct="${n}">${n}%</button>`)
            .join("")}
        </div>

        <div class="tt-rows">
          <div class="tt-row">
            <span>Order Type</span>
            <button type="button" class="tt-row__toggle" data-toggle-type>
              ${state.orderType === "limit" ? "Limit post-only" : "Market"} <i>⇄</i>
            </button>
          </div>
          ${state.orderType === "limit"
            ? `<div class="tt-row tt-row--input">
                 <span>${isShort ? "Buyback Price" : "Sell Price"}</span>
                 <input class="tt-row__input" data-f="limitPx" type="text" inputmode="decimal"
                        placeholder="${fmtPrice(p.markPrice)}" value="${escapeHtml(state.limitPx)}">
               </div>`
            : ""}
          <div class="tt-row"><span>Closing</span><b>${fmtUsd(closingUsd)}</b></div>
        </div>

        ${listBlock("tt-blockers", v.blockers)}
        ${state.error ? `<div class="tt-alert tt-alert--err">${escapeHtml(state.error)}</div>` : ""}
        ${state.result ? `<div class="tt-alert tt-alert--ok">${escapeHtml(state.result)}</div>` : ""}

        <button type="button" class="tt-cta tt-cta--close" data-close="${escapeHtml(p.coin)}"
                ${v.ok && !busy ? "" : "disabled"}>
          ${busy ? "Closing…" : `Close ${state.pct}%`}
        </button>
      </div>`;
  }

  function render() {
    ensureDom();
    const positions = (ctx.positions || []).length;
    bodyEl.innerHTML = `
      <div class="tt-tabs">
        <button type="button" class="tt-tab ${state.view === "open" ? "is-on" : ""}" data-view="open">Open</button>
        <button type="button" class="tt-tab ${state.view === "close" ? "is-on" : ""}" data-view="close">
          Close${positions ? `<i class="tt-tab__n">${positions}</i>` : ""}
        </button>
      </div>
      <div class="tt-view">${state.view === "open" ? renderOpen() : renderClose()}</div>`;
    wire();
  }

  function wire() {
    const q = (sel) => bodyEl.querySelectorAll(sel);

    q("[data-view]").forEach((b) =>
      b.addEventListener("click", () => { state.view = b.dataset.view; state.error = null; state.result = null; render(); }),
    );
    q("[data-side]").forEach((b) =>
      b.addEventListener("click", () => { state.side = b.dataset.side; render(); }),
    );
    q("[data-pct]").forEach((b) =>
      b.addEventListener("click", () => { state.pct = Number(b.dataset.pct); render(); }),
    );
    q("[data-toggle-type]").forEach((b) =>
      b.addEventListener("click", () => {
        state.orderType = state.orderType === "limit" ? "market" : "limit";
        render();
      }),
    );

    // Слайдеры: живой отклик без полной перерисовки (иначе палец теряет ползунок).
    q("[data-slider]").forEach((el) => {
      el.addEventListener("input", () => {
        const val = Number(el.value);
        if (el.dataset.slider === "margin") state.marginUsd = val;
        else state.leverage = val;
        const min = Number(el.min);
        const max = Number(el.max);
        el.style.setProperty("--fill", `${max > min ? ((val - min) / (max - min)) * 100 : 0}%`);
        softRefresh();
      });
      el.addEventListener("change", render); // добить производные блоки
    });

    q("[data-f]").forEach((el) => {
      const key = el.dataset.f;
      el.addEventListener("input", () => {
        state[key] = key === "coin" ? el.value.toUpperCase().replace(/[^A-Z0-9:_-]/g, "") : el.value;
        if (key === "coin" && el.value !== state.coin) el.value = state.coin;
        state.error = null;
        if (key === "coin") scheduleContext();
        softRefresh();
      });
    });

    bodyEl.querySelector("[data-submit]")?.addEventListener("click", submitOpen);
    q("[data-close]").forEach((b) => b.addEventListener("click", () => submitClose(b.dataset.close)));
  }

  /** Пересчёт производных чисел без перерисовки — чтобы слайдер не «прыгал». */
  function softRefresh() {
    const v = validateOpen(state, ctx);
    const notional = v.notional;
    const coins = sizeInCoins(notional, v.entry ?? ctx.price);

    const marginEl = bodyEl.querySelector("[data-margin]");
    if (marginEl) {
      marginEl.textContent = Number(state.marginUsd).toFixed(2);
      marginEl.classList.toggle("is-bad", notional > 0 && notional < MIN_ORDER_USD);
    }
    const levEl = bodyEl.querySelector("[data-lev]");
    if (levEl) levEl.innerHTML = `${state.leverage}<i>x</i>`;

    const sizeEl = bodyEl.querySelector("[data-size]");
    if (sizeEl) {
      sizeEl.textContent =
        notional > 0 ? `${fmtUsd(notional)} = ${coinAmount(coins)} ${state.coin || ""}` : "—";
    }

    const btn = bodyEl.querySelector("[data-submit]");
    if (btn) btn.disabled = !v.ok || state.submitting;

    const bl = bodyEl.querySelector(".tt-blockers");
    if (bl) {
      bl.innerHTML = v.blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
      bl.hidden = v.blockers.length === 0;
    }
    const wa = bodyEl.querySelector(".tt-warnings");
    if (wa) {
      wa.innerHTML = v.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
      wa.hidden = v.warnings.length === 0;
    }
  }

  let ctxTimer = null;
  function scheduleContext() {
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => loadContext().then(render), 350);
  }

  async function submitOpen() {
    if (!validateOpen(state, ctx).ok || state.submitting) return;
    state.submitting = true;
    state.error = null;
    state.result = null;
    render();
    try {
      const res = await io.open({
        coin: state.coin,
        side: state.side,
        marginUsd: Number(state.marginUsd),
        leverage: Number(state.leverage),
        sizeUsd: notionalUsd(state.marginUsd, state.leverage),
        orderType: state.orderType,
        limitPx: state.orderType === "limit" ? Number(state.limitPx) : null,
      });
      if (res?.ok) {
        state.result = res.message || "order sent";
        state.marginUsd = 0;
        state.limitPx = "";
      } else {
        state.error = res?.error || "exchange rejected the order";
      }
    } catch (err) {
      state.error = err?.message || "network unavailable";
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function submitClose(coin) {
    const p = (ctx.positions || []).find((x) => x.coin === coin);
    if (!p || state.submitting) return;
    state.submitting = true;
    state.coin = coin;
    state.error = null;
    state.result = null;
    render();
    try {
      const res = await io.close({
        coin,
        pct: Number(state.pct),
        orderType: state.orderType,
        limitPx: state.orderType === "limit" ? Number(state.limitPx) : null,
      });
      if (res?.ok) {
        state.result = res.message || "close order sent";
        state.limitPx = "";
      } else {
        state.error = res?.error || "exchange rejected the order";
      }
    } catch (err) {
      state.error = err?.message || "network unavailable";
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function loadContext() {
    if (!io?.getContext) return;
    try {
      ctx = { ...ctx, ...(await io.getContext(state.coin)) };
      if (!(state.marginUsd > 0) && ctx.available > 0) {
        // Стартовая маржа — половина свободного, но не меньше минимума ордера.
        state.marginUsd = Math.min(ctx.available, Math.max(ctx.available / 2, MIN_ORDER_USD / state.leverage));
        state.marginUsd = Math.round(state.marginUsd * 100) / 100;
      }
    } catch { /* держим прежний контекст — модалка остаётся управляемой */ }
  }

  async function open({ coin = "", side, view } = {}) {
    ensureDom();
    if (coin) state.coin = String(coin).toUpperCase();
    if (side) state.side = side;
    if (view) state.view = view;
    state.error = null;
    state.result = null;
    await loadContext();
    render();
    el.hidden = false;
    // Чтобы анимация проигралась, браузер должен сначала зафиксировать
    // НАЧАЛЬНОЕ состояние (opacity 0 + сдвиг), и только потом получить класс.
    // Раньше тут был requestAnimationFrame — и это давало невидимую модалку:
    // в неактивной вкладке кадры не выдаются, callback не вызывался никогда,
    // класс не вешался, панель оставалась на opacity 0. Принудительный reflow
    // делает то же самое синхронно и от кадров не зависит.
    void el.offsetHeight;
    el.classList.add("is-open");
    document.body.style.overflow = "hidden";
  }

  function close() {
    if (!el) return;
    el.classList.remove("is-open");
    document.body.style.overflow = "";
    // Ждём выезд панели вниз, потом прячем.
    setTimeout(() => { el.hidden = true; }, 200);
  }

  return { open, close, refresh: async () => { await loadContext(); if (el && !el.hidden) render(); }, _state: state, _setContext(n) { ctx = { ...ctx, ...n }; if (el && !el.hidden) render(); } };
}

let singleton = null;

/**
 * Отдельный экземпляр модалки. Нужен стенду, который держит несколько сценариев
 * с разными моками на одной странице. В приложении используй initTradeTicket.
 */
export function createTradeTicketModal(io) {
  return createModal(io);
}

/**
 * Единственная модалка тикета на страницу.
 * io: { getContext(coin) → {price, available, maxLeverage, stopDistPct, day, positions, adoptEnabled},
 *       open(payload), close(payload) }
 */
export function initTradeTicket(io) {
  if (!singleton) singleton = createModal(io);
  return singleton;
}

/** Открыть модалку (создаёт при первом вызове). */
export function openTradeTicket(io, opts) {
  return initTradeTicket(io).open(opts);
}
