// ─────────────────────────────────────────────────
//  Market Context bar — живая расширенная статистика по BTC.
//  Цена + 24h + движения 15m/1h/4h + объём + OI + funding.
//  Монтируется один раз, дальше обновляет значения с диффом:
//  плавный вход (стаггер) + пульс-флэш при смене чисел (framer-motion-like).
//  Цвет рамки = светофор по фону (risk-on/off).
// ─────────────────────────────────────────────────

function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  return "$" + Math.round(p).toLocaleString("en-US");
}
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

// Описание ячеек: key → [подпись, в шапке?]. Шапка = price/24h, остальное — stats.
const STAT_CELLS = [
  ["m15", "15m"],
  ["m1h", "1h"],
  ["m4h", "4h"],
  ["volUsd", "Vol 24h"],
  ["oiUsd", "OI"],
  ["funding", "Funding 1h"],
];

let built = false;

function buildStructure(el) {
  const head = el.querySelector("#mc-head");
  const stats = el.querySelector("#mc-stats");
  if (!head || !stats) return false;
  head.innerHTML =
    `<span class="mc-sym">BTC</span>` +
    `<span class="mc-px" data-k="price"></span>` +
    `<span class="mc-24h" data-k="change24h"></span>`;
  stats.innerHTML = STAT_CELLS.map(
    ([k, label]) => `<span class="mc-cell"><i>${label}</i><b data-k="${k}"></b></span>`,
  ).join("");
  el.classList.remove("mc-loading");
  el.classList.add("mc-enter"); // одноразовый вход (стаггер в CSS)
  setTimeout(() => el.classList.remove("mc-enter"), 1200);
  built = true;
  return true;
}

// Обновить узел: текст + цвет-класс.
function setVal(el, key, html, cls) {
  const node = el.querySelector(`[data-k="${key}"]`);
  if (!node) return;
  node.innerHTML = html;
  if (cls !== undefined) {
    node.classList.remove("up", "down");
    if (cls) node.classList.add(cls);
  }
}

export function renderMarketContext(d) {
  const el = document.getElementById("market-context");
  if (!el || !d) return;

  const cls =
    d.verdict === "RISK_ON" || d.verdict === "RISK_OFF"
      ? "go"
      : d.verdict === "MIXED"
        ? "wait"
        : "unknown";
  el.classList.remove("go", "wait", "unknown");
  el.classList.add(cls);

  if (!built && !buildStructure(el)) return;

  const b = d.btc || {};
  setVal(el, "price", fmtPrice(b.price));
  setVal(el, "change24h", `${fmtPct(b.change24h)} <i>24h</i>`, pctCls(b.change24h));
  setVal(el, "m15", fmtPct(b.m15), pctCls(b.m15));
  setVal(el, "m1h", fmtPct(b.m1h), pctCls(b.m1h));
  setVal(el, "m4h", fmtPct(b.m4h), pctCls(b.m4h));
  setVal(el, "volUsd", fmtUsd(b.volUsd));
  setVal(el, "oiUsd", fmtUsd(b.oiUsd));
  const fund = b.funding == null ? null : b.funding * 100;
  setVal(el, "funding", fund == null ? "—" : fmtPct(fund, 4), pctCls(fund));
}
