// ─────────────────────────────────────────────────
//  Levels chart — свечи, зоны, Фибо и сценарии поверх них.
//  Зоны и Фибо — ценовые линии графика; стрелки сценариев и коробки стопа и
//  цели — SVG-слой сверху, пересчитываемый при сдвиге и масштабе шкалы.
// ─────────────────────────────────────────────────

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SVG_NS = "http://www.w3.org/2000/svg";

function themeColors() {
  return {
    bg: cssVar("--card-bg") || "#0d1117",
    text: cssVar("--text-secondary") || "#8b949e",
    muted: cssVar("--border-strong") || "#484f58",
    grid: cssVar("--border") || "rgba(127,127,127,0.18)",
    up: cssVar("--pnl-up") || "#0ecb81",
    down: cssVar("--pnl-down") || "#f6465d",
  };
}

// Столько пустых баров справа от последней свечи: в них рисуется будущее.
const FUTURE_BARS = 44;
// Окно истории на старте: всё окно сплющивает будущее в полоску у шкалы.
const VISIBLE_BARS = 160;

let chart = null;
let candles = null;
let overlay = null;
let lastIndex = 0;
let lastPrice = null;
let zoneLines = [];
let fib = null;
let planLines = [];
let scene = { scenarios: [], plan: null, key: "" };
// Шкала дотягивается после смены плана; перерисовка в это окно играет вход заново,
// иначе событие шкалы срезает анимацию на первом кадре.
let animUntil = 0;
const ANIM_GRACE_MS = 150;

const fmtPx = (p) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));

export async function drawLevels(container, data, zones) {
  if (!container || !Array.isArray(data?.candles) || !data.candles.length) return false;

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
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: c.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: FUTURE_BARS,
      },
      crosshair: { mode: 0 },
    });
    candles = chart.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderUpColor: c.up,
      borderDownColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
      priceFormat: { type: "custom", formatter: fmtPx },
      // Коробки плана должны влезать в шкалу, иначе цель уезжает за край.
      autoscaleInfoProvider: (base) => {
        const r = base();
        const p = scene.plan;
        if (!r || !p || p.incomplete) return r;
        const pts = [p.stop, p.target].filter(Number.isFinite);
        return {
          ...r,
          priceRange: {
            minValue: Math.min(r.priceRange.minValue, ...pts),
            maxValue: Math.max(r.priceRange.maxValue, ...pts),
          },
        };
      },
    });

    overlay = document.createElementNS(SVG_NS, "svg");
    overlay.classList.add("lv-overlay");
    overlay.setAttribute("aria-hidden", "true");
    container.appendChild(overlay);

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => renderOverlay(Date.now() < animUntil));
    new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      renderOverlay(Date.now() < animUntil);
    }).observe(container);
  }

  candles.setData(data.candles);
  lastIndex = data.candles.length - 1;
  lastPrice = data.price;
  drawZones(data, zones);
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, lastIndex - VISIBLE_BARS),
    to: lastIndex + FUTURE_BARS,
  });
  return true;
}

/** Зоны — пунктир с подписью R1/S1: ближайшая к цене получает номер 1. */
export function drawZones(data, zones) {
  if (!candles) return;
  for (const l of zoneLines) candles.removePriceLine(l);
  zoneLines = [];
  const c = themeColors();
  const above = zones.filter((z) => z.price > data.price).sort((a, b) => a.price - b.price);
  const below = zones.filter((z) => z.price <= data.price).sort((a, b) => b.price - a.price);
  const add = (z, title, color) =>
    zoneLines.push(
      candles.createPriceLine({
        price: z.price,
        color,
        lineWidth: z.strength >= 8 ? 2 : 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title,
      }),
    );
  above.forEach((z, i) => add(z, `R${i + 1}`, c.down));
  below.forEach((z, i) => add(z, `S${i + 1}`, c.up));
}

/** Фибо рисуется слоем сверху: подпись коэффициента и цены стоит у самой линии. */
export function drawFib(next) {
  fib = next;
  renderOverlay(false);
}

/**
 * Сценарии и текущий план. Стрелки рисуются обоим, коробки — только плану.
 * Анимация входа играет только при смене содержимого, не при сдвиге шкалы.
 */
export function drawScenarios(scenarios, plan) {
  if (!candles) return;
  const key = JSON.stringify([
    scenarios.map((s) => [s.side, s.plan?.entry, s.plan?.target]),
    plan && [plan.side, plan.entry, plan.stop, plan.target],
  ]);
  const changed = key !== scene.key;
  scene = { scenarios, plan, key };
  drawPlanLabels(plan);
  // Шкала подстраивается под новые коробки до того, как по ней считать пиксели.
  if (changed) {
    chart.priceScale("right").applyOptions({ autoScale: true });
    animUntil = Date.now() + ANIM_GRACE_MS;
  }
  requestAnimationFrame(() => renderOverlay(changed));
}

/** На шкале цены — только числа плана: линии через весь график дублируют коробки. */
function drawPlanLabels(plan) {
  for (const l of planLines) candles.removePriceLine(l);
  planLines = [];
  if (!plan || plan.incomplete) return;
  const c = themeColors();
  const rows = [
    { price: plan.entry, color: cssVar("--text-primary") || "#e6edf3", title: "entry" },
    { price: plan.stop, color: c.down, title: "stop" },
    { price: plan.target, color: c.up, title: "target" },
  ];
  for (const r of rows) {
    planLines.push(
      candles.createPriceLine({
        price: r.price,
        color: r.color,
        lineVisible: false,
        axisLabelVisible: true,
        title: r.title,
      }),
    );
  }
}

const clampBars = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function node(tag, attrs, cls) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (cls) n.setAttribute("class", cls);
  return n;
}

function renderOverlay(animate) {
  if (!overlay || !chart) return;
  overlay.replaceChildren();
  const ts = chart.timeScale();
  // Шкала понимает только целые индексы баров: дробный уводит точку к краю.
  const x = (bars) => ts.logicalToCoordinate(lastIndex + Math.round(bars));
  const y = (p) => candles.priceToCoordinate(p);

  const defs = node("defs", {});
  for (const side of ["long", "short"]) {
    const m = node(
      "marker",
      { id: `lv-head-${side}`, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      `lv-head lv-head--${side}`,
    );
    m.appendChild(node("path", { d: "M0,0 L10,5 L0,10 z" }));
    defs.appendChild(m);
  }
  overlay.appendChild(defs);

  if (fib) drawFibLayer(x, y);
  const plan = scene.plan;
  if (plan && !plan.incomplete) drawBox(plan, x, y, animate);

  for (const s of scene.scenarios) {
    const p = s.plan;
    if (!p || p.incomplete || s.noTrade) continue;
    const active = plan && !plan.incomplete && plan.side === p.side && plan.entry === p.entry;
    drawPath(s, x, y, active, animate);
  }
}

/** Линии Фибо от начала импульса до правого края будущего, подпись — у начала. */
function drawFibLayer(x, y) {
  const ts = chart.timeScale();
  const x0 = ts.timeToCoordinate(fib.fromTime) ?? 0;
  const x1 = x(FUTURE_BARS);
  if (x1 == null) return;
  for (const lv of fib.levels) {
    const yy = y(lv.price);
    if (yy == null) continue;
    overlay.appendChild(node("line", { x1: Math.max(0, x0), x2: x1, y1: yy, y2: yy }, "lv-fib"));
    const t = node("text", { x: Math.max(0, x0) + 4, y: yy - 4 }, "lv-fib-label");
    t.textContent = `${lv.ratio} · ${fmtPx(lv.price)}`;
    overlay.appendChild(t);
  }
}

/** Коробка позиции: зелёная от входа до цели, красная от входа до стопа. */
function drawBox(plan, x, y, animate) {
  const anim = animate ? " is-anim" : "";
  const x0 = x(3);
  const x1 = x(FUTURE_BARS - 3);
  const ye = y(plan.entry);
  const ys = y(plan.stop);
  const yt = y(plan.target);
  if ([x0, x1, ye, ys, yt].some((v) => v == null)) return;
  const rect = (ya, yb, cls) =>
    overlay.appendChild(
      node("rect", { x: x0, y: Math.min(ya, yb), width: Math.max(0, x1 - x0), height: Math.abs(yb - ya) }, cls),
    );
  // Каждая половина растёт от линии входа: план раскрывается из точки решения.
  const targetUp = plan.target > plan.entry;
  rect(ye, yt, `lv-box lv-box--win lv-box--${targetUp ? "up" : "down"}${anim}`);
  rect(ye, ys, `lv-box lv-box--loss lv-box--${targetUp ? "down" : "up"}${anim}`);
  overlay.appendChild(node("line", { x1: x0, x2: x1, y1: ye, y2: ye }, `lv-box-entry${anim}`));

  const label = (yy, text, cls, below) => {
    const t = node("text", { x: x1 - 6, y: yy + (below ? 13 : -5), "text-anchor": "end" }, `lv-box-label ${cls}${anim}`);
    t.textContent = text;
    overlay.appendChild(t);
  };
  const sign = (a, b) => `${((b - a) / a) * 100 >= 0 ? "+" : "−"}${Math.abs(((b - a) / a) * 100).toFixed(2)}%`;
  label(yt, `Target ${fmtPx(plan.target)} · ${sign(plan.entry, plan.target)}`, "lv-box-label--win", !targetUp);
  label(ys, `Stop ${fmtPx(plan.stop)} · ${sign(plan.entry, plan.stop)}`, "lv-box-label--loss", targetUp);
}

/**
 * Путь сценария: от цены к входу, короткий ретест и ход к цели.
 * Форма фиксирована правилом, а не угадана: это схема плана, не траектория.
 */
function drawPath(s, x, y, active, animate) {
  const p = s.plan;
  // Длина ног — медианное время таких ходов в окне, а не зашитая форма.
  const toEntry = clampBars(s.entryBars ?? 8, 2, FUTURE_BARS / 2);
  const toTarget = clampBars(s.rate?.winBars ?? 12, 3, FUTURE_BARS - 4 - toEntry);
  const move = p.target - p.entry;
  const pts = [
    [0, lastPrice],
    [toEntry, p.entry],
    [toEntry + toTarget * 0.3, p.entry + move * 0.4],
    [toEntry + toTarget * 0.55, p.entry + move * 0.12],
    [toEntry + toTarget, p.target],
  ].map(([b, pr]) => [x(b), y(pr)]);
  if (pts.some(([a, b]) => a == null || b == null)) return;

  const d = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const cls = [
    "lv-path",
    `lv-path--${p.side}`,
    active ? "" : "lv-path--dim",
    animate ? "lv-path--draw" : "",
  ]
    .filter(Boolean)
    .join(" ");
  overlay.appendChild(node("path", { d, pathLength: 1, "marker-end": `url(#lv-head-${p.side})` }, cls));

  const [ex, ey] = pts[1];
  const tail = `${active ? "" : " lv-path--dim"}${animate ? " is-anim" : ""}`;
  overlay.appendChild(node("circle", { cx: ex, cy: ey, r: 4 }, `lv-dot lv-dot--${p.side}${tail}`));
  const tag = node("text", { x: ex - 10, y: ey + 5, "text-anchor": "end" }, `lv-path-tag${tail}`);
  tag.textContent = s.id;
  overlay.appendChild(tag);
}

/** Перекраска под тему: bindTheme зовёт это при смене. */
export function applyLevelsTheme() {
  if (!chart) return;
  const c = themeColors();
  chart.applyOptions({
    layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
    grid: { horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.grid },
    timeScale: { borderColor: c.grid },
  });
}
