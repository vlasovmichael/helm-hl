// ─────────────────────────────────────────────────
//  Coin history (OI vs price) — Lightweight Charts, две ценовых шкалы.
//  Раньше это был голый SVG-спарклайн без единой подписи: ступеньку на графике
//  было видно, а КОГДА она случилась — нет. Здесь ось времени и курсор с
//  тултипом, потому что вся ценность картинки в вопросе «в какой час набрали».
//
//  Шкалы намеренно РАЗНЫЕ и обе видимы: OI справа в $, цена слева. Общей шкалы
//  у них быть не может (доллары объёма и цена монеты несопоставимы), а
//  безымянная нормировка по min/max, как было, врала о величине расхождения.
// ─────────────────────────────────────────────────

import { cssVar } from "../utils/format.js";

const OI_COLOR = "#5b9dff";
const PX_COLOR = "#e8b84b";

let chart = null;
let oiSeries = null;
let pxSeries = null;
let tooltip = null;
let lastPoints = [];

const pad2 = (n) => String(n).padStart(2, "0");
const stamp = (sec) => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const usd = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};
const px = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(4);
};

function themeColors() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    text: cssVar("--text-secondary") || (isDark ? "#71717A" : "#52525B"),
    grid: cssVar("--hairline") || cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7"),
    bg: cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF"),
  };
}

export function applyOiChartTheme() {
  if (!chart) return;
  const c = themeColors();
  chart.applyOptions({
    layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid },
    leftPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid },
  });
}

// Снимки идут каждые ~15 мин, но коллектор мог продублировать метку (перезапуск,
// нахлёст файлов). Lightweight Charts на неубывающем времени с дублями молча
// роняет серию, поэтому дедупим по секунде и сортируем по возрастанию.
function toSeries(points, pick) {
  const out = [];
  let prev = -1;
  for (const p of points) {
    const time = Math.floor(p.t / 1000);
    const value = pick(p);
    if (!Number.isFinite(value)) continue;
    if (time === prev) out[out.length - 1] = { time, value };
    else {
      out.push({ time, value });
      prev = time;
    }
  }
  return out;
}

function renderTooltip(param) {
  if (!tooltip) return;
  const container = document.getElementById("oi-chart");
  if (!param?.time || !param.point || !container) {
    tooltip.style.display = "none";
    return;
  }
  const { clientWidth: w, clientHeight: h } = container;
  if (param.point.x < 0 || param.point.x > w || param.point.y < 0 || param.point.y > h) {
    tooltip.style.display = "none";
    return;
  }
  const oi = param.seriesData.get(oiSeries)?.value;
  const price = param.seriesData.get(pxSeries)?.value;

  // Проценты считаем от ПЕРВОЙ точки окна — тот же якорь, что в подзаголовке
  // карточки, иначе тултип и шапка расходятся в цифрах на одном экране.
  const base = lastPoints[0];
  const dOi = base && oi != null ? ((oi - base.oiUsd) / base.oiUsd) * 100 : null;
  const dPx = base && price != null ? ((price - base.px) / base.px) * 100 : null;
  const pct = (v) => (v == null ? "" : ` <i>${v > 0 ? "+" : ""}${v.toFixed(1)}%</i>`);

  tooltip.innerHTML =
    `<div class="oi-tip-t">${stamp(param.time)}</div>` +
    `<div class="oi-tip-r"><b style="background:${OI_COLOR}"></b>OI <span>${usd(oi)}</span>${pct(dOi)}</div>` +
    `<div class="oi-tip-r"><b style="background:${PX_COLOR}"></b>Price <span>${px(price)}</span>${pct(dPx)}</div>`;
  tooltip.style.display = "block";

  // Тултип не должен выезжать за карточку — у правого края переносим влево.
  const tw = tooltip.offsetWidth || 160;
  const th = tooltip.offsetHeight || 60;
  const left = Math.max(4, Math.min(w - tw - 4, param.point.x + 14));
  const top = Math.max(4, Math.min(h - th - 4, param.point.y - th - 10));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

export async function drawOiChart(points) {
  const container = document.getElementById("oi-chart");
  if (!container) return;
  lastPoints = points;

  if (!chart) {
    const { createChart } = await import("lightweight-charts");
    const c = themeColors();
    chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: "solid", color: c.bg },
        textColor: c.text,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
        // Логотип TradingView садится поверх линий в левом нижнем углу.
        attributionLogo: false,
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { visible: true, borderColor: c.grid, scaleMargins: { top: 0.12, bottom: 0.12 } },
      leftPriceScale: { visible: true, borderColor: c.grid, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderColor: c.grid,
        timeVisible: true,
        secondsVisible: false,
        // На окнах 7d/30d тики дневные/месячные — там нужна дата, а не часы,
        // иначе длинный диапазон на оси выглядит как один бесконечный день.
        tickMarkFormatter: (time, tickMarkType) => {
          const d = new Date(time * 1000);
          if (tickMarkType != null && tickMarkType <= 2)
            return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
          return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: c.text, width: 1, style: 3, labelBackgroundColor: OI_COLOR },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: true,
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: { timeFormatter: stamp },
    });

    oiSeries = chart.addLineSeries({
      color: OI_COLOR,
      lineWidth: 2,
      priceScaleId: "right",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: usd },
    });
    pxSeries = chart.addLineSeries({
      color: PX_COLOR,
      lineWidth: 2,
      priceScaleId: "left",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: px },
    });

    tooltip = document.createElement("div");
    tooltip.className = "oi-tip";
    tooltip.style.display = "none";
    container.appendChild(tooltip);
    chart.subscribeCrosshairMove(renderTooltip);

    if (!window.__oiChartResizeBound) {
      window.__oiChartResizeBound = true;
      window.addEventListener("resize", () => {
        if (chart && container) chart.resize(container.clientWidth, container.clientHeight);
      });
    }
  }

  oiSeries.setData(toSeries(points, (p) => p.oiUsd));
  pxSeries.setData(toSeries(points, (p) => p.px));
  // Без fitContent узкое окно (24h после 30d) рисуется внутри старого широкого
  // видимого диапазона и схлопывается в огрызок у правого края.
  chart.timeScale().fitContent();
}

export function clearOiChart() {
  lastPoints = [];
  if (tooltip) tooltip.style.display = "none";
  oiSeries?.setData([]);
  pxSeries?.setData([]);
}
