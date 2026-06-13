// ─────────────────────────────────────────────────
//  Market Context bar — вердикт по фону (risk-on/off) + Fear&Greed gauge.
//  Полностью самодостаточный (DOM + Math). renderMarketContext зовёт tick.
// ─────────────────────────────────────────────────

// если priceHistory ещё пуст (первые минуты после рестарта бота).
const MC_VERDICT_LABEL = {
  RISK_ON: "RISK-ON",
  RISK_OFF: "RISK-OFF",
  MIXED: "MIXED",
  UNKNOWN: "—",
};
function mcMoveSpan(label, pct) {
  if (pct == null) return `<span>${label} —</span>`;
  const cls = pct >= 0 ? "up" : "down";
  const sign = pct >= 0 ? "+" : "";
  return `<span class="${cls}">${label} ${sign}${pct.toFixed(2)}%</span>`;
}

// ── Fear & Greed gauge (полукруглый спидометр со стрелкой) ──
// value 0..100. 0 = слева (Extreme Fear), 100 = справа (Extreme Greed).
const FNG_GEO = { cx: 66, cy: 60, r: 48 };
// Точка на дуге для значения v (радиус rr). th: v=0→π (лево), v=100→0 (право).
function fngPoint(v, rr) {
  const th = Math.PI * (1 - Math.max(0, Math.min(100, v)) / 100);
  return [FNG_GEO.cx + rr * Math.cos(th), FNG_GEO.cy - rr * Math.sin(th)];
}
function fngArc(v1, v2) {
  const [x1, y1] = fngPoint(v1, FNG_GEO.r);
  const [x2, y2] = fngPoint(v2, FNG_GEO.r);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${FNG_GEO.r} ${FNG_GEO.r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}
function fngColor(v) {
  if (v < 20) return "#f6465c"; // extreme fear
  if (v < 40) return "#f0883e"; // fear
  if (v < 56) return "#f3d42f"; // neutral
  if (v < 76) return "#58bd7d"; // greed
  return "#0ecb81"; // extreme greed
}
// 5 цветных сегментов дуги (зоны страх→жадность).
const FNG_ZONES = [
  [0, 20, "#f6465c"],
  [20, 40, "#f0883e"],
  [40, 56, "#f3d42f"],
  [56, 76, "#58bd7d"],
  [76, 100, "#0ecb81"],
];
function renderFngGauge(value, label) {
  const v = Math.max(0, Math.min(100, value));
  const segs = FNG_ZONES.map(
    ([a, b, c]) =>
      `<path d="${fngArc(a, b)}" stroke="${c}" stroke-width="8" fill="none" />`,
  ).join("");
  const [nx, ny] = fngPoint(v, FNG_GEO.r - 9);
  const { cx, cy } = FNG_GEO;
  return `
    <svg class="fng-gauge" viewBox="0 0 132 84" width="116" height="74"
         role="img" aria-label="Fear and Greed ${v} ${label || ""}">
      ${segs}
      <line class="fng-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" />
      <circle class="fng-hub" cx="${cx}" cy="${cy}" r="3.5" />
      <text class="fng-num" x="${cx}" y="${cy + 19}" text-anchor="middle">${v}</text>
    </svg>`;
}
export function renderMarketContext(d) {
  const el = document.getElementById("market-context");
  if (!el || !d) return;
  // Светофор «можно/нельзя»: чёткий фонд (RISK-ON/OFF) = go (зелёный),
  // MIXED = wait (жёлтый), всё прочее = unknown (серый).
  const cls =
    d.verdict === "RISK_ON" || d.verdict === "RISK_OFF"
      ? "go"
      : d.verdict === "MIXED"
        ? "wait"
        : "unknown";
  // classList, не className — иначе затираем класс is-revealed от reveal-on-scroll
  // (элемент остаётся с [data-reveal] → opacity:0 и пропадает после первого тика).
  el.classList.remove("go", "wait", "unknown");
  el.classList.add(cls);
  const verdictEl = document.getElementById("mc-verdict");
  const btcEl = document.getElementById("mc-btc");
  const fngEl = document.getElementById("mc-fng");
  if (verdictEl) {
    verdictEl.textContent = `MARKET: ${MC_VERDICT_LABEL[d.verdict] || "—"} ${d.arrow || ""}`.trim();
  }
  if (btcEl) {
    const b = d.btc || {};
    btcEl.innerHTML =
      mcMoveSpan("BTC 15m", b.m15) +
      mcMoveSpan("1h", b.m1h) +
      mcMoveSpan("4h", b.m4h);
  }
  if (fngEl) {
    if (d.fearGreed) {
      const { value, label } = d.fearGreed;
      fngEl.innerHTML =
        `<span class="mc-fng-cap">F&amp;G</span>` +
        renderFngGauge(value, label) +
        `<span class="mc-fng-class" style="color:${fngColor(value)}">${label || ""}</span>`;
    } else {
      fngEl.innerHTML = "";
    }
  }
}
