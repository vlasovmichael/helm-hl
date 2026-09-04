// ─────────────────────────────────────────────────
//  Performance (Equity) Chart — Lightweight Charts area-series.
//  Приватное состояние графика; данные истории пушит main.js через setEquityData().
// ─────────────────────────────────────────────────

import { cssVar, hexToRgba, fmtUsd } from "../utils/format.js";

let equityChart = null;
let equitySeries = null;
let equityData = []; // [{time, value}]

// Оверлей-лоадер графика Performance (#chart-loader).
export function showChartLoader() {
  const el = document.getElementById("chart-loader");
  if (el) el.classList.remove("hidden");
}
export function hideChartLoader() {
  const el = document.getElementById("chart-loader");
  if (el) el.classList.add("hidden");
}

// Данные истории equity приходят из tick() страницы (загрузка /api/history).
export function setEquityData(data) {
  equityData = data;
  if (equitySeries) {
    equitySeries.setData(data);
    // Перефитим ось времени под новое окно. Без этого при смене диапазона
    // (24h → 1h) узкая выборка рисуется внутри старого широкого видимого
    // диапазона и схлопывается в огрызок у правого края (см. баг 1h).
    if (equityChart) equityChart.timeScale().fitContent();
  }
}

export function applyChartTheme() {
  if (!equityChart) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const accent = cssVar("--accent") || "#635BFF";
  const textMuted = cssVar("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const grid = cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

  equityChart.applyOptions({
    layout: {
      background: { type: "solid", color: bgColor },
      textColor: textMuted,
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: "transparent" },
      horzLines: { color: grid },
    },
    rightPriceScale: { borderColor: grid },
    timeScale: { borderColor: grid },
  });

  if (equitySeries) {
    equitySeries.applyOptions({
      lineColor: accent,
      topColor: hexToRgba(accent, 0.28),
      bottomColor: hexToRgba(accent, 0),
    });
  }
}

export async function initEquityChart() {
  const container = document.getElementById("equity-chart");
  if (!container) return;
  if (equityChart) return;

  // lightweight-charts грузим лениво (отдельный чанк) — нужен только здесь, на index.
  const { createChart } = await import("lightweight-charts");

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const accent = cssVar("--accent") || "#635BFF";
  const textMuted = cssVar("--text-muted") || (isDark ? "#71717A" : "#52525B");
  const grid = cssVar("--grid-line") || (isDark ? "#1F1F23" : "#E4E4E7");
  const bgColor = cssVar("--card-bg") || (isDark ? "#131316" : "#FFFFFF");

  equityChart = createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: "solid", color: bgColor },
      textColor: textMuted,
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: "transparent" },
      horzLines: { color: grid },
    },
    rightPriceScale: {
      borderColor: grid,
      scaleMargins: { top: 0.15, bottom: 0.05 },
    },
    timeScale: {
      borderColor: grid,
      timeVisible: true,
      secondsVisible: false,
      // «All» = вся жизнь счёта (~10k 5-мин точек). Дефолтный minBarSpacing (0.5px)
      // не даёт fitContent() сжать столько баров в ширину графика → он показывал
      // лишь последние ~3000 (≈10 дней), обрезая старую историю и пик. Уменьшаем
      // минимум, чтобы вся серия помещалась в окно.
      minBarSpacing: 0.02,
      // tickMarkType: 0=Year 1=Month 2=DayOfMonth 3=Time 4=TimeWithSeconds.
      // На дневных/месячных тиках (7d/30d/All) показываем дату, иначе hh:mm —
      // иначе длинные окна на оси выглядят одинаково (видны только часы).
      tickMarkFormatter: (time, tickMarkType) => {
        const d = new Date(time * 1000);
        if (tickMarkType != null && tickMarkType <= 2) {
          const dd = String(d.getDate()).padStart(2, "0");
          const mo = String(d.getMonth() + 1).padStart(2, "0");
          return `${dd}.${mo}`;
        }
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      },
    },
    crosshair: { mode: 0 },
    handleScroll: true,
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: {
      priceFormatter: (v) => `$${Number(v).toFixed(2)}`,
      timeFormatter: (time) => {
        const d = new Date(time * 1000);
        const dd = String(d.getDate()).padStart(2, "0");
        const mo = String(d.getMonth() + 1).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        return `${dd}.${mo} ${hh}:${mi}`;
      },
    },
  });

  equitySeries = equityChart.addAreaSeries({
    lineColor: accent,
    topColor: hexToRgba(accent, 0.28),
    bottomColor: hexToRgba(accent, 0),
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });

  // Данные могли прийти из tick() ДО резолва async-импорта (setEquityData
  // сохранил их в equityData, но серии ещё не было) — переигрываем.
  if (equityData.length) {
    equitySeries.setData(equityData);
    equityChart.timeScale().fitContent();
  }

  if (!window.__equityChartResizeBound) {
    window.__equityChartResizeBound = true;
    window.addEventListener("resize", () => {
      if (equityChart && container)
        equityChart.resize(container.clientWidth, container.clientHeight);
    });
  }
}

export function renderEquityPill() {
  const pill = document.getElementById("equity-pill");
  if (!pill || !equityData.length) return;
  const first = equityData[0].value;
  const last = equityData[equityData.length - 1].value;
  const delta = last - first;
  const pct = first > 0 ? (delta / first) * 100 : 0;
  const valEl = document.getElementById("equity-pill-value");
  const dEl = document.getElementById("equity-pill-delta");
  if (valEl) valEl.textContent = fmtUsd(last);
  if (dEl) {
    const sign = delta >= 0 ? "+" : "-";
    dEl.textContent = `${sign}${fmtUsd(Math.abs(delta))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  }
  pill.classList.toggle("positive", delta >= 0);
  pill.classList.toggle("negative", delta < 0);
  pill.hidden = false;
}
