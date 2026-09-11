// ─────────────────────────────────────────────────
//  Карта ликвидаций — тепловая карта поверх свечей (Lightweight Charts).
//
//  Читается она только вместе с ценой: смысл карты в вопросе «сколько топлива
//  над ценой и сколько под ней», а без свечей на экране нет второй половины
//  вопроса. Поэтому одна ценовая шкала на свечи и на карту, а карта рисуется
//  примитивом серии, а не сеткой из <i> — сетка не умеет ни зума, ни общей
//  шкалы с ценой.
//
//  🚨 Каждая ячейка — ЦЕНА ЛИКВИДАЦИИ реальных открытых позиций из среза, а не
//  прогноз «уровня» по открытому интересу. Цвет = сколько там долларов, а не
//  вероятность визита.
// ─────────────────────────────────────────────────

import { cssVar } from "../utils/format.js";

// Две шкалы под тему: на тёмной viridis (тёмное = пусто), на светлой inferno
// наоборот — бледное = пусто, густое = много. Одна шкала на обе темы всегда
// теряет один из концов: жёлтое на белом не видно, чёрное на тёмном тоже.
const RAMP_DARK = ["#2b1a48", "#414487", "#2a788e", "#22a884", "#7ad151", "#fde725"];
const RAMP_LIGHT = ["#eef0f6", "#b9c6e8", "#6f8fd6", "#9c5fb5", "#c0392b", "#5b1d10"];

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** Цвет по интенсивности 0..1: линейная интерполяция между соседними стопами. */
function rampColor(ramp, t) {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex(ramp[i]);
  const b = hex(ramp[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}

// 🚨 Шкала логарифмическая: суммы в ячейках различаются на три порядка, на
// линейной вся карта, кроме одного пятна, уходит в пустоту.
const intensity = (v, max) => (v <= 0 ? 0 : Math.log10(1 + v) / Math.log10(1 + max));

const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtPx = (p) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));
const usd = (v) => {
  const x = Math.abs(v);
  if (x >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

function themeColors() {
  return {
    text: cssVar("--text-secondary") || "#71717A",
    grid: cssVar("--hairline") || "#E4E4E7",
    bg: cssVar("--card-bg") || "#FFFFFF",
  };
}

let chart = null;
let candles = null;
let heat = null; // примитив карты
let tooltip = null;
let host = null;

// ── Примитив карты ──────────────────────────────────────────────────────────
// Рисует ячейки карты. Координаты берёт у самого графика
// (timeToCoordinate/priceToCoordinate) — карта и свечи не могут разъехаться.
function makeHeat() {
  const state = { data: null, barTimes: [], rowSum: [], bandLo: 0, bandHi: 0 };

  const draw = (target) => {
    const d = state.data;
    if (!d?.cells?.length || !candles) return;
    const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT;
    const ts = chart.timeScale();

    // Срезы позиций идут по своему расписанию (раз в пару минут), свечи — по
    // своему. timeToCoordinate знает только времена серии, поэтому координату
    // среза берём линейной интерполяцией между соседними свечами: иначе все
    // срезы внутри одной свечи слипаются в одну колонку во всю её ширину.
    const bars = state.barTimes;
    const timeToX = (t) => {
      if (!bars.length) return null;
      let lo = 0, hi = bars.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (bars[mid] <= t) lo = mid; else hi = mid;
      }
      const a = ts.timeToCoordinate(bars[lo]);
      const b = ts.timeToCoordinate(bars[hi]);
      if (a == null || b == null) return null;
      const span = bars[hi] - bars[lo] || 1;
      return a + ((b - a) * (t - bars[lo])) / span;
    };

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      // Границы колонок — по серединам между соседними срезами: снимок стоит не
      // «в точке», а держится до следующего снимка.
      const xs = d.snapTime.map((t) => timeToX(t));
      const edges = [];
      for (let i = 0; i < xs.length; i += 1) {
        if (xs[i] == null) { edges.push(null); continue; }
        const prev = i > 0 && xs[i - 1] != null ? (xs[i - 1] + xs[i]) / 2 : xs[i] - 6;
        const next = i < xs.length - 1 && xs[i + 1] != null ? (xs[i] + xs[i + 1]) / 2 : xs[i] + 6;
        edges.push([prev, next]);
      }

      const step = (d.priceHi - d.priceLo) / d.rows;
      for (const c of d.cells) {
        const e = edges[c.x];
        if (!e) continue;
        const pTop = d.priceHi - c.y * step;
        const yTop = candles.priceToCoordinate(pTop);
        const yBot = candles.priceToCoordinate(pTop - step);
        if (yTop == null || yBot == null) continue;
        const x0 = Math.round(e[0] * hr);
        const x1 = Math.round(e[1] * hr);
        if (x1 <= x0) continue;
        ctx.fillStyle = rampColor(ramp, intensity(c.longUsd + c.shortUsd, d.max));
        ctx.fillRect(x0, Math.round(yTop * vr), x1 - x0, Math.max(1, Math.round((yBot - yTop) * vr)));
      }

    });
  };

  const view = { zOrder: () => "bottom", renderer: () => ({ draw }) };

  return {
    setBars(times) { state.barTimes = times; },
    setData(d) {
      state.data = d;
      state.rowSum = new Array(d.rows).fill(0);
      for (const c of d.cells) state.rowSum[c.y] += c.longUsd + c.shortUsd;
    },
    get data() { return state.data; },
    rowSumAt: (y) => state.rowSum[y] || 0,
    attached({ requestUpdate }) { state.requestUpdate = requestUpdate; },
    redraw() { state.requestUpdate?.(); },
    updateAllViews() {},
    paneViews: () => [view],
    // Окно шкалы ведёт ХОД ЦЕНЫ, а не размах карты: ликвидации разбросаны на
    // десятки процентов, и полоса «по карте» сплющивала свечи в нитку. Ход
    // плюс половина его размаха сверху и снизу — видно и цену, и топливо по
    // обе стороны от неё; дальнее топливо остаётся в профиле и под зумом.
    autoscaleInfo: () => {
      if (!state.data || !state.bandLo) return null;
      return { priceRange: { minValue: state.bandLo, maxValue: state.bandHi } };
    },
    setBand(lo, hi) { state.bandLo = lo; state.bandHi = hi; },
  };
}

// ── Тултип ──────────────────────────────────────────────────────────────────
function onCrosshair(param) {
  const d = heat?.data;
  if (!tooltip || !d) return;
  const hide = () => { tooltip.style.display = "none"; };
  if (!param?.point || !param.time) return hide();
  const price = candles.coordinateToPrice(param.point.y);
  if (price == null) return hide();

  const step = (d.priceHi - d.priceLo) / d.rows;
  const y = Math.floor((d.priceHi - price) / step);
  const tMs = param.time * 1000;
  let x = 0;
  for (let i = 0; i < d.snapTime.length; i += 1) if (d.snapTime[i] * 1000 <= tMs + 1) x = i;
  const cell = d.cells.find((c) => c.x === x && c.y === y);

  const lvl = `${fmtPx(d.priceHi - (y + 1) * step)}–${fmtPx(d.priceHi - y * step)}`;
  const side = price > d.ref ? "shorts liquidate up" : "longs liquidate down";
  tooltip.innerHTML =
    `<div class="oi-tip-t">${hhmm(d.colTs[x])} · ${lvl}</div>` +
    (cell
      ? `<div class="oi-tip-r">at this level <span>${usd(cell.longUsd + cell.shortUsd)}</span></div>` +
        `<div class="oi-tip-r">positions <span>${cell.n}</span></div>`
      : `<div class="oi-tip-r">empty <span>—</span></div>`) +
    `<div class="oi-tip-r">over the window <span>${usd(heat.rowSumAt(y))}</span></div>` +
    `<div class="oi-tip-t">${side}</div>`;
  tooltip.style.display = "block";

  const tw = tooltip.offsetWidth || 180;
  const th = tooltip.offsetHeight || 70;
  tooltip.style.left = `${Math.max(4, Math.min(host.clientWidth - tw - 4, param.point.x + 14))}px`;
  tooltip.style.top = `${Math.max(4, Math.min(host.clientHeight - th - 4, param.point.y - th - 10))}px`;
}

export function applyLiqHeatTheme() {
  if (!chart) return;
  const c = themeColors();
  chart.applyOptions({
    layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid },
  });
  // Палитра карты зависит от темы, а холст сам себя не перерисует.
  heat?.redraw();
}

/** Свечи HL → серия графика; дубли по времени схлопываем (перезапуск коллектора). */
function toCandles(raw, fromMs) {
  const out = [];
  let prev = -1;
  for (const k of raw) {
    const time = Math.floor(k.t / 1000);
    if (k.t < fromMs) continue;
    const bar = { time, open: +k.o, high: +k.h, low: +k.l, close: +k.c };
    if (time === prev) out[out.length - 1] = bar;
    else { out.push(bar); prev = time; }
  }
  return out;
}

/**
 * Рисует карту в контейнере. data — ответ /api/flow/liqheat, kl — свечи HL.
 * Оба ряда обязаны быть за одно окно: карта без свечей не отвечает на свой же
 * вопрос, свечи без карты — обычный график.
 */
export async function drawLiqHeat(container, data, kl) {
  host = container;
  const bars = toCandles(kl, data.t0 - 30 * 60_000);
  if (!bars.length) return false;

  if (!chart || !container.contains(chart.chartElement())) {
    container.innerHTML = "";
    const { createChart, CandlestickSeries } = await import("lightweight-charts");
    const c = themeColors();
    chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: "solid", color: c.bg },
        textColor: c.text,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.04, bottom: 0.04 } },
      // 🚨 Время МЕСТНОЕ: график по умолчанию рисует UTC, и карта расходилась с
      // часами оператора на два часа — «ликвидации в 12:45» при 14:45 на стене.
      timeScale: {
        borderColor: c.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        tickMarkFormatter: (t) => hhmm(t * 1000),
      },
      localization: { timeFormatter: (t) => hhmm(t * 1000) },
      crosshair: { mode: 0 },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    // Свечи тонкие и приглушённые: героиня картинки — карта, цена тут маршрут
    // по ней. Сплошная заливка спорила бы с цветом ячеек.
    candles = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(255,255,255,0)",
      downColor: "rgba(255,255,255,0)",
      borderUpColor: cssVar("--green-line") || "#26a69a",
      borderDownColor: cssVar("--red-line") || "#ef5350",
      wickUpColor: cssVar("--green-line") || "#26a69a",
      wickDownColor: cssVar("--red-line") || "#ef5350",
      priceLineVisible: true,
      priceFormat: { type: "custom", formatter: fmtPx },
    });
    heat = makeHeat();
    candles.attachPrimitive(heat);
    chart.subscribeCrosshairMove(onCrosshair);

    tooltip = document.createElement("div");
    tooltip.className = "oi-tip";
    tooltip.style.display = "none";
    container.appendChild(tooltip);

    new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }).observe(container);
  }

  data.snapTime = data.colTs.map((ms) => Math.floor(ms / 1000));

  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  const half = Math.max((hi - lo) * 0.5, lo * 0.002);

  candles.setData(bars);
  heat.setBars(bars.map((b) => b.time));
  heat.setBand(Math.max(data.priceLo, lo - half), Math.min(data.priceHi, hi + half));
  heat.setData(data);
  chart.timeScale().fitContent();
  applyLiqHeatTheme();
  return true;
}

/** Снести график: монета сменилась на «нет данных» — карточка не должна врать. */
export function clearLiqHeat() {
  if (!chart) return;
  chart.remove();
  chart = null;
  candles = null;
  heat = null;
  tooltip = null;
}
