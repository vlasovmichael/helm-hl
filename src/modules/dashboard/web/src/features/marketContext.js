// ─────────────────────────────────────────────────
//  Market Context bar — живая расширенная статистика по BTC.
//  Цена + 24h + движения 15m/1h/4h + объём + OI + funding.
//  Монтируется один раз, дальше обновляет значения с диффом:
//  плавный вход (стаггер) + пульс-флэш при смене чисел (framer-motion-like).
//  Цвет рамки = светофор по фону (risk-on/off).
// ─────────────────────────────────────────────────


import { sparkSvg } from "../utils/spark.js";

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

// ⛔ Цена BTC НЕ идёт по биржевому WS: на крупном числе шаг в четверть секунды
// перестаёт читаться. Цена живёт тактом статус-кадра (≤2с) — плашка отвечает
// на «какой сейчас фон», а не «сколько стоит прямо сейчас».

// Спарклайн BTC за 24h — та же линия, что в колонке цены Hot Movers (общий
// sparkSvg). Стоит между «24h» и статистикой: раньше там была пустая полоса,
// и цифра «+4.16% 24h» жила без картинки, по которой видно, как этот процент
// набрался — гэпом ночью или ровным ходом. Ряд идёт с бэка (те же 15m-свечи,
// на которых считаются 15m/1h/4h), поэтому лишних запросов к HL нет.
const MC_SPARK_H = 30;
let _lastSparkKey = "";

function renderSpark(el, spark) {
  const box = el.querySelector("#mc-spark");
  if (!box) return;
  if (!Array.isArray(spark) || spark.length < 2) {
    box.innerHTML = "";
    _lastSparkKey = "";
    return;
  }
  // Перерисовываем только при смене ряда: 10с-поллинг иначе дёргал бы DOM зря.
  const key = spark.length + ":" + spark[0] + ":" + spark[spark.length - 1];
  if (key === _lastSparkKey) return;
  _lastSparkKey = key;
  box.innerHTML = sparkSvg(spark, { w: 240, h: MC_SPARK_H, cls: "mc-spark" });
}

function buildStructure(el) {
  const head = el.querySelector("#mc-head");
  const stats = el.querySelector("#mc-stats");
  if (!head || !stats) return false;
  head.innerHTML =
    `<span class="mc-sym">BTC</span>` +
    `<span class="mc-px animated-value" id="mc-px-val" data-k="price"></span>` +
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

// Цена BTC крутится тем же odometer'ом, что Total Equity (digit-reel барабаны
// к новому значению) — без флэша цвета и, главное, БЕЗ изменения ширины: цифры
// фикс-ширины (tabular-nums) в контейнере overflow:hidden → ноль горизонтального
// сдвига (старая болячка mc-tick padding'а)..
let _lastLiveBtcAt = 0; // когда живая цена (WS, 2с) последний раз вела число
// Цена в стиле TradingView: анимации нет вовсе, вместо неё цветом помечен
// ХВОСТ числа, который изменился с прошлого показа. Направление задаёт цвет
// (выше — зелёный, ниже — красный), подсветка держится до следующей смены.
//
// Почему не одометр: крутящиеся барабаны на крупном числе читаются хуже —
// глаз ловит движение вместо цифры. Total Equity одометр оставляет себе: там
// значение меняется редко и само движение и есть событие.
let _lastBtcStr = "";
let _lastBtcPx = null;

function renderBtcPrice(_el, price) {
  if (price == null) return;
  const el = document.getElementById("mc-px-val");
  if (!el) return;
  const next = fmtPrice(price);
  if (next === _lastBtcStr) return;

  // Общий префикс сравниваем как строки: «$77,356.0» → «$77,344.2» даёт
  // одинаковую голову «$77,3» и разный хвост. Разряды при этом не разъезжаются,
  // потому что формат один и тот же.
  const prev = _lastBtcStr;
  let i = 0;
  while (i < next.length && i < prev.length && next[i] === prev[i]) i++;
  const dirCls = !prev ? "" : price > _lastBtcPx ? "mc-px-up" : "mc-px-dn";

  el.textContent = "";
  if (i > 0) {
    const head = document.createElement("span");
    head.textContent = next.slice(0, i);
    el.appendChild(head);
  }
  if (i < next.length) {
    const tail = document.createElement("span");
    tail.className = dirCls;
    tail.textContent = next.slice(i);
    el.appendChild(tail);
  }
  _lastBtcStr = next;
  _lastBtcPx = price;
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
  // Цену ведёт живой WS-кадр (updateBtcLivePrice, ≤2с). 10с-поллинг трогает цену
  // ТОЛЬКО если живая замолчала >6с (WS умер) — иначе был бы откат назад к более
  // старому значению каждые 10с. Остальные метрики (15m/1h/4h/vol/oi/fund) — тут.
  if (Date.now() - _lastLiveBtcAt > 6000) renderBtcPrice(el, b.price);
  setVal(el, "change24h", `${fmtPct(b.change24h)} <i>24h</i>`, pctCls(b.change24h));
  renderSpark(el, b.spark);
  setVal(el, "m15", fmtPct(b.m15), pctCls(b.m15));
  setVal(el, "m1h", fmtPct(b.m1h), pctCls(b.m1h));
  setVal(el, "m4h", fmtPct(b.m4h), pctCls(b.m4h));
  setVal(el, "volUsd", fmtUsd(b.volUsd));
  setVal(el, "oiUsd", fmtUsd(b.oiUsd));
  const fund = b.funding == null ? null : b.funding * 100;
  setVal(el, "funding", fund == null ? "—" : fmtPct(fund, 4), pctCls(fund));
}

// Живая цена BTC из WS-кадра статуса (≤2с) — зовётся из onStatus. Обновляет
// ТОЛЬКО число цены (с тем же per-digit тиком), без перерисовки остальной плашки.
// До первого /api/market-context (structure не построена) — тихо no-op.
export function updateBtcLivePrice(price) {
  if (price == null || !Number.isFinite(price) || !built) return;
  const el = document.getElementById("market-context");
  if (!el) return;
  _lastLiveBtcAt = Date.now();
  renderBtcPrice(el, price);
}
