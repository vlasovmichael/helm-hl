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
import * as dialog from "../core/dialog.js";
import { icon } from "../core/icon.js";
import { button, segmented } from "../core/ui.js";

// Биржевой минимум ордера на HL. Меньше — отказ, поэтому это блокер, а не
// предупреждение (Rabby показывает ровно его же красным).
const MIN_ORDER_USD = 10;

// Наш потолок плеча — НЕ биржевой, а страховка: при стопе няньки ~−7% ATR
// изолированная ликвидация на 20x приходит около −5%, то есть раньше стопа.
// Используется только как fallback, пока контекст с сервера не приехал.
// Настоящий лимит у каждой монеты свой (CASHCAT 3x, LIT 5x, ETH 25x, BTC 40x)
// и приходит в ctx.maxLeverage — подменять его константой нельзя.
const FALLBACK_LEVERAGE_CAP = 10;

/** Эффективный потолок плеча: что сказал сервер, иначе осторожный fallback. */
export function leverageCap(ctx) {
  const n = Number(ctx?.maxLeverage);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : FALLBACK_LEVERAGE_CAP;
}

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
// Цена для подстановки в input: без "$" и разделителей, 5 значащих цифр —
// столько держит цена перпа на HL. Бэкенд всё равно прогонит через formatHlPrice,
// но класть в поле заведомо валидное значение честнее, чем "$1,234.5".
function plainPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || !(n > 0)) return "";
  return String(Number(n.toPrecision(5)));
}

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

/**
 * Риск против ДЕПО, а не против маржи сделки. Здесь же — размер, который отвечал
 * бы порогу: стоп двигать нельзя (он по волатильности монеты), двигается размер.
 *
 *   нотионал = депо × riskPct / дистанция_стопа
 *
 * Это единственная величина риск-модели, которая переносится между счетами: 5%
 * значит $0.21 на депо $4 и $1000 на $20 000.
 */
export function riskVsEquity({ riskUsd, equity, riskPct, stopDistPct }) {
  const eq = Number(equity);
  const d = Number(stopDistPct);
  if (!(riskUsd > 0) || !(eq > 0)) return null;
  const pctOfEquity = (riskUsd / eq) * 100;
  const limit = Number(riskPct);
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const suggestedNotional = hasLimit && Number.isFinite(d) && d > 0
    ? (eq * (limit / 100)) / (d / 100)
    : null;
  return { pctOfEquity, suggestedNotional, over: hasLimit && pctOfEquity > limit };
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

  // Плечо против лимита КОНКРЕТНОЙ монеты. Слайдер и так ограничен, но состояние
  // переживает смену монеты: выставил 10x на DOGE, переключился на CASHCAT (3x) —
  // без этой проверки ушёл бы заведомо отбойный ордер.
  const cap = leverageCap(ctx);
  if (Number(s.leverage) > cap) {
    blockers.push(`max leverage for ${s.coin || "this coin"} is ${cap}x`);
  }

  if (ctx?.day?.halted) blockers.push("daily stop hit — entries locked until midnight");
  // known === false: статус дня не посчитан (бот только поднялся или падает
  // запрос). halted=false тут не значит «лимит цел», значит «не знаем».
  else if (ctx?.day && ctx.day.known === false) warnings.push("daily P&L unknown — the daily stop can't be enforced right now");

  // Те же два гейта, что стоят на сервере. Дублируются здесь, чтобы кнопка
  // была закрыта ДО клика: отбитый ордер уже поздно — решение принято.
  if (ctx?.day?.tradesOver) {
    blockers.push(
      `daily trade budget spent (${ctx.day.tradesToday} of ${ctx.day.tradesCap}) — entries locked until midnight`,
    );
  }
  if (ctx?.cooldown?.blocked) {
    const mins = Math.ceil(ctx.cooldown.secondsLeft / 60);
    blockers.push(`${s.coin} just closed — ${mins} min of the ${ctx.cooldown.minutes}-minute cooldown left`);
  }

  if (ctx?.adoptEnabled === false) warnings.push("bot sitter is off — nobody will place a stop");
  if (ctx?.hasPosition) warnings.push(`${s.coin} position already open — this adds to it`);

  return { ok: blockers.length === 0, blockers, warnings, entry, notional };
}

/**
 * Валидация закрытия. Выход намеренно почти не гейтится: дневной стоп на него
 * НЕ распространяется — запирать себе выход опасно.
 *
 * ⚠️ UI её сейчас НЕ вызывает: закрытие переехало на карточку позиции и делает
 * только «всё по рынку». Функция оставлена сознательно — она зеркалит контракт
 * `POST /api/ticket/close`, который по-прежнему принимает `pct` и `orderType`,
 * и держит на тестах инвариант «дневной стоп выход не запирает». Понадобится
 * частичное или post-only закрытие — вернуть в интерфейс, не переписывая.
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

// Маркер строки — иконка из общего набора, а не глиф в list-style: у ⚠
// текстового шрифта другой вес и другая высота, чем у остальных иконок листа.
function listBlock(cls, items, glyph = "") {
  return `<ul class="${cls}" ${items.length ? "" : "hidden"}>${items
    .map((x) => `<li>${glyph ? icon(glyph) : ""}<span>${escapeHtml(x)}</span></li>`)
    .join("")}</ul>`;
}

/**
 * Подсказки тикеров под вводом. Совпадение с НАЧАЛА строки идёт выше, чем
 * вхождение в середине: набирая «AC», человек ищет ACE, а не CASHCAT.
 */
export function suggestCoins(query, coins, limit = 8) {
  const q = String(query || "").trim().toUpperCase();
  const list = Array.isArray(coins) ? coins : [];
  if (!q) return list.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const c of list) {
    const u = String(c).toUpperCase();
    if (u === q) continue; // точное совпадение уже введено — подсказывать нечего
    if (u.startsWith(q)) starts.push(c);
    else if (u.includes(q)) contains.push(c);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
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
    coin: "",
    side: "short",
    marginUsd: 0,
    leverage: 3,
    orderType: "market",
    limitPx: "",
    submitting: false,
    error: null,
    result: null,
    suggestOpen: false, // видна ли выпадашка тикеров
    suggestIdx: 0,      // подсвеченный пункт (для ↑/↓ + Enter)
  };
  let ctx = { price: null, available: 0, maxLeverage: FALLBACK_LEVERAGE_CAP, day: {}, adoptEnabled: true, positions: [] };
  let el = null;
  let bodyEl = null;
  let closeAfter = null; // отложенное авто-закрытие после успешного ордера

  // ── Каркас модалки (создаётся один раз) ──
  function ensureDom() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "modal tt-modal";
    el.hidden = true;
    el.innerHTML = `
      <div class="modal__backdrop" data-tt-close></div>
      <div class="modal__panel tt-panel" role="dialog" aria-modal="true" aria-label="Position">
        <button class="modal__close" type="button" data-tt-close aria-label="Close">${icon("close")}</button>
        <div class="tt-panel__body"></div>
      </div>`;
    document.body.appendChild(el);
    bodyEl = el.querySelector(".tt-panel__body");
    // Закрытие ведём сами: у листа есть выезд вниз, и прятать его надо ПОСЛЕ
    // анимации. Замок прокрутки, Escape и возврат фокуса при этом всё равно
    // приходят из core/dialog.js — они общие для всех диалогов.
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-tt-close]")) close();
    });
    return el;
  }

  // ── Вид «Открыть» ──
  /**
   * Монета введена целиком и биржа её знает. Список тикеров может ещё не
   * приехать — тогда доверяем флагу coinKnown с бэкенда, а если нет и его,
   * считаем известной (лучше не мешать, чем мешать зря).
   */
  function knownCoin() {
    if (!state.coin) return false;
    if (Array.isArray(ctx.coins) && ctx.coins.length) {
      return ctx.coins.some((c) => String(c).toUpperCase() === state.coin);
    }
    return ctx.coinKnown !== false;
  }

  /**
   * Подпись под «Leverage». Показываем, ЧЕЙ лимит связывает: у CASHCAT потолок
   * ставит биржа (3x), у BTC — мы сами (биржа даёт 40x). Иначе «up to 10x» на
   * биткоине выглядело бы как ограничение биржи, чем оно не является.
   */
  function levCapLabel() {
    const cap = leverageCap(ctx);
    const ex = Number(ctx.exchangeMaxLeverage);
    if (Number.isFinite(ex) && ex > cap) return `up to ${cap}x · own cap, venue allows ${ex}x`;
    return `up to ${cap}x`;
  }

  /** Содержимое строки Stop Loss — общее для render и точечного обновления. */
  function botStopHtml(botStop) {
    if (ctx.adoptEnabled === false) return "nobody will set it";
    if (botStop == null) return "by ATR after entry";
    return `${escapeHtml(fmtPrice(botStop))} <i class="tt-row__sub">−${Number(ctx.stopDistPct).toFixed(1)}% ATR</i>`;
  }

  /** Префикс id пунктов выпадашки (для aria-activedescendant). */
  const COMBO_OPT_ID = "tt-coin-opt-";

  /** Выпадашка подсказок под полем монеты. Пусто → ничего не рисуем. */
  function suggestList() {
    if (!state.suggestOpen) return "";
    const items = suggestCoins(state.coin, ctx.coins);
    if (!items.length) return "";
    // id на каждом пункте — чтобы input мог указать на подсвеченный через
    // aria-activedescendant: без этого скринридер читает список, но молчит о
    // том, где сейчас стоит выбор при навигации стрелками.
    return `<ul class="tt-combo__list" role="listbox">${items
      .map(
        (c, i) =>
          `<li class="tt-combo__item ${i === state.suggestIdx ? "is-on" : ""}" role="option"
               id="${COMBO_OPT_ID}${i}"
               aria-selected="${i === state.suggestIdx}" data-pick="${escapeHtml(c)}">${escapeHtml(c)}</li>`,
      )
      .join("")}</ul>`;
  }

  function renderOpen() {
    const v = validateOpen(state, ctx);
    const isShort = state.side === "short";
    const notional = v.notional;
    const coins = sizeInCoins(notional, v.entry ?? ctx.price);
    const botStop = projectedBotStop({ side: state.side, entry: v.entry, stopDistPct: ctx.stopDistPct });
    const risk = stopRiskUsd({ notional, stopDistPct: ctx.stopDistPct });
    const riskEq = riskVsEquity({
      riskUsd: risk,
      equity: ctx.equity,
      riskPct: ctx.riskPct,
      stopDistPct: ctx.stopDistPct,
    });
    const maxLev = leverageCap(ctx);
    const available = Number(ctx.available) || 0;
    const tooSmall = notional > 0 && notional < MIN_ORDER_USD;

    return `
      <!-- Тикер в заголовке — только когда он РЕАЛЬНЫЙ: иначе на полпути ввода
           получалось бы «Open A Position». -->
      <h2 class="tt-panel__title">${
        knownCoin() ? `Open ${escapeHtml(state.coin)} Position` : "Open Position"
      }</h2>

      ${segmented({
        name: "side",
        value: state.side,
        wide: true,
        cls: "tt-seg--side",
        options: [
          { value: "long", label: "Long", tone: "long" },
          { value: "short", label: "Short", tone: "short" },
        ],
      })}

      <!-- Поле монеты видно ВСЕГДА (а не только пока пусто): иначе, выбрав
           монету, её нельзя было бы поменять не закрыв модалку. -->
      <div class="tt-card tt-card--coin">
        <div class="tt-card__label">Coin</div>
        <div class="tt-combo">
          <input class="tt-coin-input" data-f="coin" type="text" placeholder="ticker"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"
                 role="combobox" aria-expanded="${state.suggestOpen ? "true" : "false"}"
                 aria-autocomplete="list" value="${escapeHtml(state.coin)}">
          ${suggestList()}
        </div>
      </div>

      <div class="tt-card">
        <div class="tt-card__head">
          <span class="tt-card__label tt-card__label--accent">Margin <i>(USDC)</i></span>
          <span class="tt-chip">Isolated</span>
        </div>
        <div class="tt-card__row">
          <div class="tt-card__minor">
            <b data-avail>${available.toFixed(2)}</b>
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
            <span data-levcap>${levCapLabel()}</span>
          </div>
          <div class="tt-card__major" data-lev>${state.leverage}<i>x</i></div>
        </div>
        ${slider("leverage", state.leverage, 1, maxLev, 1)}
      </div>

      <div class="tt-rows">
        <div class="tt-row">
          <span>Current Price</span>
          <b data-price>${ctx.price > 0 ? escapeHtml(fmtPrice(ctx.price)) : "—"}</b>
        </div>
        <div class="tt-row">
          <span>Order Type</span>
          <!-- Иконка тут одна на оба состояния и означает «поменять» — так было
               до 04.09.2026 (глиф ⇄), так и осталось, только контуром из общего
               набора. Разные иконки под маркет и лимитку пробовали: тип ордера
               и так написан словом рядом, а картинка начинала спорить с ним. -->
          <button type="button" class="tt-row__toggle" data-toggle-type
                  title="${state.orderType === "limit" ? "Limit post-only — switch to market" : "Market — switch to limit post-only"}">
            ${state.orderType === "limit" ? "Limit post-only" : "Market"} ${icon("swap")}
          </button>
        </div>
        ${state.orderType === "limit"
          ? `<div class="tt-row tt-row--input">
               <span>Limit Price</span>
               <input class="tt-row__input" data-f="limitPx" type="text" inputmode="decimal"
                      placeholder="${ctx.price > 0 ? fmtPrice(ctx.price) : "0.00"}" value="${escapeHtml(state.limitPx)}">
             </div>
             <div class="tt-row tt-row--sub">
               <span></span>
               <button type="button" class="tt-row__toggle" data-use-price
                       ${ctx.price > 0 ? "" : "disabled"}>
                 use current <b data-useprice>${ctx.price > 0 ? escapeHtml(fmtPrice(ctx.price)) : "—"}</b>
               </button>
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
          <b data-botstop>${botStopHtml(botStop)}</b>
        </div>
        <div class="tt-row ${riskEq?.over ? "tt-row--bad" : ""}">
          <span>Risk at that stop</span>
          <b class="${risk != null ? "is-risk" : ""}">${
            risk != null
              ? `−${fmtUsd(risk)}${riskEq ? ` <i class="tt-row__sub">${riskEq.pctOfEquity.toFixed(0)}% of equity</i>` : ""}`
              : "—"
          }</b>
        </div>
        ${riskEq?.over && riskEq.suggestedNotional != null
          ? `<div class="tt-row tt-row--sub">
               <span></span>
               <b class="tt-row__sub">${ctx.riskPct}% would be ${fmtUsd(riskEq.suggestedNotional)}${
                 riskEq.suggestedNotional < MIN_ORDER_USD
                   ? ` — below the ${fmtUsd(MIN_ORDER_USD)} minimum`
                   : ""
               }</b>
             </div>`
          : ""}
      </div>

      ${listBlock("tt-blockers", v.blockers)}
      ${listBlock("tt-warnings", v.warnings, "warn")}
      ${state.error ? `<div class="tt-alert tt-alert--err">${escapeHtml(state.error)}</div>` : ""}
      ${state.result ? `<div class="tt-alert tt-alert--ok">${escapeHtml(state.result)}</div>` : ""}

      ${button({
        label: state.submitting ? "Sending…" : `Open ${isShort ? "Short" : "Long"}`,
        variant: isShort ? "short" : "long",
        cta: true,
        disabled: !(v.ok && !state.submitting),
        attrs: { "data-submit": true },
      })}
      <div class="tt-foot">${
        state.orderType === "limit"
          ? "post-only · 1.44 bps · may not fill"
          : "taker · 4.32 bps · fills now"
      } · builder fee 0 bps</div>`;
  }

  // ── Вид «Закрыть» ──
  function render() {
    ensureDom();
    // Прижимаем ДО построения разметки: иначе слайдер получит value=10 при
    // max=3, браузер молча поправит поле, а state и число рядом останутся на 10.
    clampState();
    // Вкладок Open/Close больше нет: закрытие переехало на карточку позиции,
    // где цена живая. Пока откроешь модалку и переключишь вкладку — рынок
    // уезжает, и выход по устаревшей цене хуже, чем выигрыш в удобстве.
    bodyEl.innerHTML = `<div class="tt-view">${renderOpen()}</div>`;
    wire();
  }

  function wire() {
    const q = (sel) => bodyEl.querySelectorAll(sel);

    q("[data-side]").forEach((b) =>
      b.addEventListener("click", () => { state.side = b.dataset.side; render(); }),
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
      if (key === "coin") return wireCombo(el);
      el.addEventListener("input", () => {
        state[key] = el.value;
        state.error = null;
        softRefresh();
      });
    });

    // «use current» — подставить текущую цену в поле лимитки. Ровно текущая цена
    // валидацию на пересечение не нарушает (wouldCross строго больше/меньше),
    // дальше её двигают руками на нужную сторону книги.
    q("[data-use-price]").forEach((b) =>
      b.addEventListener("click", () => {
        const px = plainPrice(ctx.price);
        if (!px) return;
        state.limitPx = px;
        state.error = null;
        render();
      }),
    );

    bodyEl.querySelector("[data-submit]")?.addEventListener("click", submitOpen);
  }

  /** Пересчёт производных чисел без перерисовки — чтобы слайдер не «прыгал». */
  /**
   * Точечное обновление всех производных чисел БЕЗ перерисовки DOM.
   *
   * Полный render() тут использовать нельзя: он пересоздаёт .tt-view, из-за
   * чего переигрывается CSS-анимация появления и модалка визуально «моргает
   * как перезагруженная» на каждом введённом символе. Плюс терялись бы фокус,
   * каретка и открытая выпадашка. Поэтому всё, что зависит от state и от
   * контекста с сервера, обновляется здесь адресно.
   */
  /**
   * Прижимает плечо и маржу к лимитам текущей монеты и синхронизирует слайдеры.
   *
   * Нужен потому, что state переживает смену монеты: выставил 10x на DOGE,
   * переключился на CASHCAT (биржевой максимум 3x) — плечо обязано переехать
   * само, а не ждать, пока биржа отобьёт ордер.
   */
  /**
   * ЧИСТОЕ прижатие state к лимитам — без DOM. Вызывается и из render(), и из
   * softRefresh, потому что состояние переживает смену монеты по ЛЮБОМУ пути:
   * набор с клавиатуры, клик по подсказке, ↑↓+Enter, повторное открытие модалки
   * с уже выбранной монетой.
   *
   * Раньше кламп жил только в softRefresh, и путь «клик по подсказке → render()»
   * оставлял плечо стухшим: на CASHCAT (3x) в state висело 10x, слайдер молча
   * прижимался разметкой, а число рядом показывало 10x и уходило на сервер.
   * Найдено оператором 16.08.2026 на связке BTC → CASHCAT.
   */
  function clampState() {
    const maxLev = leverageCap(ctx);
    if (state.leverage > maxLev) state.leverage = maxLev;
    const maxMargin = Math.max(Number(ctx.available) || 0, 0);
    if (maxMargin > 0 && state.marginUsd > maxMargin) state.marginUsd = maxMargin;
  }

  /** clampState + синхронизация слайдеров с новым потолком. */
  function clampToLimits() {
    clampState();
    const maxLev = leverageCap(ctx);
    const levSlider = bodyEl.querySelector('[data-slider="leverage"]');
    if (levSlider) {
      levSlider.max = String(maxLev);
      levSlider.value = String(state.leverage);
      levSlider.style.setProperty(
        "--fill",
        `${maxLev > 1 ? ((state.leverage - 1) / (maxLev - 1)) * 100 : 100}%`,
      );
    }

    const maxMargin = Math.max(Number(ctx.available) || 0, 0.01);
    const marginSlider = bodyEl.querySelector('[data-slider="margin"]');
    if (state.marginUsd > maxMargin) state.marginUsd = maxMargin;
    if (marginSlider && Number(marginSlider.max) !== maxMargin) {
      marginSlider.max = String(maxMargin);
      marginSlider.value = String(state.marginUsd);
      marginSlider.style.setProperty(
        "--fill",
        `${maxMargin > 0 ? (state.marginUsd / maxMargin) * 100 : 0}%`,
      );
    }
  }

  function softRefresh() {
    // ── Сначала прижимаем состояние к новым лимитам, только ПОТОМ валидируем ──
    // Порядок важен: если провалидировать раньше клампа, блокер «max leverage
    // is 3x» останется висеть уже после того, как ползунок сам переехал на 3x.
    clampToLimits();

    const v = validateOpen(state, ctx);
    const notional = v.notional;
    const coins = sizeInCoins(notional, v.entry ?? ctx.price);

    // ── Данные, приезжающие с сервера при смене монеты ──
    const priceEl = bodyEl.querySelector("[data-price]");
    if (priceEl) priceEl.textContent = ctx.price > 0 ? fmtPrice(ctx.price) : "—";

    // Подпись на «use current» — та же цена; без этого кнопка предлагала бы
    // цену из прошлого поллинга.
    const usePriceEl = bodyEl.querySelector("[data-useprice]");
    if (usePriceEl) {
      usePriceEl.textContent = ctx.price > 0 ? fmtPrice(ctx.price) : "—";
      const btn = usePriceEl.closest("[data-use-price]");
      if (btn) btn.disabled = !(ctx.price > 0);
    }

    const availEl = bodyEl.querySelector("[data-avail]");
    if (availEl) availEl.textContent = (Number(ctx.available) || 0).toFixed(2);

    const stopEl = bodyEl.querySelector("[data-botstop]");
    if (stopEl) {
      stopEl.innerHTML = botStopHtml(
        projectedBotStop({ side: state.side, entry: v.entry, stopDistPct: ctx.stopDistPct }),
      );
      stopEl.closest(".tt-row")?.classList.toggle("tt-row--bad", ctx.adoptEnabled === false);
    }

    const capEl = bodyEl.querySelector("[data-levcap]");
    if (capEl) capEl.textContent = levCapLabel();

    const titleEl = bodyEl.querySelector(".tt-panel__title");
    if (titleEl) titleEl.textContent = knownCoin() ? `Open ${state.coin} Position` : "Open Position";

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
      wa.innerHTML = v.warnings.map((w) => `<li>${icon("warn")}<span>${escapeHtml(w)}</span></li>`).join("");
      wa.hidden = v.warnings.length === 0;
    }
  }

  /**
   * Поле монеты с выпадашкой. Список перерисовывается ТОЧЕЧНО, без render():
   * полная перерисовка сбрасывала бы фокус и каретку на каждом символе.
   */
  function wireCombo(input) {
    const combo = input.parentElement;

    const redrawList = () => {
      combo.querySelector(".tt-combo__list")?.remove();
      combo.insertAdjacentHTML("beforeend", suggestList());
      input.setAttribute("aria-expanded", state.suggestOpen ? "true" : "false");
      // Указываем на подсвеченный пункт, только если он реально нарисован.
      const active = combo.querySelector(".tt-combo__item.is-on");
      if (active) input.setAttribute("aria-activedescendant", active.id);
      else input.removeAttribute("aria-activedescendant");
      combo.querySelectorAll("[data-pick]").forEach((li) => {
        // mousedown, а не click: blur поля успел бы закрыть список раньше клика.
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(li.dataset.pick);
        });
      });
    };

    const pick = (coin) => {
      state.coin = coin;
      state.suggestOpen = false;
      state.suggestIdx = 0;
      input.value = coin;
      // Рисуем СРАЗУ, не дожидаясь сети: клик по монете обязан отвечать
      // мгновенно. Раньше здесь стоял `loadContext().then(render)`, и выбор
      // «думал» 3-5 секунд — столько живой запрос ATR-свечей по незнакомой
      // монете ждёт бюджета веса.
      //
      // Монето-зависимые поля гасим до приезда ответа: показать цену и плечо
      // ПРЕДЫДУЩЕЙ монеты под именем новой — хуже, чем показать прочерк.
      ctx = {
        ...ctx,
        price: null,
        stopDistPct: null,
        stopBasis: null,
        maxLeverage: null,
        exchangeMaxLeverage: null,
        coinKnown: null,
        hasPosition: false,
        cooldown: null,
      };
      render();
      clearTimeout(ctxTimer);
      loadContext().then(softRefresh);
    };

    input.addEventListener("input", () => {
      const clean = input.value.toUpperCase().replace(/[^A-Z0-9:_-]/g, "");
      if (input.value !== clean) input.value = clean;
      state.coin = clean;
      state.error = null;
      state.suggestOpen = true;
      state.suggestIdx = 0;
      redrawList();
      scheduleContext();
      softRefresh();
    });

    input.addEventListener("focus", () => {
      state.suggestOpen = true;
      state.suggestIdx = 0;
      redrawList();
    });

    input.addEventListener("blur", () => {
      state.suggestOpen = false;
      redrawList();
    });

    input.addEventListener("keydown", (e) => {
      const items = suggestCoins(state.coin, ctx.coins);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!items.length) return;
        e.preventDefault();
        state.suggestOpen = true;
        const step = e.key === "ArrowDown" ? 1 : -1;
        state.suggestIdx = (state.suggestIdx + step + items.length) % items.length;
        redrawList();
      } else if ((e.key === "Home" || e.key === "End") && state.suggestOpen && items.length) {
        // Прыжок к краям списка. Home/End в поле ввода иначе гоняли бы каретку
        // по тексту тикера — при открытой выпадашке полезнее список.
        e.preventDefault();
        state.suggestIdx = e.key === "Home" ? 0 : items.length - 1;
        redrawList();
      } else if (e.key === "Enter" && state.suggestOpen && items[state.suggestIdx]) {
        e.preventDefault();
        pick(items[state.suggestIdx]);
      } else if (e.key === "Escape" && state.suggestOpen) {
        // Гасим список, но НЕ модалку — иначе Esc закрывал бы всё разом.
        e.stopPropagation();
        state.suggestOpen = false;
        redrawList();
      }
    });
  }

  // Смена монеты меняет цену, ATR-стоп и потолок плеча → перезапрашиваем
  // контекст, но не на каждый символ: «CHIP» — это четыре нажатия.
  // Смена монеты меняет цену, ATR-стоп и потолок плеча → перезапрашиваем
  // контекст, но не на каждый символ: «CHIP» — это четыре нажатия.
  //
  // Ответ вливаем через softRefresh, а НЕ через render(): полная перерисовка
  // на каждом символе выглядела как перезагрузка окна (переигрывалась анимация
  // появления) и сбрасывала фокус с кареткой.
  let ctxTimer = null;
  function scheduleContext() {
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(async () => {
      await loadContext();
      softRefresh();
    }, 350);
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
        // Ордер ушёл — держать форму открытой незачем: дальше всё происходит на
        // карточке позиции (там живая цена и стоп няньки). Секунда паузы, чтобы
        // ответ биржи успел прочитаться, и закрываемся.
        closeAfter = setTimeout(() => {
          closeAfter = null;
          close();
        }, 1000);
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

  async function open({ coin = "", side } = {}) {
    ensureDom();
    if (coin) state.coin = String(coin).toUpperCase();
    if (side) state.side = side;
    state.error = null;
    state.result = null;
    if (closeAfter) { clearTimeout(closeAfter); closeAfter = null; }
    // Показываем СРАЗУ, на прошлом контексте, и догружаем свежий фоном.
    // Раньше тут стоял `await loadContext()` перед render() — модалка ждала
    // ответа сервера (цена + ATR + позиции), и это читалось как «тормозит».
    // Кнопка отправки всё равно заблокирована, пока контекст не приехал:
    // без available маржа не проходит проверку, так что торговать по
    // устаревшим числам это не даёт.
    render();
    loadContext().then(() => {
      if (el && !el.hidden) softRefresh();
    });
    dialog.open(el, { onClose: () => el.classList.remove("is-open") });
    // Чтобы анимация проигралась, браузер должен сначала зафиксировать
    // НАЧАЛЬНОЕ состояние (opacity 0 + сдвиг), и только потом получить класс.
    // Раньше тут был requestAnimationFrame — и это давало невидимую модалку:
    // в неактивной вкладке кадры не выдаются, callback не вызывался никогда,
    // класс не вешался, панель оставалась на opacity 0. Принудительный reflow
    // делает то же самое синхронно и от кадров не зависит.
    void el.offsetHeight;
    el.classList.add("is-open");
    startPricePoll();
  }

  // Пока модалка открыта — тянем цену раз в 5 секунд. Без этого «Current Price»
  // застывал на момент открытия, и на низколиквидной монете за полминуты
  // размышлений цена уезжала, а форма показывала старую.
  let pollTimer = null;
  function startPricePoll() {
    stopPricePoll();
    pollTimer = setInterval(async () => {
      if (!el || el.hidden) return stopPricePoll();
      // Во время ввода тикера не мешаем: там свой debounce на смену монеты.
      if (document.activeElement?.dataset?.f === "coin") return;
      await loadContext();
      if (el && !el.hidden) softRefresh();
    }, 5000);
  }
  function stopPricePoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function close() {
    if (!el) return;
    stopPricePoll(); // иначе опрос цены продолжается на закрытой модалке
    if (closeAfter) { clearTimeout(closeAfter); closeAfter = null; } // закрыли раньше таймера
    el.classList.remove("is-open");
    // Ждём выезд панели вниз, потом прячем: dialog.close() снимет замок
    // прокрутки и вернёт фокус на кнопку, с которой лист открывали.
    setTimeout(() => dialog.close(el), 200);
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
