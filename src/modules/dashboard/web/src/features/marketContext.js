// ─────────────────────────────────────────────────
//  Market Context bar — живая расширенная статистика по BTC.
//  Цена + 24h + движения 15m/1h/4h + объём + OI + funding.
//  Цвет рамки = светофор по фону (risk-on/off). renderMarketContext зовёт tick.
// ─────────────────────────────────────────────────

function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  return "$" + Math.round(p).toLocaleString("en-US");
}

// Компактный USD: $1.24B / $850M / $12K
function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(0) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + Math.round(n);
}

function pctCls(v) {
  return v == null ? "" : v >= 0 ? "up" : "down";
}
function fmtPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%";
}

// label + value «ячейка»
function cell(label, valueHtml) {
  return `<span class="mc-cell"><i>${label}</i><b>${valueHtml}</b></span>`;
}

export function renderMarketContext(d) {
  const el = document.getElementById("market-context");
  if (!el || !d) return;
  // Светофор: чёткий фонд (RISK-ON/OFF) = go (зелёный), MIXED = wait (жёлтый),
  // прочее = unknown (серый). Сигнал — в цвете левой рамки.
  const cls =
    d.verdict === "RISK_ON" || d.verdict === "RISK_OFF"
      ? "go"
      : d.verdict === "MIXED"
        ? "wait"
        : "unknown";
  el.classList.remove("go", "wait", "unknown");
  el.classList.add(cls);

  const b = d.btc || {};
  const headEl = document.getElementById("mc-head");
  const statsEl = document.getElementById("mc-stats");

  if (headEl) {
    const c24 = b.change24h;
    headEl.innerHTML =
      `<span class="mc-sym">BTC</span>` +
      `<span class="mc-px">${fmtPrice(b.price)}</span>` +
      `<span class="mc-24h ${pctCls(c24)}">${fmtPct(c24)} <i>24h</i></span>`;
  }

  if (statsEl) {
    const tf = (label, v) =>
      `<span class="mc-cell"><i>${label}</i><b class="${pctCls(v)}">${fmtPct(v)}</b></span>`;
    // funding: часовая доля → % с 4 знаками
    const fund = b.funding == null ? null : b.funding * 100;
    statsEl.innerHTML =
      tf("15m", b.m15) +
      tf("1h", b.m1h) +
      tf("4h", b.m4h) +
      cell("Vol 24h", fmtUsd(b.volUsd)) +
      cell("OI", fmtUsd(b.oiUsd)) +
      `<span class="mc-cell"><i>Funding 1h</i><b class="${pctCls(fund)}">${fund == null ? "—" : fmtPct(fund, 4)}</b></span>`;
  }
}
