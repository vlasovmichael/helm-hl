// ─────────────────────────────────────────────────
//  Levels chart — свечи, зоны и позиция в духе TradingView.
//  Зоны, тонкий объём и коробка — примитивы серии: рисуются на холсте графика
//  под свечами и двигаются с ним в одном кадре. Цвета — токены темы.
// ─────────────────────────────────────────────────

import { fmtPx } from "../features/levelPlan.js";

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Пустые бары справа от последней свечи: в них стоит коробка плана.
const FUTURE_BARS = 34;
const BOX_BARS = 26;
const VISIBLE_BARS = 160;
const HIT_PX = 5; // допуск клика по тонкой зоне
const LABEL_ROW = 12; // высота строки имени зоны
const LEGEND_H = 30; // строка легенды сверху панели
const PILL_H = 20;
const PILL_PAD = 8;
const PILL_GAP = 4;
const ANIM_MS = 320;

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function palette() {
  return {
    bg: cssVar("--card-bg") || "#ffffff",
    text: cssVar("--text-secondary") || "#59636e",
    strong: cssVar("--text-primary") || "#1f2328",
    grid: cssVar("--hairline") || "#eaeef2",
    border: cssVar("--border") || "#d1d9e0",
    up: cssVar("--pnl-up") || "#0ecb81",
    down: cssVar("--pnl-down") || "#f6465d",
    accent: cssVar("--accent") || "#0969da",
    font: cssVar("--font-sans") || "sans-serif",
    mono: cssVar("--font-mono") || "monospace",
  };
}

/** Цвет токена с прозрачностью: токены бывают и hex, и rgba. */
export function withAlpha(color, a) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(color);
  return rgb ? `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${a})` : color;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Подписи оси времени по местным часам, как у TV: год, месяц, число, часы. */
export function tickLabel(time, type) {
  const d = new Date(time * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return MONTHS[d.getMonth()];
  if (type === 2) return String(d.getDate());
  return hhmm(d);
}

/** Подпись перекрестия: «Fri 25 Sep '26 14:00». */
export function crosshairLabel(time) {
  const d = new Date(time * 1000);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)} ${hhmm(d)}`;
}

let chart = null;
let candles = null;
let layer = null;
let host = null;
let legend = null;
let bars = [];
let meta = { coin: "", tf: "" };
let onPick = () => {};

// ── Анимация ─────────────────────────────────────
// Коробка перетекает от старых цен к новым, зоны проявляются после загрузки.
const anim = { box: null, zonesAt: 0, raf: 0 };

function tick() {
  layer?.redraw();
  const now = performance.now();
  const busy = (anim.box && now - anim.box.at < ANIM_MS) || now - anim.zonesAt < ANIM_MS;
  anim.raf = busy ? requestAnimationFrame(tick) : 0;
}

function kick() {
  if (!anim.raf) anim.raf = requestAnimationFrame(tick);
}

const progress = (at) => (reduceMotion() ? 1 : easeOut(Math.min(1, (performance.now() - at) / ANIM_MS)));

/** Цены коробки в текущем кадре: между прежним планом и новым. */
function boxPrices() {
  const b = anim.box;
  if (!b) return null;
  const k = progress(b.at);
  const mix = (key) => b.from[key] + (b.to[key] - b.from[key]) * k;
  return { entry: mix("entry"), stop: mix("stop"), target: mix("target"), fade: b.fadeIn ? k : 1 };
}

// ── Геометрия ────────────────────────────────────

/** Зона начинается с первой свечи, которая в неё зашла. */
function firstTouch(z) {
  const i = bars.findIndex((b) => b.high >= z.lo && b.low <= z.hi);
  return i < 0 ? 0 : i;
}

function paneWidth() {
  return chart?.timeScale().width() ?? 0;
}

function zoneRect(z) {
  const top = candles.priceToCoordinate(z.hi);
  const bottom = candles.priceToCoordinate(z.lo);
  if (top == null || bottom == null) return null;
  const left = Math.max(0, chart.timeScale().logicalToCoordinate(firstTouch(z)) ?? 0);
  return { left, right: paneWidth(), top, bottom: Math.max(bottom, top + 2) };
}

function zoneAt(point) {
  for (const z of layer.scene.zones) {
    const r = zoneRect(z);
    if (r && point.y >= r.top - HIT_PX && point.y <= r.bottom + HIT_PX && point.x >= r.left) return z;
  }
  return null;
}

function boxRect(p) {
  const ts = chart.timeScale();
  const x0 = ts.logicalToCoordinate(bars.length - 1);
  const x1 = ts.logicalToCoordinate(bars.length - 1 + BOX_BARS);
  const ye = candles.priceToCoordinate(p.entry);
  const ys = candles.priceToCoordinate(p.stop);
  const yt = candles.priceToCoordinate(p.target);
  if ([x0, x1, ye, ys, yt].some((v) => v == null)) return null;
  return { x0, x1: Math.min(x1, paneWidth() - 1), ye, ys, yt };
}

// ── Рисование ────────────────────────────────────

const tierAlpha = (s) => (s >= 8 ? 0.2 : s >= 4 ? 0.13 : 0.07);

function hline(ctx, x0, x1, y, color, dash = []) {
  ctx.beginPath();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const yy = Math.round(y) + 0.5;
  ctx.moveTo(x0, yy);
  ctx.lineTo(x1, yy);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawZones(ctx, c) {
  const { zones, thin, plan } = layer.scene;
  const fade = progress(anim.zonesAt);
  ctx.globalAlpha = fade;
  for (const t of thin) {
    const top = candles.priceToCoordinate(t.hi);
    const bottom = candles.priceToCoordinate(t.lo);
    if (top == null || bottom == null) continue;
    const left = Math.max(0, chart.timeScale().logicalToCoordinate(0) ?? 0);
    const right = paneWidth();
    ctx.fillStyle = withAlpha(c.accent, 0.05);
    ctx.fillRect(left, top, right - left, bottom - top);
    hline(ctx, left, right, top, withAlpha(c.accent, 0.45), [4, 4]);
    hline(ctx, left, right, bottom, withAlpha(c.accent, 0.45), [4, 4]);
  }
  for (const z of zones) {
    const r = zoneRect(z);
    if (!r) continue;
    const color = z.name.startsWith("R") ? c.down : c.up;
    const on = plan && (plan.stopZone === z || plan.targetZone === z);
    ctx.fillStyle = withAlpha(color, tierAlpha(z.strength));
    ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
    hline(ctx, r.left, r.right, r.top, withAlpha(color, on ? 0.9 : 0.4));
    hline(ctx, r.left, r.right, r.bottom, withAlpha(color, on ? 0.9 : 0.4));
  }
  ctx.globalAlpha = 1;
}

function drawBox(ctx, c) {
  const p = boxPrices();
  if (!p) return;
  const r = boxRect(p);
  if (!r || r.x1 <= r.x0) return;
  ctx.globalAlpha = p.fade;
  const band = (ya, yb, color) => {
    ctx.fillStyle = withAlpha(color, 0.2);
    ctx.fillRect(r.x0, Math.min(ya, yb), r.x1 - r.x0, Math.abs(yb - ya));
  };
  band(r.ye, r.yt, c.up);
  band(r.ye, r.ys, c.down);
  hline(ctx, r.x0, r.x1, r.ye, withAlpha(c.strong, 0.55));
  hline(ctx, r.x0, r.x1, r.yt, withAlpha(c.up, 0.8));
  hline(ctx, r.x0, r.x1, r.ys, withAlpha(c.down, 0.8));
  ctx.globalAlpha = 1;
}

/** Текст с обводкой цветом фона: читается поверх свечей. */
function haloText(ctx, c, text, x, y, color) {
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = c.bg;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Имена зон над их левым краем; близкие зоны встают в строку, а не друг на друга. */
function drawZoneNames(ctx, c) {
  ctx.globalAlpha = progress(anim.zonesAt);
  ctx.font = `600 11px ${c.font}`;
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  const placed = [];
  const named = layer.scene.zones
    .map((z) => ({ z, r: zoneRect(z) }))
    .filter((n) => n.r)
    .sort((a, b) => a.r.top - b.r.top);
  for (const { z, r } of named) {
    let x = r.left + 6;
    for (const p of placed) if (Math.abs(p.y - r.top) < LABEL_ROW && x < p.x1 + 6) x = p.x1 + 6;
    const w = ctx.measureText(z.name).width;
    placed.push({ y: r.top, x1: x + w });
    haloText(ctx, c, z.name, x, r.top - 3, z.name.startsWith("R") ? c.down : c.up);
  }
  ctx.font = `500 11px ${c.font}`;
  ctx.textBaseline = "top";
  const left = Math.max(0, chart.timeScale().logicalToCoordinate(0) ?? 0);
  for (const t of layer.scene.thin) {
    const top = candles.priceToCoordinate(t.hi);
    if (top != null) haloText(ctx, c, "thin volume", left + 6, Math.max(top + 4, LEGEND_H), c.accent);
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Плашка с текстом по центру cx, не вылезает за края панели. */
function pill(ctx, c, cx, yTop, text, back, fore) {
  ctx.font = `500 12px ${c.font}`;
  const w = ctx.measureText(text).width + PILL_PAD * 2;
  const x = Math.max(2, Math.min(paneWidth() - w - 2, cx - w / 2));
  ctx.fillStyle = back;
  roundRect(ctx, x, yTop, w, PILL_H, 4);
  ctx.fill();
  ctx.fillStyle = fore;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + PILL_PAD, yTop + PILL_H / 2 + 0.5);
}

/** Подписи позиции как у TV: цель и стоп снаружи коробки, итог на входе. */
function drawPositionLabels(ctx, c) {
  const plan = layer.scene.plan;
  const p = boxPrices();
  if (!plan || !p) return;
  const r = boxRect(p);
  if (!r) return;
  ctx.globalAlpha = p.fade;
  const up = plan.side === "long";
  const cx = (r.x0 + r.x1) / 2;
  const outside = (edge, below, row = 0) =>
    below ? edge + PILL_GAP + row * (PILL_H + 2) : edge - PILL_GAP - PILL_H - row * (PILL_H + 2);
  const roomy = Math.min(Math.abs(r.yt - r.ye), Math.abs(r.ys - r.ye)) >= PILL_H + 4;
  const white = "#ffffff";
  pill(ctx, c, cx, outside(r.yt, !up), `Target ${fmtPx(plan.target)} (+${plan.rewardPct.toFixed(2)}%)`, c.up, white);
  pill(ctx, c, cx, outside(r.ys, up), `Stop ${fmtPx(plan.stop)} (−${plan.riskPct.toFixed(2)}%)`, c.down, white);
  const head = `${plan.side === "long" ? "Long" : "Short"} · R:R ${plan.netRr.toFixed(2)}`;
  pill(ctx, c, cx, roomy ? r.ye - PILL_H / 2 : outside(r.ys, up, 1), head, c.strong, c.bg);
  ctx.globalAlpha = 1;
}

/** Слой уровней: одни данные, три прохода — под свечами, коробка, подписи сверху. */
function makeLayer() {
  const state = { requestUpdate: null };
  const scene = { zones: [], thin: [], plan: null };
  const pass = (zOrder, fn) => ({
    zOrder: () => zOrder,
    renderer: () => ({
      draw: (target) => {
        if (!candles || !bars.length) return;
        const c = palette();
        target.useMediaCoordinateSpace(({ context }) => fn(context, c));
      },
    }),
  });
  const views = [
    pass("bottom", (ctx, c) => {
      drawZones(ctx, c);
      drawBox(ctx, c);
    }),
    pass("top", (ctx, c) => {
      drawZoneNames(ctx, c);
      drawPositionLabels(ctx, c);
    }),
  ];

  // Цены позиции на шкале: цель зелёным, стоп красным, вход тёмным.
  const axis = (key, tone) => ({
    coordinate: () => {
      const p = boxPrices();
      return p ? (candles.priceToCoordinate(p[key]) ?? -100) : -100;
    },
    text: () => (scene.plan ? fmtPx(scene.plan[key]) : ""),
    textColor: () => (tone === "strong" ? palette().bg : "#ffffff"),
    backColor: () => palette()[tone],
    visible: () => Boolean(scene.plan),
    tickVisible: () => true,
  });
  const axisViews = [axis("target", "up"), axis("stop", "down"), axis("entry", "strong")];

  return {
    scene,
    attached({ requestUpdate }) {
      state.requestUpdate = requestUpdate;
    },
    detached() {
      state.requestUpdate = null;
    },
    redraw() {
      state.requestUpdate?.();
    },
    updateAllViews() {},
    paneViews: () => views,
    priceAxisViews: () => axisViews,
    // Стоп и цель плана должны влезать в шкалу, иначе коробка уезжает за край.
    autoscaleInfo: () => {
      const p = scene.plan;
      if (!p) return null;
      return { priceRange: { minValue: Math.min(p.stop, p.target), maxValue: Math.max(p.stop, p.target) } };
    },
  };
}

// ── Легенда ──────────────────────────────────────

/** Строка над графиком, как у TV: монета, ТФ и OHLC бара под курсором. */
function renderLegend(bar) {
  if (!legend) return;
  const b = bar || bars[bars.length - 1];
  if (!b) {
    legend.innerHTML = "";
    return;
  }
  const chg = ((b.close - b.open) / b.open) * 100;
  const tone = b.close >= b.open ? "up" : "down";
  const v = (k, n) => `<span>${k}<b class="${tone}">${fmtPx(n)}</b></span>`;
  legend.innerHTML =
    `<strong>${meta.coin} · ${meta.tf} · Hyperliquid</strong>` +
    v("O", b.open) +
    v("H", b.high) +
    v("L", b.low) +
    v("C", b.close) +
    `<b class="${tone}">${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%</b>`;
}

// ── Публичное ────────────────────────────────────

function chartOptions() {
  const c = palette();
  return {
    layout: {
      background: { type: "solid", color: c.bg },
      textColor: c.text,
      fontFamily: c.font,
      fontSize: 12,
      attributionLogo: false,
    },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair: {
      mode: 0,
      vertLine: { color: withAlpha(c.text, 0.6), labelBackgroundColor: c.strong },
      horzLine: { color: withAlpha(c.text, 0.6), labelBackgroundColor: c.strong },
    },
    rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: {
      borderColor: c.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: FUTURE_BARS,
      tickMarkFormatter: tickLabel,
    },
    localization: { timeFormatter: crosshairLabel, priceFormatter: fmtPx },
  };
}

function candleColors() {
  const c = palette();
  return {
    upColor: c.up,
    downColor: c.down,
    borderUpColor: c.up,
    borderDownColor: c.down,
    wickUpColor: c.up,
    wickDownColor: c.down,
  };
}

export async function drawLevels(container, data, pick) {
  if (!container || !Array.isArray(data?.candles) || !data.candles.length) return false;
  onPick = pick;

  if (!chart || !container.contains(chart.chartElement())) {
    container.innerHTML = "";
    host = container;
    const { createChart, CandlestickSeries } = await import("lightweight-charts");
    chart = createChart(container, { ...chartOptions(), autoSize: true });
    candles = chart.addSeries(CandlestickSeries, {
      ...candleColors(),
      priceFormat: { type: "custom", formatter: fmtPx, minMove: 1e-8 },
    });
    layer = makeLayer();
    candles.attachPrimitive(layer);

    legend = document.createElement("div");
    legend.className = "chart-legend";
    container.appendChild(legend);

    chart.subscribeClick((e) => {
      const z = e.point && zoneAt(e.point);
      if (z) onPick(z);
    });
    chart.subscribeCrosshairMove((e) => {
      host.classList.toggle("is-zone-hover", Boolean(e.point && zoneAt(e.point)));
      renderLegend(e.seriesData?.get(candles));
    });
  }

  const fresh = meta.coin !== data.coin || meta.tf !== data.tf;
  meta = { coin: data.coin, tf: data.tf };
  bars = data.candles;
  candles.setData(bars);
  renderLegend();
  if (fresh) {
    anim.zonesAt = performance.now();
    anim.box = null;
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, bars.length - 1 - VISIBLE_BARS),
      to: bars.length - 1 + FUTURE_BARS,
    });
  }
  kick();
  return true;
}

/** Живая цена двигает последнюю свечу; закрытый бар не трогаем. */
export function tickPrice(px) {
  const last = bars.at(-1);
  if (!candles || !last || !(px > 0)) return;
  const bar = { ...last, close: px, high: Math.max(last.high, px), low: Math.min(last.low, px) };
  bars[bars.length - 1] = bar;
  candles.update(bar);
  renderLegend();
}

/** Зоны, тонкие коридоры профиля и выбранный план. */
export function drawScene(zones, plan, thin = []) {
  if (!layer) return;
  const next = plan && !plan.incomplete ? plan : null;
  const prev = boxPrices();
  if (next) {
    const to = { entry: next.entry, stop: next.stop, target: next.target };
    // Новая коробка раскрывается от входа, смена плана перетекает из прежней.
    const from = prev ? { entry: prev.entry, stop: prev.stop, target: prev.target } : { entry: next.entry, stop: next.entry, target: next.entry };
    anim.box = { from, to, at: performance.now(), fadeIn: !prev };
  } else anim.box = null;
  layer.scene.zones = zones;
  layer.scene.thin = thin;
  layer.scene.plan = next;
  chart.priceScale("right").applyOptions({ autoScale: true });
  kick();
}

/** Перекраска под тему: bindTheme зовёт это при смене. */
export function applyLevelsTheme() {
  if (!chart) return;
  chart.applyOptions(chartOptions());
  candles.applyOptions(candleColors());
  layer?.redraw();
}
