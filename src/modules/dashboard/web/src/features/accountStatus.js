// ─────────────────────────────────────────────────
//  Live account/position статус (из WS status-payload).
//  · renderHeader — equity (odometer) + session-delta + uptime + available.
//  · renderPosition — активная позиция бота (single slot) + P&L breakdown.
//  · renderManualPositions — ручные HANDS-OFF позиции (+ ADOPTED-бейдж).
//  · renderBans — strip активных runtime-банов.
//  Odometer-анимация чисел вынесена в utils/animatedNumber.js (общая с плашкой
//  Market Context — одно место, без дублирования).
// ─────────────────────────────────────────────────

import { fmtUsd, fmtPrice, fmtPct, formatUptime, escapeHtml } from "../utils/format.js";
import { riskTint } from "../utils/riskBar.js";
import { updateAnimatedNumber } from "../utils/animatedNumber.js";
import { startPriceStream, setWatchedCoins, getLivePrice, onPriceTick } from "../net/priceStream.js";

// Доп. классы + inline-стиль для глубинной заливки PnL-карточки.
// tint = riskTint(...) | null. Возвращает { cls, attr } для подстановки в HTML.
function tintAttrs(tint) {
  if (!tint) return { cls: "", attr: "" };
  const cls = ` rb-depth rb-${tint.phase}${tint.peak != null ? " rb-ghost" : ""}${tint.hot ? " rb-hot" : ""}`;
  const peakVar = tint.peak != null ? `;--rb-peak:${tint.peak.toFixed(3)}` : "";
  const attr = ` style="--rb-now:${tint.now.toFixed(3)}${peakVar}"${tint.tip ? ` title="${tint.tip}"` : ""}`;
  return { cls, attr };
}

// Знак прошлого Net(Mkt) бот-позиции — чтобы пыхнуть карточкой при переходе
// через ноль (плюс↔минус), а не на каждый ре-рендер.
let _lastNetSign = null;

const _reduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Желе/вода-движение теперь живёт В САМОМ ПОЛЗУНКЕ: --rb-now едет с упругим
// overshoot-easing (см. _datagrid.scss), а край заливки мягко «переливается»
// поверх текста и подсвечивает символы, на которые наезжает. Поэтому всю
// карточку на каждый тик больше НЕ трясём трансформом — это и был «дёрг».
// Остался только короткий «пых» яркости при кроссе нуля (плюс↔минус).
function flashCross(el) {
  if (!el || _reduceMotion || typeof el.animate !== "function") return;
  el.animate([{ filter: "brightness(1.22)" }, { filter: "brightness(1)" }], {
    duration: 560,
    easing: "ease-out",
  });
}

// Применить tint-классы + длину ползунка (--rb-now) к УЖЕ существующему узлу —
// так CSS-transition реально проигрывается (узел не пересоздаётся).
function applyTint(el, tint, sign) {
  if (!el) return;
  el.classList.toggle("pnl-pos", sign === "pos");
  el.classList.toggle("pnl-neg", sign === "neg");
  el.classList.remove(
    "rb-depth", "rb-stop", "rb-arm", "rb-trail", "rb-profit", "rb-hot", "rb-ghost",
  );
  if (tint) {
    el.classList.add("rb-depth", `rb-${tint.phase}`);
    if (tint.hot) el.classList.add("rb-hot");
    el.style.setProperty("--rb-now", tint.now.toFixed(3));
    if (tint.peak != null) {
      el.classList.add("rb-ghost");
      el.style.setProperty("--rb-peak", tint.peak.toFixed(3));
    } else {
      el.style.removeProperty("--rb-peak");
    }
    if (tint.tip) el.title = tint.tip;
    else el.removeAttribute("title");
  } else {
    el.style.removeProperty("--rb-now");
    el.style.removeProperty("--rb-peak");
    el.removeAttribute("title");
  }
}

// ── «Настроение» секции Active Position ───────────────────────────────────────
// Фон ВСЕЙ секции #sec-position тем зеленее (или краснее), чем лучше идёт день:
// настроение = Today (realized) + Σ uPnL открытых монет. Живёт в прямом эфире —
// uPnL едет по WS (≤2с), Today обновляется поллингом (≤10с). $2 → лёгкий тон,
// $5 → заметнее, $8+ → потолок; кривая sqrt делает мелкие суммы видимее, MAX_MIX
// держит подмешивание цвета умеренным (текст читаем). Около нуля — нейтрально.
// Только эта секция и нигде больше (по просьбе оператора). 2026-06-29.
const PNL_MOOD_CAP_USD = 8;       // где насыщенность упирается в потолок
const PNL_MOOD_MAX_MIX = 0.18;    // макс. доля цвета (большая площадь → мягче)
const PNL_MOOD_DEADZONE_USD = 0.1;
let _moodToday = 0;   // последний Today (realized), ставит setDailyPnl
let _moodUpnl = 0;    // Σ uPnL открытых поз, ставит setActivePositionsPnl
function pnlMoodMix(pnlUsd) {
  const a = Math.abs(pnlUsd);
  if (!(a >= PNL_MOOD_DEADZONE_USD)) return 0;
  return Math.sqrt(Math.min(1, a / PNL_MOOD_CAP_USD)) * PNL_MOOD_MAX_MIX;
}
function refreshSectionMood() {
  const sec = document.getElementById("sec-position");
  if (!sec) return; // не на этой странице
  const v = _moodToday + _moodUpnl;
  sec.style.setProperty("--mood", pnlMoodMix(v).toFixed(3));
  sec.dataset.mood = v >= 0 ? "pos" : "neg";
}

/** Σ uPnL открытых поз (бот + ручные) для фона секции. Зовётся из onStatus (≤2с). */
export function setActivePositionsPnl(sumUsd) {
  _moodUpnl = Number.isFinite(sumUsd) ? sumUsd : 0;
  refreshSectionMood();
}

// Обновить $-значение + знаковый класс ячейки на месте.
function setUsd(el, v) {
  if (!el) return;
  el.textContent = `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(4)}`;
  el.classList.toggle("positive", v >= 0);
  el.classList.toggle("negative", v < 0);
}

// Двухслойная начинка PnL-карточки (uPnL/Net) под сплошную заливку temp/1.html:
//  · .pnl-base — нижний слой, цветной текст (несёт id/знаковый класс для патча);
//  · .pnl-fill — верхний слой, белый текст в сплошной заливке (обрезается CSS по
//    --rb-now). Виден только при rb-depth (есть стоп) — иначе CSS его прячет.
function pnlLayers({ label, valueId = "", valueCls = "", valueText, subText }) {
  const idAttr = valueId ? ` id="${valueId}"` : "";
  // subText (R + peak) уезжает В СТРОКУ ЛЕЙБЛА справа — "uPnL ........ +2.28R",
  // а не третьей строкой. Лежит ВНУТРИ всех трёх слоёв, поэтому её накрывает тот
  // же clip-path заливки, что и значение: символы под ярким краем белеют (R
  // «переливается» вместе с числом). undefined → лейбл как есть (карточка Net).
  const labelRow =
    subText !== undefined
      ? `<div class="item-label pnl-toprow"><span>${label}</span><span class="pnl-sub">${subText}</span></div>`
      : `<div class="item-label">${label}</div>`;
  return (
    // Скрытый клон В ПОТОКЕ несёт высоту ячейки; base/fill оба absolute поверх,
    // чтобы делить один layout-контекст и не разъезжаться на сабпиксель (см.
    // _datagrid.scss). Все три — идентичная структура labelRow+value.
    `<div class="pnl-spacer" aria-hidden="true">` +
    labelRow +
    `<div class="item-value">${valueText}</div>` +
    `</div>` +
    `<div class="pnl-base">` +
    labelRow +
    `<div${idAttr} class="item-value ${valueCls}">${valueText}</div>` +
    `</div>` +
    // Призрак отката: тусклая заливка до пика (MFE), обрезана по --rb-peak. Лежит
    // под ярким .pnl-fill (тот до --rb-now), поэтому виден только участок «текущий
    // → пик» — то, что цена прошла в плюс и сдала. Только фон, без текста.
    `<div class="pnl-peak" aria-hidden="true"></div>` +
    `<div class="pnl-fill" aria-hidden="true">` +
    labelRow +
    `<div class="item-value">${valueText}</div>` +
    `</div>`
  );
}

// Обновить $-значение в ОБОИХ слоях двухслойной PnL-карточки (нижний цветной +
// верхний белый), чтобы текст под заливкой совпадал с текстом снаружи.
function setPnlUsd(cell, v) {
  if (!cell) return;
  const base = cell.querySelector(".pnl-base .item-value");
  setUsd(base, v);
  if (!base) return;
  const txt = base.textContent;
  // fill (видимый верх) и spacer (несёт высоту) держим в синхроне с base.
  const fill = cell.querySelector(".pnl-fill .item-value");
  if (fill) fill.textContent = txt;
  const spacer = cell.querySelector(".pnl-spacer .item-value");
  if (spacer) spacer.textContent = txt;
}

// ── Производные метрики ручной (HANDS-OFF/ADOPTED) позиции для карточек. Один
// источник правды и для сборки HTML, и для патча-на-месте, чтобы цифры не
// разъезжались. Всё считаем из payload: бэк трогать не надо (2026-06-20).
//   · riskUsd  — $ на кону до жёсткого стопа (initialRiskPct·size). null без стопа.
//   · rMult    — uPnL / riskUsd: насколько сделка прошла в R (честнее доллара).
//   · movePct  — ход цены к ВХОДУ со знаком МОЕЙ стороны (+ в мою пользу).
//   · floor*   — живой пол выхода няньки: цена / тип (stop|be|trail) / $ на полу.
//   · peakPct  — MFE: как далеко ушло в плюс (MAE бэк не хранит — откат не покажем).
function manualStats(p) {
  const entry = p.entryPrice;
  const now = p.currentPrice;
  const isShort = String(p.side || "").toUpperCase() === "SHORT";
  const bot = p.bot || null;
  const riskPct =
    bot?.initialRiskPct != null
      ? bot.initialRiskPct
      : bot?.stopPrice && entry
        ? (Math.abs(entry - bot.stopPrice) / entry) * 100
        : null;
  const riskUsd =
    riskPct != null && p.sizeUsd != null ? (riskPct / 100) * p.sizeUsd : null;
  const rMult =
    riskUsd && riskUsd > 0 && p.unrealizedPnl != null
      ? p.unrealizedPnl / riskUsd
      : null;
  const movePct =
    entry && now ? ((isShort ? entry - now : now - entry) / entry) * 100 : null;
  const floorPrice = bot?.floorPrice ?? bot?.stopPrice ?? null;
  const floorKind = bot?.floorKind ?? (bot?.stopPrice ? "stop" : null);
  const floorPnl =
    bot?.floorPct != null && p.sizeUsd != null
      ? (bot.floorPct / 100) * p.sizeUsd
      : null;
  const peakPct = bot?.peakPct != null && bot.peakPct > 0 ? bot.peakPct : null;
  // Сколько ещё до цели — в R и в процентах хода. Просьба оператора (03.09.2026):
  // «R 1:1.2» на глаз не читается, нужна цифра «осталось столько-то».
  const tp = bot?.tpPrice ?? null;
  const toTargetPct =
    tp && now ? ((isShort ? now - tp : tp - now) / now) * 100 : null;
  const toTargetR =
    toTargetPct != null && riskPct ? toTargetPct / riskPct : null;
  // MAE: худшая просадка (unrealized %, ≤0). Бэк хранит как ≤0 (getAdoptMaePct/
  // getHunterMaePct). В под-строке uPnL показываем ИМЕННО его, когда позиция
  // сейчас в минусе. Кормит riskTint («призрак» отката на заливке uPnL).
  const maePct = bot?.maePct != null && bot.maePct < 0 ? bot.maePct : null;
  return { riskUsd, rMult, movePct, floorPrice, floorKind, floorPnl, peakPct, maePct, toTargetR, toTargetPct, tpPrice: tp };
}

// Floor-бейдж: тип защиты, который УЖЕ повесила нянька. Цветим только маленький
// чип (HARD/BE/TRAIL), чтобы не плодить второе «пятно» — глубинная заливка
// живёт только на uPnL.
const FLOOR_BADGE = {
  stop: { txt: "HARD", cls: "fl-hard" },
  be: { txt: "BE", cls: "fl-be" },
  trail: { txt: "TRAIL", cls: "fl-trail" },
};

const fmtSignedUsd2 = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
// Знак + цвет (red = против позиции) уже несут направление хода, поэтому слова
// «против» не пишем — оно по-русски и распирало Entry·Now на третью строку.
const fmtMove = (m) => `${m >= 0 ? "+" : "−"}${Math.abs(m).toFixed(2)}%`;
// Остаток до цели в R — инлайн на карточке цели (см. floorCell). Без знака:
// цель всегда впереди, минус там невозможен.
const fmtRemR = (r) => `${r.toFixed(2)}R`;

// Карточка №4 работает в двух режимах, и выбирает их ЗНАК позиции (просьба
// оператора 03.09.2026): в минусе смотришь, где тебя высадит нянька (Floor + чип
// HARD/BE/TRAIL), в плюсе — сколько осталось до цели. Раньше остаток жил
// подстрокой в uPnL и на телефоне рвал карточку на три строки.
// Режим требует ЦЕЛИ: без tpPrice (её сняли, или поза без TP) остаётся Floor,
// даже когда позиция в плюсе — иначе карточка показала бы пустоту.
// Пик хода (MFE) в под-строке uPnL. Вернули 03.09.2026 по просьбе оператора: за
// пиком теперь ползёт биржевой пол трейла, и цифра, от которой он считается,
// должна быть на виду. Только пик — остаток до цели уехал на карточку цели,
// а R убран, чтобы строка не начала снова рвать карточку на телефоне.
// Пустая строка (а не undefined) намеренно: разметка слоёв остаётся одна и та
// же, и патч на месте просто меняет текст, не пересобирая карточку.
// ЗЕРКАЛЬНО ЗНАКУ ПОЗИЦИИ: в плюсе полезен пик (MFE) — за ним ползёт биржевой
// пол трейла. В минусе пик не к месту, там нужна худшая просадка (MAE, «dip»):
// видеть «−0.17R · peak +0.27%», сидя в минусе, сбивало (см. историю правки).
const extremeSubTxt = (s, upnl = 0) => {
  if (upnl < 0) {
    return s.maePct != null ? `dip −${Math.abs(s.maePct).toFixed(2)}%` : "";
  }
  return s.peakPct != null && s.peakPct > 0 ? `peak +${s.peakPct.toFixed(2)}%` : "";
};

const isTargetMode = (s, upnl) =>
  upnl > 0 && s.tpPrice != null && s.toTargetR != null && s.toTargetR > 0;

// Смена режима — это ДРУГАЯ разметка ячейки, то есть пере-сборка карточки. У
// позиции, висящей на нуле, uPnL дрожит в обе стороны каждый кадр, и без
// гистерезиса карточка пересобиралась бы по нескольку раз в минуту, срывая
// transition заливки. Поэтому у нуля держим ПРЕДЫДУЩИЙ режим, пока uPnL не
// уйдёт от нуля дальше 2% риска (без стопа — дальше полуцента).
const _cardMode = new Map(); // coin → true(цель) | false(пол)
function targetModeFor(p, s) {
  const raw = isTargetMode(s, p.unrealizedPnl);
  const band = s.riskUsd != null && s.riskUsd > 0 ? 0.02 * s.riskUsd : 0.005;
  const prev = _cardMode.get(p.coin);
  const inBand = prev !== undefined && Math.abs(p.unrealizedPnl ?? 0) < band;
  // Цели нет (сняли / поза без TP) — режим цели невозможен даже по инерции.
  const mode = s.tpPrice == null ? false : inBand ? prev : raw;
  _cardMode.set(p.coin, mode);
  return mode;
}

// Тултип карточки цели: остаток в % хода и в долларах (R виден инлайном).
const targetTip = (s, p) => {
  const usd =
    p.sizeUsd != null && s.toTargetPct != null
      ? (s.toTargetPct / 100) * p.sizeUsd
      : null;
  const pct = s.toTargetPct != null ? `${s.toTargetPct.toFixed(2)}%` : "—";
  return `To target: ${pct}${usd != null ? ` (+$${usd.toFixed(2)})` : ""}`;
};

// Текущая монета бот-позиции — чтобы понимать, патчить на месте или пере-строить.
let _posCoin = null;
let _lastNetVal = null;
// coin → последний uPnL ручной позы (для «пыха» при кроссе нуля на месте).
const _manualLastUpnl = new Map();
let _manualKeys = "";

export function renderHeader(status) {
  // Секция-хост только на дашборде; на /strategies.html её нет → no-op.
  if (!document.getElementById("uptime-val")) return;
  // HL 2026-05-23 unified mode: equity = spot.total + perp.uPnL,
  // available = spot.total - spot.hold. Раньше показывали отдельный
  // wallet-total / perp/spot breakdown — после миграции это один и
  // тот же пул, разбивка потеряла смысл.
  updateAnimatedNumber("equity-value", fmtUsd(status.equity));
  // Запоминаем equity как базу для относительной дневной цели (setDailyPnl
  // приходит отдельным поллингом, без equity). Держим последнее известное.
  if (status.equity > 0) _lastEquity = status.equity;

  const profit = status.sessionProfit;
  const deltaEl = document.getElementById("equity-delta");
  if (status.sessionStartEquity > 0) {
    const pct = (profit / status.sessionStartEquity) * 100;
    deltaEl.textContent = `${profit >= 0 ? "+" : "-"}${fmtUsd(Math.abs(profit))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) session`;
    deltaEl.className = `delta ${profit >= 0 ? "positive" : "negative"}`;
  }
  document.getElementById("uptime-val").textContent =
    `Uptime: ${formatUptime(status.uptimeMin)}`;
  document.getElementById("available-val").textContent =
    `Available: ${fmtUsd(status.available)}`;

  const wtEl = document.getElementById("wallet-total-val");
  if (wtEl) wtEl.style.display = "none";

  // Дневной стоп-лосс — backend-правда по fills (см. dailyRisk.js). Меняет
  // бейдж «Today» на «стоп: входы закрыты» и красит карточку.
  const halted = !!status.dailyRisk?.halted;
  if (halted !== _dailyRiskHalted) {
    _dailyRiskHalted = halted;
    renderDailyBadge();
  }
}

// ── Daily goal / circuit-breaker ──────────────────────────────────────────
// Бейдж в шапке Active Position: Today's P/L + достигнута ли дневная цель.
// Цель/стоп — ОТНОСИТЕЛЬНЫЕ (% от equity), чтобы масштабироваться с депо: $2
// на $42 ≈ 5%, но на $100 те же $2 — это лишь 2% (депо мелкое и растёт, см.
// account_size_vs_influencer). При дневном минусе ≤ DAILY_STOP_PCT вся карточка
// #sec-position краснеет (.daily-danger). Это не замок (кошелёк не заблокировать)
// — громкий нудж. $-пороги — фолбэк, пока equity ещё не пришёл (первый кадр WS).
const DAILY_GOAL_PCT = 5; // ≥ этого % от equity за день → goal reached
const DAILY_STOP_PCT = -10; // ≤ этого % → circuit-breaker (краснеет карточка)
const DAILY_GOAL_USD = 2; // фолбэк-порог в $ до прихода equity
const DAILY_STOP_USD = -5; // фолбэк-порог в $ до прихода equity
// Последний известный equity (ставит renderHeader по WS) — база для % цели.
let _lastEquity = null;

// SVG-иконки бейджа (наследуют цвет через currentColor). Без эмодзи.
const _ICON_GOAL = `<svg viewBox="0 0 16 16" width="12" height="12" style="vertical-align:-2px;margin-right:3px" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const _ICON_STOP = `<svg viewBox="0 0 16 16" width="12" height="12" style="vertical-align:-2px;margin-right:3px" aria-hidden="true"><path d="M5.3 1.8H10.7L14.2 5.3V10.7L10.7 14.2H5.3L1.8 10.7V5.3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 4.9v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="10.9" r=".85" fill="currentColor"/></svg>`;

// Последние известные куски дневного бейджа: realized+fees ставит setDailyPnl
// (поллинг pnl-summary), halted — renderHeader (WS status, backend-правда по
// fills). Бейдж собирается из всех кусков, кто бы ни обновился последним.
let _lastDailyPnl = null;
let _lastFees = null;      // { today, d7 }
let _dailyRiskHalted = false;

function renderDailyBadge() {
  const badge = document.getElementById("daily-goal-badge");
  const sec = document.getElementById("sec-position");
  if (!badge || !sec || _lastDailyPnl == null) return; // не на этой странице / рано
  const v = _lastDailyPnl;
  // Относительная цель: % дневного realized от equity. Пока equity не пришёл
  // (первый кадр WS) — фолбэк на $-пороги, чтобы бейдж не врал в первые секунды.
  const pct = _lastEquity && _lastEquity > 0 ? (v / _lastEquity) * 100 : null;
  const danger =
    _dailyRiskHalted ||
    (pct != null ? pct <= DAILY_STOP_PCT : v <= DAILY_STOP_USD);
  const reached = pct != null ? pct >= DAILY_GOAL_PCT : v >= DAILY_GOAL_USD;
  const valStr = `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
  // Показываем и $, и % (когда есть база) — $ = факт, % = прогресс к цели.
  const pctStr =
    pct != null ? ` · ${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%` : "";
  // Комиссии — пожиратель №1 (аудит 02.07: $57 из $83 минуса за 60д). Держим
  // цену оборота перед глазами: сегодня в бейдже, неделя — в tooltip.
  const feeStr =
    _lastFees && _lastFees.today > 0.005
      ? ` · fees $${_lastFees.today.toFixed(2)}`
      : "";
  const icon = danger ? _ICON_STOP : reached ? _ICON_GOAL : "";
  const label = _dailyRiskHalted
    ? "stopped: entries closed"
    : danger ? "stop" : reached ? "goal" : `goal ${DAILY_GOAL_PCT}%`;
  badge.innerHTML = `Today ${valStr}${pctStr}${feeStr} · ${icon}${label}`;
  if (_lastFees != null) {
    badge.title = `Fees: today $${(_lastFees.today ?? 0).toFixed(2)} · 7d $${(_lastFees.d7 ?? 0).toFixed(2)}`;
  }
  badge.hidden = false;
  badge.classList.toggle("is-pos", reached && !danger);
  badge.classList.toggle("is-neg", v < 0);
  sec.classList.toggle("daily-danger", danger);
  _moodToday = v;
  refreshSectionMood();
}

/**
 * Прокинуть дневной realized-PnL + fees (зовётся из tick, источник
 * /api/pnl-summary). Обновляет бейдж + красит карточку.
 * @param {number} realized — net realized PnL за сегодня
 * @param {{today:number, d7:number}|null} [fees] — комиссии сегодня / за 7д
 */
export function setDailyPnl(realized, fees = null) {
  _lastDailyPnl = realized ?? 0;
  if (fees) _lastFees = fees;
  renderDailyBadge();
}

export function renderPosition(pos) {
  const container = document.getElementById("position-container");
  if (!container) return; // нет секции (напр. /strategies.html)
  if (!pos) {
    _lastNetSign = null; // позиция закрыта — сбрасываем трекеры
    _lastNetVal = null;
    _posCoin = null;
    // Бот idle — тело пустое (ручные/adopt позы рендерятся ниже своей секцией).
    // Дневной статус живёт в бейдже шапки (setDailyPnl), карточка не пустует.
    container.innerHTML = "";
    return;
  }
  const side = (pos.side || "SHORT").toUpperCase();
  // Глубинная заливка главной Net(Mkt)-карточки: насыщенность растёт по мере
  // приближения к 2R / стопу (есть стоп → бот ведёт позицию).
  const tint = riskTint({
    entry: pos.entryPrice,
    now: pos.currentPrice,
    side,
    stopPrice: pos.bot?.stopPrice,
    sizeUsd: pos.sizeUsd,
    beArmPct: pos.bot?.beArmPct,
    beArmed: pos.bot?.beArmed,
    trailArmPct: pos.bot?.trailArmPct,
    trailArmed: pos.bot?.trailArmed,
    tpPrice: pos.bot?.tpPrice,
    peakPct: pos.bot?.peakPct,
    maePct: pos.bot?.maePct,
  });
  const pnl = pos.currentPnl;
  const netSign = pnl && pnl.netMarket >= 0 ? "pos" : "neg";
  const primaryEl = document.getElementById("pos-primary");

  // ── Патч НА МЕСТЕ: та же монета и узел уже в DOM → не пересоздаём, а двигаем
  // --rb-now / цвет / значения на существующем элементе, чтобы CSS-transition
  // реально проиграл (иначе ползунок и цвет «телепортируются»).
  if (pnl && _posCoin === pos.coin && primaryEl) {
    const flip = _lastNetSign && _lastNetSign !== netSign;
    applyTint(primaryEl, tint, netSign);
    setPnlUsd(primaryEl, pnl.netMarket);
    setUsd(document.getElementById("pos-netmkr"), pnl.netMaker);
    setUsd(document.getElementById("pos-price"), pnl.price);
    setUsd(document.getElementById("pos-funding"), pnl.funding);
    const apyHeld = document.getElementById("pos-apyheld");
    if (apyHeld)
      apyHeld.textContent = `${fmtPct(pos.entryApy)} · ${pos.heldHours.toFixed(1)}h`;
    if (flip) flashCross(primaryEl);
    _lastNetSign = netSign;
    _lastNetVal = pnl.netMarket;
    return;
  }

  // ── Полная пере-сборка (первый рендер / смена монеты). Ставим id, чтобы
  // дальше патчить на месте.
  const { cls: rbCls, attr: rbAttr } = tintAttrs(tint);
  let pnlBlock = "";
  if (pnl) {
    const cls = (v) => (v >= 0 ? "positive" : "negative");
    const sgn = (v) => (v >= 0 ? "+" : "−");
    const primaryCls = `grid-item grid-item-primary pnl-tint pnl-${netSign}${rbCls}`;
    const netInner = pnlLayers({
      label: `Net (Mkt) <span class="primary-tag">total</span>`,
      valueId: "pos-net",
      valueCls: cls(pnl.netMarket),
      valueText: `${sgn(pnl.netMarket)}$${Math.abs(pnl.netMarket).toFixed(4)}`,
    });
    pnlBlock = `
      <div class="data-grid" style="margin-top:0.75rem">
        <div id="pos-primary" class="${primaryCls}"${rbAttr}>${netInner}</div>
        <div class="grid-item"><div class="item-label">Net (Mkr)</div><div id="pos-netmkr" class="item-value ${cls(pnl.netMaker)}">${sgn(pnl.netMaker)}$${Math.abs(pnl.netMaker).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Price PnL</div><div id="pos-price" class="item-value ${cls(pnl.price)}">${sgn(pnl.price)}$${Math.abs(pnl.price).toFixed(4)}</div></div>
        <div class="grid-item"><div class="item-label">Funding</div><div id="pos-funding" class="item-value ${cls(pnl.funding)}">${sgn(pnl.funding)}$${Math.abs(pnl.funding).toFixed(4)}</div></div>
      </div>`;
  }
  const sideCls = side === "SHORT" ? "negative" : "positive";
  container.innerHTML = `
    <div class="data-grid">
      <div class="grid-item"><div class="item-label">Coin · Side</div><div class="item-value highlight">#${pos.coin} <span class="${sideCls}" style="font-size:11px; font-weight:700; padding:2px 6px; border-radius:4px; margin-left:4px;">${side}</span></div></div>
      <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(pos.sizeUsd)}</div></div>
      <div class="grid-item"><div class="item-label">Entry</div><div class="item-value">${fmtPrice(pos.entryPrice)}</div></div>
      <div class="grid-item"><div class="item-label">APY · Held</div><div id="pos-apyheld" class="item-value">${fmtPct(pos.entryApy)} · ${pos.heldHours.toFixed(1)}h</div></div>
    </div>${pnlBlock}`;
  _posCoin = pos.coin;
  _lastNetSign = netSign;
  _lastNetVal = pnl ? pnl.netMarket : null;
}

// ── Floor-таймер ─────────────────────────────────────────────────────────────
// При открытой позиции по Floor-карточке бежит светло-жёлтый фон (15-мин
// обратный отсчёт), после 15 мин — чип «🔔 открыта X». Привязка к p.entryTime.
// Наблюдение оператора «ровно 3 свечи 15m» в данных НЕ подтвердилось (бэктест 27.06:
// после 3 одинаковых разворот лишь 52–58%, «3» не выделена) → таймер = чекпоинт
// «перечитать график», а НЕ «ход кончился». 2026-06-28.
const FLOOR_TIMER_SEC = 15 * 60;
function openedMsOf(p) {
  const t = p?.entryTime;
  if (t == null) return null;
  // Строку без таймзоны (SQLite "YYYY-MM-DD HH:MM:SS") трактуем как UTC.
  let ms =
    typeof t === "number"
      ? t
      : Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
  if (!Number.isFinite(ms)) return null;
  if (ms < 1e12) ms *= 1000; // epoch-секунды → мс
  return ms;
}
// Часы открытой позиции MM:SS (после часа H:MM:SS). Тикают каждую секунду.
function fmtClock(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function ensureFloorTimerStyle() {
  if (document.getElementById("floor-timer-style")) return;
  const st = document.createElement("style");
  st.id = "floor-timer-style";
  st.textContent =
    "@keyframes floorTimerDeplete{from{transform:scaleX(1)}to{transform:scaleX(0)}}" +
    ".grid-item.floor-timed{position:relative;overflow:hidden}" +
    ".grid-item.floor-timed>*:not(.floor-timer-bg){position:relative;z-index:1}" +
    ".floor-timer-bg{position:absolute;inset:0;transform-origin:left center;" +
    "background:linear-gradient(90deg,rgba(234,179,8,0.22),rgba(234,179,8,0.06));" +
    "animation:floorTimerDeplete 900s linear forwards;pointer-events:none;z-index:0}" +
    ".floor-timer-chip{margin-left:6px;font-size:11px;font-family:var(--font-mono);color:var(--yellow,#eab308);font-weight:600}" +
    ".floor-timer-chip:empty{display:none}";
  document.head.appendChild(st);
}
let _floorTickStarted = false;
function startFloorTimerTick() {
  if (_floorTickStarted) return;
  _floorTickStarted = true;
  setInterval(() => {
    document.querySelectorAll(".floor-timer-chip[data-mtimer]").forEach((el) => {
      const ms = Number(el.getAttribute("data-mtimer"));
      if (!Number.isFinite(ms)) return;
      const sec = (Date.now() - ms) / 1000;
      el.textContent = sec >= FLOOR_TIMER_SEC ? fmtClock(sec) : "";
    });
  }, 1000);
}
// HTML-части Floor-ячейки для открытой позиции: {cls, bg, chip}.
function floorTimerParts(p) {
  const openedMs = openedMsOf(p);
  if (openedMs == null) return { cls: "", bg: "", chip: "" };
  const sec = (Date.now() - openedMs) / 1000;
  if (!(sec >= 0) || sec > 24 * 3600) return { cls: "", bg: "", chip: "" }; // санити
  const bg =
    sec < FLOOR_TIMER_SEC
      ? `<div class="floor-timer-bg" style="animation-delay:-${sec.toFixed(0)}s"></div>`
      : "";
  const chipTxt = sec >= FLOOR_TIMER_SEC ? fmtClock(sec) : "";
  return { cls: " floor-timed", bg, chip: `<span class="floor-timer-chip" data-mtimer="${openedMs}">${chipTxt}</span>` };
}

/**
 * Классы кнопки Close по тому, насколько сделка прошла в R.
 *
 * Шкала в R, а не в долларах: $1 на позиции с риском $1 и на позиции с риском
 * $10 — совершенно разные события, а окраска по абсолютному доллару врала бы
 * тем сильнее, чем больше поза. rMult уже считает manualStats.
 *
 * Без стопа (rMult=null) остаёмся нейтральными: не с чем соотносить.
 */
function closeBtnCls(s, p) {
  const r = s?.rMult;
  if (r == null || !Number.isFinite(r) || p?.unrealizedPnl == null) return "";
  const a = Math.abs(r);
  if (a < 0.15) return ""; // болтается около нуля — красить нечего
  const sign = r >= 0 ? "is-pos" : "is-neg";
  const level = a >= 1 ? "is-l3" : a >= 0.5 ? "is-l2" : "is-l1";
  return ` ${sign} ${level}`;
}

// ── Live-цена: поток allMids поверх 2-секундного статуса ─────────────────────
// Статус остаётся владельцем всего, кроме цены. Здесь только подменяем
// currentPrice на свежую и перерисовываем те карточки, чьи монеты дёрнулись.
let _liveList = [];
let _liveBound = false;

/** Позиция с самой свежей известной ценой. Нет живой — остаётся серверная. */
function withLivePrice(p) {
  const px = getLivePrice(p.coin);
  return px != null ? { ...p, currentPrice: px } : p;
}

function bindPriceStream() {
  if (_liveBound) return;
  _liveBound = true;
  startPriceStream();
  onPriceTick((changed) => {
    const container = document.getElementById("manual-positions-container");
    if (!container || !_liveList.length) return;
    for (const p of _liveList) {
      if (!changed.has(String(p.coin).toUpperCase())) continue;
      patchManualCard(container, withLivePrice(p));
    }
  });
}

/**
 * Патч одной карточки на месте. Зовётся из двух мест: из статус-пакета
 * (раз в 2с, весь набор цифр) и из live-тика цены (каждый кадр, только
 * то, что зависит от цены). Одна функция — чтобы эти два пути не начали
 * рисовать по-разному.
 */
function patchManualCard(container, p) {
  const card = container.querySelector(`[data-mcard="${CSS.escape(p.coin)}"]`);
  // Карточки ещё нет (пришёл тик до первой отрисовки) — просто ждём рендера.
  if (!card) return;
    const tint = riskTint({
      entry: p.entryPrice,
      now: p.currentPrice,
      side: p.side,
      stopPrice: p.bot?.stopPrice,
      sizeUsd: p.sizeUsd,
      beArmPct: p.bot?.beArmPct,
      beArmed: p.bot?.beArmed,
      trailArmPct: p.bot?.trailArmPct,
      trailArmed: p.bot?.trailArmed,
      tpPrice: p.bot?.tpPrice,
      peakPct: p.bot?.peakPct,
      maePct: p.bot?.maePct,
    });
    const sign = p.unrealizedPnl >= 0 ? "pos" : "neg";
    const cell = card.querySelector(".pnl-tint");
    applyTint(cell, tint, sign);
    setPnlUsd(cell, p.unrealizedPnl);
    const nowEl = card.querySelector("[data-mnow]");
    if (nowEl)
      nowEl.textContent = p.currentPrice != null ? fmtPrice(p.currentPrice) : "—";
    // Производные метрики двигаются каждый тик (now/peak/трейл) → патчим их же.
    const s = manualStats(p);
    // Окраска Close идёт за R, а R меняется каждый тик — иначе кнопка
    // застыла бы в цвете того момента, когда карточку отрисовали целиком.
    const closeBtn = card.querySelector("[data-posclose]");
    if (closeBtn && !closeBtn.classList.contains("is-armed")) {
      closeBtn.className = `pos-close-btn${closeBtnCls(s, p)}`;
    }
    const moveEl = card.querySelector("[data-mmove]");
    if (moveEl) {
      moveEl.textContent = s.movePct != null ? fmtMove(s.movePct) : "—";
      moveEl.classList.toggle("positive", s.movePct != null && s.movePct >= 0);
      moveEl.classList.toggle("negative", s.movePct != null && s.movePct < 0);
    }
    // Карточка цели: цена цели стоит на месте, а остаток до неё едет с ценой.
    const tgEl = card.querySelector("[data-mtarget]");
    if (tgEl && s.tpPrice != null) tgEl.textContent = fmtPrice(s.tpPrice);
    const tgRemEl = card.querySelector("[data-mtargetrem]");
    if (tgRemEl && s.toTargetR != null) {
      tgRemEl.textContent = fmtRemR(s.toTargetR);
      const cellEl = tgRemEl.closest(".grid-item");
      if (cellEl) cellEl.title = `${targetTip(s, p)} · Liquidation: ${p.liquidationPrice != null ? fmtPrice(p.liquidationPrice) : "—"}`;
    }
    // Экстремум живёт во всех трёх слоях (spacer/base/fill) → синхроним все,
    // иначе бело-залитая копия отстанет от цветной под краем заливки.
    const peakTxt = extremeSubTxt(s, p.unrealizedPnl);
    card.querySelectorAll(".pnl-sub").forEach((el) => { el.textContent = peakTxt; });
    const flEl = card.querySelector("[data-mfloor]");
    if (flEl && s.floorPrice != null) flEl.textContent = fmtPrice(s.floorPrice);
    const flPnlEl = card.querySelector("[data-mfloorpnl]");
    if (flPnlEl && s.floorPnl != null) {
      flPnlEl.textContent = fmtSignedUsd2(s.floorPnl);
      flPnlEl.classList.toggle("positive", s.floorPnl >= 0);
      flPnlEl.classList.toggle("negative", s.floorPnl < 0);
    }
    // Тип пола меняется на лету (stop→BE→trail, когда взводится храповик).
    const flBadge = card.querySelector("[data-mfloor]")
      ?.closest(".grid-item")?.querySelector(".fl-badge");
    const fb = FLOOR_BADGE[s.floorKind] || null;
    if (flBadge && fb) {
      flBadge.textContent = fb.txt;
      flBadge.className = `fl-badge ${fb.cls}`;
    }
    const prev = _manualLastUpnl.get(p.coin);
    const crossed =
      prev != null && prev >= 0 !== p.unrealizedPnl >= 0;
    if (crossed) flashCross(cell);
    _manualLastUpnl.set(p.coin, p.unrealizedPnl);
}

export function renderManualPositions(list) {
  const container = document.getElementById("manual-positions-container");
  if (!container) return;
  if (!Array.isArray(list) || list.length === 0) {
    container.innerHTML = "";
    _manualKeys = "";
    _manualLastUpnl.clear();
    _liveList = [];
    setWatchedCoins([]);
    return;
  }
  bindPriceStream();
  // Запоминаем ПОСЛЕДНИЙ серверный payload: тик цены перерисовывает карточку
  // из него же, подменив только currentPrice.
  _liveList = list;
  // Активы builder-DEX'ов подписываются наравне с криптой: bbo по `xyz:NOK`
  // отдаёт ~1 кадр/с — медленнее крипты (6-10/с), но вдвое быстрее статус-кадра.
  // Нормализация имени живёт в priceStream: префикс площадки обязан остаться
  // строчным, иначе поток молча пустой.
  setWatchedCoins(list.map((p) => p.coin));
  list = list.map(withLivePrice);
  ensureFloorTimerStyle();
  startFloorTimerTick();
  const cls = (v) => (v >= 0 ? "positive" : "negative");
  const sgn = (v) => (v >= 0 ? "+" : "−");

  // ── Патч НА МЕСТЕ: тот же набор монет → двигаем uPnL/цвет/ползунок на
  // существующих узлах (плавный transition ползунка), а не рвём innerHTML.
  // Ключ включает статус усыновления: иначе при adopt-флипе (false→true) или
  // смене причины «без стопа» бейдж застывал на до-adopt тексте — in-place ветка
  // обновляет только uPnL, но не бейдж (SPX висел «HANDS-OFF · MANUAL» без
  // зелёного ADOPTED, хотя нянька уже повесила стоп — 2026-06-18).
  const keys = list
    .map((p) => `${p.coin}:${p.adopted ? 1 : 0}:${p.adoptResyncing ? 1 : 0}:${p.adoptSkipReason ?? ""}:${p.builder ? 1 : 0}:${targetModeFor(p, manualStats(p)) ? "t" : "f"}`)
    .join("|");
  if (keys === _manualKeys) {
    for (const p of list) patchManualCard(container, p);
    return;
  }
  _manualKeys = keys;
  for (const p of list) _manualLastUpnl.set(p.coin, p.unrealizedPnl);
  const blocks = list
    .map((p) => {
      const sideCls = p.side === "SHORT" ? "negative" : "positive";
      const liq =
        p.liquidationPrice != null ? fmtPrice(p.liquidationPrice) : "—";
      const lev = p.leverage != null ? `${p.leverage}x` : "—";
      const cur = p.currentPrice != null ? fmtPrice(p.currentPrice) : "—";
      // Бот подхватил вход (adopt) → дописываем ADOPTED, чтобы было видно, что
      // на нём уже висит стоп+трейл няньки. Не подхватил → чистый HANDS-OFF.
      // Не усыновлена → показываем ПОЧЕМУ (если бэк знает причину), чтобы не
      // лезть в логи на сервере. Усыновлена → зелёный ADOPTED.
      // Позиция на builder-DEX'е (HIP-3): бот её не ведёт в принципе, поэтому
      // ни ADOPTED, ни «no stop: причина» тут не к месту — причина одна и она
      // структурная.
      const manualBadge = p.builder
        ? `${escapeHtml(String(p.dex || "builder").toUpperCase())} DEX · <span style="color:var(--red,#cf222e)">NOT BABYSAT</span>`
        : p.adoptResyncing
        ? `HANDS-OFF · MANUAL · <span style="color:var(--orange,#f59e0b)" title="Position side flipped — the bot closes the old DB row and re-adopts the position on the new side">RE-SYNCING ⟳</span>`
        : p.adopted
        ? `HANDS-OFF · MANUAL · <span style="color:var(--green,#22c55e)">ADOPTED</span>`
        : p.adoptSkipReason
          ? `HANDS-OFF · MANUAL · <span style="color:var(--red,#cf222e)">no stop: ${escapeHtml(p.adoptSkipReason)}</span>`
          : "HANDS-OFF · MANUAL";
      // Глубинная заливка карточки uPnL — только у усыновлённых (нянька повесила
      // стоп). У голого HANDS-OFF стопа нет → riskTint вернёт null, карточка
      // остаётся статичной (pnl-tint по знаку).
      const tint = riskTint({
        entry: p.entryPrice,
        now: p.currentPrice,
        side: p.side,
        stopPrice: p.bot?.stopPrice,
        sizeUsd: p.sizeUsd,
        beArmPct: p.bot?.beArmPct,
        beArmed: p.bot?.beArmed,
        trailArmPct: p.bot?.trailArmPct,
        trailArmed: p.bot?.trailArmed,
        tpPrice: p.bot?.tpPrice,
        peakPct: p.bot?.peakPct,
        maePct: p.bot?.maePct,
      });
      const { cls: rbCls, attr: rbAttr } = tintAttrs(tint);
      const s = manualStats(p);
      // Size → риск на кону до жёсткого стопа ($), инлайном на той же строке.
      // Нет стопа → ничего (риск не ограничен; само-сигналит отсутствием цифры).
      const riskInline =
        s.riskUsd != null
          ? ` <span class="grid-inline negative">risk −$${s.riskUsd.toFixed(2)}</span>`
          : "";
      // Entry·Now → дистанция к входу в СТРОКЕ ЛЕЙБЛА (две цены sub-cent монеты
      // длинные → инлайн у значения переносился на 3-ю строку). Цвет по знаку хода.
      const moveInline =
        s.movePct != null
          ? ` <span class="grid-inline ${s.movePct >= 0 ? "positive" : "negative"}" data-mmove>${fmtMove(s.movePct)}</span>`
          : "";
      // Четвёртая карточка: в плюсе — цель, в минусе — пол выхода (см.
      // isTargetMode). Ликвидацию уводим в title в обоих режимах. Нет ни цели,
      // ни пола (не усыновлена) → fallback на Liq.
      const fb = FLOOR_BADGE[s.floorKind] || null;
      const ft = floorTimerParts(p);
      const floorCell = targetModeFor(p, s)
        ? `<div class="grid-item${ft.cls}" title="${targetTip(s, p)} · Liquidation: ${liq}">${ft.bg}
               <div class="item-label" style="display:flex;justify-content:space-between;align-items:center"><span>To target</span>${ft.chip}</div>
               <div class="item-value"><span data-mtarget>${fmtPrice(s.tpPrice)}</span><span class="grid-inline positive" data-mtargetrem>${fmtRemR(s.toTargetR)}</span></div>
             </div>`
        : s.floorPrice != null
          ? `<div class="grid-item${ft.cls}" title="Liquidation: ${liq}">${ft.bg}
               <div class="item-label" style="display:flex;justify-content:space-between;align-items:center"><span>Floor${fb ? ` <span class="fl-badge ${fb.cls}">${fb.txt}</span>` : ""}</span>${ft.chip}</div>
               <div class="item-value"><span data-mfloor>${fmtPrice(s.floorPrice)}</span><span class="grid-inline ${s.floorPnl >= 0 ? "positive" : "negative"}" data-mfloorpnl>${s.floorPnl != null ? fmtSignedUsd2(s.floorPnl) : ""}</span></div>
             </div>`
          : `<div class="grid-item${ft.cls}" title="Liquidation: ${liq}">${ft.bg}<div class="item-label" style="display:flex;justify-content:space-between;align-items:center"><span>Liq</span>${ft.chip}</div><div class="item-value">${liq}</div></div>`;
      return `
      <div data-mcard="${escapeHtml(p.coin)}" style="margin-top:0.75rem; padding:0.75rem; border:1px dashed var(--border); border-radius:8px;">
        <div class="mcard-head">
          <span class="mcard-badge">${manualBadge}</span>
          <span class="item-value highlight">#${p.coin}</span>
          <span class="item-value ${sideCls}">${p.side}</span>
          <!-- Закрытие живёт ЗДЕСЬ, а не в модалке: на карточке цена уже
               обновляется в реальном времени, а пока откроешь окно и
               переключишь вкладку — рынок уезжает. Долей нет намеренно, оператор
               ими не пользуется: одна кнопка = закрыть всё по рынку. -->
          ${
            // На builder-DEX'ах executor закрыть не может (asset-id другой
            // площадки) — кнопки нет, чтобы она не врала работоспособностью.
            p.builder
              ? '<span class="grid-inline" title="Close it on the exchange by hand — the bot cannot reach builder-DEX assets">close by hand</span>'
              : `<button type="button" class="pos-close-btn${closeBtnCls(s, p)}" data-posclose="${escapeHtml(p.coin)}"
                  title="Close the whole position at market (taker 4.32 bp, no builder fee)"><span>Close</span></button>`
          }
        </div>
        <div class="data-grid">
          <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(p.sizeUsd)} · ${lev}${riskInline}</div></div>
          <div class="grid-item"><div class="item-label">Entry · Now${moveInline}</div><div class="item-value">${fmtPrice(p.entryPrice)} · <span data-mnow>${cur}</span></div></div>
          <div class="grid-item pnl-tint pnl-${p.unrealizedPnl >= 0 ? "pos" : "neg"}${rbCls}"${rbAttr}>${pnlLayers({ label: "uPnL", valueCls: cls(p.unrealizedPnl), valueText: `${sgn(p.unrealizedPnl)}$${Math.abs(p.unrealizedPnl).toFixed(4)}`, subText: extremeSubTxt(s, p.unrealizedPnl) })}</div>
          ${floorCell}
        </div>
      </div>`;
    })
    .join("");
  container.innerHTML = blocks;
}

export function renderBans(status) {
  // Compact strip над Near Misses: показываем только если есть активные баны.
  const strip = document.getElementById("bans-strip");
  if (!strip) return;
  if (!status.runtimeBans?.length) {
    strip.innerHTML = "";
    strip.classList.remove("bans-strip");
    return;
  }
  strip.classList.add("bans-strip");
  strip.innerHTML =
    '<div style="font-size:10px; color:var(--text-muted,#888); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">Runtime bans</div>' +
    status.runtimeBans
      .map(
        (c) =>
          `<div style="display:inline-block; background:rgba(239,68,68,0.1); color:var(--red); border:1px solid rgba(239,68,68,0.2); padding:3px 8px; border-radius:5px; font-size:10px; font-family:var(--font-mono); font-weight:600; margin:0 6px 4px 0;">#${c}</div>`,
      )
      .join("");
}
