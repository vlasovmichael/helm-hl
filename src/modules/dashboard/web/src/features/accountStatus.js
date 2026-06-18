// ─────────────────────────────────────────────────
//  Live account/position статус (из WS status-payload).
//  · renderHeader — equity (odometer) + session-delta + uptime + available.
//  · renderPosition — активная позиция бота (single slot) + P&L breakdown.
//  · renderManualPositions — ручные HANDS-OFF позиции (+ ADOPTED-бейдж).
//  · renderBans — strip активных runtime-банов.
//  Самодостаточный: только DOM + форматтеры. updateAnimatedNumber (odometer)
//  приватный, нужен только хедеру.
// ─────────────────────────────────────────────────

import { fmtUsd, fmtPrice, fmtPct, formatUptime, escapeHtml } from "../utils/format.js";
import { riskTint } from "../utils/riskBar.js";

// Доп. классы + inline-стиль для глубинной заливки PnL-карточки.
// tint = riskTint(...) | null. Возвращает { cls, attr } для подстановки в HTML.
function tintAttrs(tint) {
  if (!tint) return { cls: "", attr: "" };
  const cls = ` rb-depth rb-${tint.phase}${tint.hot ? " rb-hot" : ""}`;
  const attr = ` style="--rb-now:${tint.now.toFixed(3)}"${tint.tip ? ` title="${tint.tip}"` : ""}`;
  return { cls, attr };
}

const lastAnimatedValues = new Map();
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
  el.classList.remove("rb-depth", "rb-stop", "rb-arm", "rb-profit", "rb-hot");
  if (tint) {
    el.classList.add("rb-depth", `rb-${tint.phase}`);
    if (tint.hot) el.classList.add("rb-hot");
    el.style.setProperty("--rb-now", tint.now.toFixed(3));
    if (tint.tip) el.title = tint.tip;
    else el.removeAttribute("title");
  } else {
    el.style.removeProperty("--rb-now");
    el.removeAttribute("title");
  }
}

// Обновить $-значение + знаковый класс ячейки на месте.
function setUsd(el, v) {
  if (!el) return;
  el.textContent = `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(4)}`;
  el.classList.toggle("positive", v >= 0);
  el.classList.toggle("negative", v < 0);
}

// Текущая монета бот-позиции — чтобы понимать, патчить на месте или пере-строить.
let _posCoin = null;
let _lastNetVal = null;
// coin → последний uPnL ручной позы (для «пыха» при кроссе нуля на месте).
const _manualLastUpnl = new Map();
let _manualKeys = "";

// Odometer-анимация числа: крутим только изменившиеся цифры на реальную дельту.
function updateAnimatedNumber(elId, newValueStr) {
  const el = document.getElementById(elId);
  if (!el) return;
  const prev = lastAnimatedValues.get(elId) || "";
  if (prev === newValueStr) return;

  const oldStr = prev || newValueStr;
  lastAnimatedValues.set(elId, newValueStr);

  el.innerHTML = "";
  const maxLength = Math.max(oldStr.length, newValueStr.length);
  const oldPadded = oldStr.padStart(maxLength, " ");
  const newPadded = newValueStr.padStart(maxLength, " ");

  for (let i = 0; i < maxLength; i++) {
    const charOld = oldPadded[i];
    const charNew = newPadded[i];

    if (charOld === charNew) {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    } else if (/[0-9]/.test(charNew)) {
      const reel = document.createElement("div");
      reel.className = "digit-reel";
      const startDigit = /[0-9]/.test(charOld) ? Number(charOld) : 0;
      const endDigit = Number(charNew);
      // Odometer: только реальная дельта (1→2 = один шаг, не полный оборот).
      const totalSteps = (endDigit - startDigit + 10) % 10;
      const frames = [];
      for (let k = 0; k <= totalSteps; k++) {
        frames.push(String((startDigit + k) % 10));
      }
      frames.forEach((d) => {
        const s = document.createElement("span");
        s.textContent = d;
        reel.appendChild(s);
      });
      el.appendChild(reel);
      requestAnimationFrame(() => {
        reel.style.transform = `translateY(-${totalSteps * 1.1}em)`;
      });
    } else {
      const s = document.createElement("span");
      s.textContent = charNew;
      el.appendChild(s);
    }
  }
}

export function renderHeader(status) {
  // Секция-хост только на дашборде; на /strategies.html её нет → no-op.
  if (!document.getElementById("uptime-val")) return;
  // HL 2026-05-23 unified mode: equity = spot.total + perp.uPnL,
  // available = spot.total - spot.hold. Раньше показывали отдельный
  // wallet-total / perp/spot breakdown — после миграции это один и
  // тот же пул, разбивка потеряла смысл.
  updateAnimatedNumber("equity-value", fmtUsd(status.equity));

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
}

export function renderPosition(pos) {
  const container = document.getElementById("position-container");
  if (!container) return; // нет секции (напр. /strategies.html)
  if (!pos) {
    _lastNetSign = null; // позиция закрыта — сбрасываем трекеры
    _lastNetVal = null;
    _posCoin = null;
    container.innerHTML =
      '<div class="empty-state">No active positions — bot is IDLE</div>';
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
    tpPrice: pos.bot?.tpPrice,
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
    setUsd(document.getElementById("pos-net"), pnl.netMarket);
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
    pnlBlock = `
      <div class="data-grid" style="margin-top:0.75rem">
        <div id="pos-primary" class="${primaryCls}"${rbAttr}><div class="item-label">Net (Mkt) <span class="primary-tag">total</span></div><div id="pos-net" class="item-value ${cls(pnl.netMarket)}">${sgn(pnl.netMarket)}$${Math.abs(pnl.netMarket).toFixed(4)}</div></div>
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

export function renderManualPositions(list) {
  const container = document.getElementById("manual-positions-container");
  if (!container) return;
  if (!Array.isArray(list) || list.length === 0) {
    container.innerHTML = "";
    _manualKeys = "";
    _manualLastUpnl.clear();
    return;
  }
  const cls = (v) => (v >= 0 ? "positive" : "negative");
  const sgn = (v) => (v >= 0 ? "+" : "−");

  // ── Патч НА МЕСТЕ: тот же набор монет → двигаем uPnL/цвет/ползунок на
  // существующих узлах (плавный transition ползунка), а не рвём innerHTML.
  // Ключ включает статус усыновления: иначе при adopt-флипе (false→true) или
  // смене причины «без стопа» бейдж застывал на до-adopt тексте — in-place ветка
  // обновляет только uPnL, но не бейдж (SPX висел «HANDS-OFF · MANUAL» без
  // зелёного ADOPTED, хотя нянька уже повесила стоп — 2026-06-18).
  const keys = list
    .map((p) => `${p.coin}:${p.adopted ? 1 : 0}:${p.adoptSkipReason ?? ""}`)
    .join("|");
  if (keys === _manualKeys) {
    for (const p of list) {
      const card = container.querySelector(
        `[data-mcard="${CSS.escape(p.coin)}"]`,
      );
      if (!card) continue;
      const tint = riskTint({
        entry: p.entryPrice,
        now: p.currentPrice,
        side: p.side,
        stopPrice: p.bot?.stopPrice,
        sizeUsd: p.sizeUsd,
        beArmPct: p.bot?.beArmPct,
        beArmed: p.bot?.beArmed,
        tpPrice: p.bot?.tpPrice,
      });
      const sign = p.unrealizedPnl >= 0 ? "pos" : "neg";
      const cell = card.querySelector(".pnl-tint");
      applyTint(cell, tint, sign);
      setUsd(cell?.querySelector(".item-value"), p.unrealizedPnl);
      const nowEl = card.querySelector("[data-mnow]");
      if (nowEl)
        nowEl.textContent = `${fmtPrice(p.entryPrice)} · ${p.currentPrice != null ? fmtPrice(p.currentPrice) : "—"}`;
      const prev = _manualLastUpnl.get(p.coin);
      const crossed =
        prev != null && prev >= 0 !== p.unrealizedPnl >= 0;
      if (crossed) flashCross(cell);
      _manualLastUpnl.set(p.coin, p.unrealizedPnl);
    }
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
      const manualBadge = p.adopted
        ? `HANDS-OFF · MANUAL · <span style="color:var(--green,#22c55e)">ADOPTED</span>`
        : p.adoptSkipReason
          ? `HANDS-OFF · MANUAL · <span style="color:var(--red,#cf222e)">без стопа: ${escapeHtml(p.adoptSkipReason)}</span>`
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
        tpPrice: p.bot?.tpPrice,
      });
      const { cls: rbCls, attr: rbAttr } = tintAttrs(tint);
      return `
      <div data-mcard="${escapeHtml(p.coin)}" style="margin-top:0.75rem; padding:0.75rem; border:1px dashed var(--border); border-radius:8px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:0.5rem;">
          <span style="background:rgba(234,179,8,0.12); color:var(--yellow,#eab308); border:1px solid rgba(234,179,8,0.3); padding:2px 8px; border-radius:6px; font-size:11px; font-family:var(--font-mono); font-weight:700;">${manualBadge}</span>
          <span class="item-value highlight">#${p.coin}</span>
          <span class="item-value ${sideCls}">${p.side}</span>
        </div>
        <div class="data-grid">
          <div class="grid-item"><div class="item-label">Size</div><div class="item-value">${fmtUsd(p.sizeUsd)} · ${lev}</div></div>
          <div class="grid-item"><div class="item-label">Entry · Now</div><div class="item-value" data-mnow>${fmtPrice(p.entryPrice)} · ${cur}</div></div>
          <div class="grid-item pnl-tint pnl-${p.unrealizedPnl >= 0 ? "pos" : "neg"}${rbCls}"${rbAttr}><div class="item-label">uPnL</div><div class="item-value ${cls(p.unrealizedPnl)}">${sgn(p.unrealizedPnl)}$${Math.abs(p.unrealizedPnl).toFixed(4)}</div></div>
          <div class="grid-item"><div class="item-label">Liq</div><div class="item-value">${liq}</div></div>
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
