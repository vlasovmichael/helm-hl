// ─────────────────────────────────────────────────
//  Market Context bar — живой мини-график BTC + цена.
//  Цвет рамки = светофор по фону (risk-on/off), текст-вердикт убран.
//  Полностью самодостаточный (DOM + Math). renderMarketContext зовёт tick.
// ─────────────────────────────────────────────────

// Формат цены BTC: без копеек на десятках тысяч, читаемо.
function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  return "$" + Math.round(p).toLocaleString("en-US");
}

// ── Мини-свечи из OHLC ([o,h,l,c][]) в компактный SVG ──
const MC_CH = { h: 100, slot: 5, body: 3, pad: 6 }; // высота, ширина слота, тело, отступ
function renderMiniCandles(series) {
  if (!Array.isArray(series) || series.length === 0) return "";
  const lows = series.map((c) => c[2]);
  const highs = series.map((c) => c[1]);
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  const span = hi - lo || 1;
  const { h, slot, body, pad } = MC_CH;
  const usable = h - pad * 2;
  const y = (price) => pad + (1 - (price - lo) / span) * usable;
  const w = series.length * slot;

  const bars = series
    .map((c, i) => {
      const [o, hh, ll, cc] = c;
      const up = cc >= o;
      const cls = up ? "up" : "down";
      const x = i * slot;
      const cx = x + slot / 2;
      const yH = y(hh), yL = y(ll);
      const yO = y(o), yC = y(cc);
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO)); // тело минимум 1px (дожи)
      const bx = x + (slot - body) / 2;
      return (
        `<line class="mc-cw ${cls}" x1="${cx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yL.toFixed(1)}" />` +
        `<rect class="mc-cb ${cls}" x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${body}" height="${bh.toFixed(1)}" />`
      );
    })
    .join("");

  return `<svg class="mc-candles" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="BTC 15m мини-график">${bars}</svg>`;
}

export function renderMarketContext(d) {
  const el = document.getElementById("market-context");
  if (!el || !d) return;
  // Светофор «можно/нельзя»: чёткий фонд (RISK-ON/OFF) = go (зелёный),
  // MIXED = wait (жёлтый), всё прочее = unknown (серый). Текста-вердикта нет —
  // сигнал остаётся в цвете левой рамки.
  const cls =
    d.verdict === "RISK_ON" || d.verdict === "RISK_OFF"
      ? "go"
      : d.verdict === "MIXED"
        ? "wait"
        : "unknown";
  // classList, не className — иначе затираем класс is-revealed от reveal-on-scroll.
  el.classList.remove("go", "wait", "unknown");
  el.classList.add(cls);

  const chartEl = document.getElementById("mc-chart");
  const priceEl = document.getElementById("mc-price");
  if (chartEl) chartEl.innerHTML = renderMiniCandles(d.btcCandles);
  if (priceEl) {
    const m4h = d.btc && d.btc.m4h != null ? d.btc.m4h : null;
    const pcls = m4h == null ? "" : m4h >= 0 ? "up" : "down";
    const psign = m4h == null ? "" : m4h >= 0 ? "▲ +" : "▼ ";
    const pct = m4h == null ? "" : `<span class="mc-4h ${pcls}">${psign}${m4h.toFixed(2)}% 4h</span>`;
    priceEl.innerHTML = `<span class="mc-sym">BTC</span><span class="mc-px">${fmtPrice(d.btcPrice)}</span>${pct}`;
  }
}
