// ─────────────────────────────────────────────────
//  DEV-ONLY мок активной монеты. Грузится ТОЛЬКО при ?mock=1 (динамический
//  импорт из index.js) → в проде его нет. Гоняет синтетический status-payload
//  через настоящий onStatus(), чтобы вживую проверить:
//   · фазную risk-bar заливку карточки uPnL/Net (стоп → храповик → профит);
//   · ракету при резком ходе цены в мою сторону (одиночный экстрим + сёрдж).
//  Никакого бэка/WS не нужно. Удалить = убрать файл + блок ?mock в index.js.
// ─────────────────────────────────────────────────

import { renderMarketContext } from "../features/marketContext.js";
import { icon } from "../core/icon.js";

// Живая цена BTC для плашки Market Context (random-walk в startMock) — odometer.
let btcPx = 109240;

// Синтетическая Hunter SHORT по UNI (как на скрине: entry 3.63, short 3x).
const POS = {
  coin: "UNI",
  side: "SHORT",
  entry: 3.63,
  stop: 3.7026, // −2% Hunter SL (для short стоп выше входа)
  tp: 3.4, // цель прибыли
  beArmPct: 1.5, // веха храповика
  sizeUsd: 68.55,
  leverage: 3,
};

let price = 3.66; // старт чуть в убытке (цена выше входа у short)
let solPeakMax = 0; // бегущий пик SOL-хода (%) — для «призрака» отката
let solTroughMin = 0; // бегущий минимум SOL-хода (%) — MAE для «dip −X%» в минусе
let raf = null;
let target = POS.tp; // куда плавно идём
let phaseDir = -1; // −1 вниз (в прибыль), +1 вверх (в убыток)

const pnlUsd = (px) => ((POS.entry - px) / POS.entry) * POS.sizeUsd; // short
const beArmed = (px) => ((POS.entry - px) / POS.entry) * 100 >= POS.beArmPct;

function buildStatus() {
  const uPnL = pnlUsd(price);
  const bot = {
    strategy: "hunter",
    stopPrice: POS.stop,
    tpPrice: POS.tp,
    beArmPct: POS.beArmPct,
    beArmed: beArmed(price),
    initialRiskPct: Math.abs((POS.entry - POS.stop) / POS.entry) * 100,
  };
  const activePosition = {
    coin: POS.coin,
    side: POS.side,
    sizeUsd: POS.sizeUsd,
    entryPrice: POS.entry,
    currentPrice: price,
    entryApy: 0,
    heldHours: 0.7,
    currentPnl: {
      netMarket: uPnL,
      netMaker: uPnL + 0.05,
      price: uPnL,
      funding: 0,
    },
    bot,
  };
  // Усыновлённая (ADOPTED) ручная LONG по SOL — чтобы вживую видеть заливку
  // uPnL-карточки и у adopted-блока. Цена идёт зеркально UNI: когда UNI падает
  // (short в плюсе), SOL «растёт» в нашу сторону (long в плюсе) тем же ходом.
  const solEntry = 150;
  const solPrice = solEntry * (1 + (POS.entry - price) / POS.entry); // тот же ход
  const solSize = 90;
  const solUpnl = ((solPrice - solEntry) / solEntry) * solSize;
  // Живой пол выхода (зеркало buildAdoptManagement): трейл при пике ≥3%, BE при
  // ≥1.5%, иначе жёсткий −2%. Даёт dev-превью настоящие Floor/R/peak-метрики.
  const solMovePct = ((solPrice - solEntry) / solEntry) * 100; // long: + при росте
  // Пик = бегущий максимум хода (high-water mark), как у настоящей няньки. На
  // спуске тура пик остаётся выше текущего → виден «призрак» отката на заливке.
  solPeakMax = Math.max(solPeakMax, solMovePct);
  const solPeakPct = Math.max(0, solPeakMax);
  // Бегущий минимум хода (MAE, ≤0) — чтобы в минусе под-строка uPnL показала
  // «dip −X%» вместо peak (см. upnlSubTxt). High-water mark вниз.
  solTroughMin = Math.min(solTroughMin, solMovePct);
  const solMaePct = Math.min(0, solTroughMin);
  let solFloorPct, solFloorKind;
  if (solPeakPct >= 3) {
    solFloorPct = solPeakPct * 0.5; // trail: пик − giveback
    solFloorKind = "trail";
  } else if (solPeakPct >= 1.5) {
    solFloorPct = 0.1;
    solFloorKind = "be";
  } else {
    solFloorPct = -2;
    solFloorKind = "stop";
  }
  const manualAdopted = {
    coin: "SOL",
    side: "LONG",
    sizeUsd: solSize,
    leverage: 3,
    entryPrice: solEntry,
    // Демо Floor-таймера: открыта 3 мин назад → жёлтый фон бежит (12 мин до конца).
    // Для состояния «часы MM:SS» поставь смещение > 15 мин, напр. - 16 * 60 * 1000.
    entryTime: Date.now() - 3 * 60 * 1000,
    currentPrice: solPrice,
    unrealizedPnl: solUpnl,
    liquidationPrice: solEntry * 0.7,
    adopted: true,
    bot: {
      stopPrice: solEntry * 0.98, // −2% (long стоп ниже входа)
      tpPrice: solEntry * 1.04,
      beArmPct: 1.5,
      beArmed: solPeakPct >= 1.5,
      initialRiskPct: 2,
      peakPct: solPeakPct,
      maePct: solMaePct,
      floorPct: solFloorPct,
      floorKind: solFloorKind,
      floorPrice: solEntry * (1 + solFloorPct / 100), // long: пол выше/ниже входа
    },
  };
  return {
    equity: 120 + uPnL,
    sessionProfit: uPnL,
    sessionStartEquity: 120,
    uptimeMin: 42,
    available: 60,
    activePosition,
    manualPositions: [manualAdopted],
    runtimeBans: [],
    btcLivePrice: btcPx, // живая цена BTC → odometer плашки Market Context
    // Мок-сигналы со спарклайнами (BTC/ETH/HYPE/DOGE) + синтез строки активной
    // монеты (UNI/SOL пиннятся сверху). Спарклайн в колонке Price едет вживую.
    hotMovers: { ts: Date.now(), universeSize: 50, signals: mockSignals(Date.now()) },
    // Плашка здоровья данных: мок гоняет её по кругу ok → warn → drift → stale,
    // иначе три из четырёх состояний видны только при настоящей аварии.
    dataHealth: mockDataHealth(),
  };
}

// ── Мок health-плашки ───────────────────────────────────────────────────────
// Цикл по состояниям раз в 6 секунд — чтобы глазами проверить все цвета и
// тултип, не дожидаясь, пока фид действительно сломается.
const MOCK_HEALTH = [
  { overall: "ok", checks: [
    { name: "price_feed", category: "freshness", status: "pass", detail: "кадр 1.2с назад, 24/мин" },
    { name: "price_drift", category: "xref", status: "pass", detail: "n=920 avgΔ=0.0166% maxΔ=0.173% (#CASHCAT)" },
    { name: "price_coverage", category: "completeness", status: "pass", detail: "1079 монет в кэше" },
  ] },
  { overall: "warn", checks: [
    { name: "price_feed", category: "freshness", status: "warn", detail: "кадр 18.4с назад, 3/мин" },
    { name: "price_drift", category: "xref", status: "pass", detail: "n=920 avgΔ=0.0210% maxΔ=0.304%" },
    { name: "price_coverage", category: "completeness", status: "pass", detail: "1079 монет в кэше" },
  ] },
  { overall: "drift", checks: [
    { name: "price_drift", category: "xref", status: "fail", detail: "n=690 avgΔ=1.8% maxΔ=4.102% (#HEMI)" },
    { name: "price_feed", category: "freshness", status: "pass", detail: "кадр 0.9с назад, 22/мин" },
    { name: "price_coverage", category: "completeness", status: "pass", detail: "1079 монет в кэше" },
  ] },
  { overall: "stale", checks: [
    { name: "price_feed", category: "freshness", status: "fail", detail: "нет коннекта (попыток 4)" },
    { name: "price_drift", category: "xref", status: "fail", detail: "нет обновлений 240с (ttl 180с)" },
    { name: "price_coverage", category: "completeness", status: "warn", detail: "12 монет в кэше" },
  ] },
];
function mockDataHealth() {
  return MOCK_HEALTH[Math.floor(Date.now() / 6000) % MOCK_HEALTH.length];
}

// ── Мок Hot Movers со спарклайнами ──────────────────────────────────────────
// Синтетические строки сканера, чтобы вживую увидеть инлайн-спарклайн цены.
// Каждая монета — своя «форма» хода (тренд вверх/вниз/чоп/флэт), линия едет во
// времени (фаза от Date.now()), как живой price-буфер. windows нужны, чтобы
// строка прошла фильтр renderHotMovers (нужен ≥1 spikePct).
const MOCK_MOVERS = [
  // UNI/SOL = активные монеты (бот/adopted) → попадают в сигналы со спарком,
  // чтобы показать: спарклайн + клик по строке работают и для активной монеты
  // (в проде бэк дотягивает удерживаемую монету в payload с тем же spark).
  { coin: "UNI", base: 3.64, amp: 0.006, drift: -0.01, freq: 1.1, htf: "down", oivol: 11 },
  { coin: "SOL", base: 149, amp: 0.008, drift: +0.014, freq: 1.6, htf: "up", oivol: 1.1 },
  { coin: "BTC", base: 109240, amp: 0.004, drift: +0.012, freq: 0.9, htf: "up", oivol: 0.95 },
  { coin: "ETH", base: 3820, amp: 0.006, drift: -0.018, freq: 1.3, htf: "down", oivol: 2.6 },
  { coin: "HYPE", base: 38.1, amp: 0.012, drift: +0.004, freq: 2.1, htf: "flat", oivol: 3.4 },
  { coin: "DOGE", base: 0.162, amp: 0.0015, drift: 0, freq: 0.6, htf: "flat", oivol: 14 },
];
const SPARK_N = 24;
// 24-точечный ряд: тренд (drift по индексу) + синус (amp) с бегущей фазой.
function mkSpark(m, t) {
  const out = [];
  const ph = (t / 6000) * m.freq; // фаза едет ~раз в 6с
  for (let i = 0; i < SPARK_N; i++) {
    const trend = m.drift * (i / (SPARK_N - 1));
    const wave = m.amp * Math.sin(ph + (i / SPARK_N) * Math.PI * 2 * m.freq);
    out.push(m.base * (1 + trend + wave));
  }
  return out;
}
function mockSignals(t) {
  return MOCK_MOVERS.map((m, idx) => {
    const spark = mkSpark(m, t);
    const price = spark[spark.length - 1];
    const sp2 = ((spark[SPARK_N - 1] - spark[SPARK_N - 3]) / spark[SPARK_N - 3]) * 100;
    const sp5 = ((spark[SPARK_N - 1] - spark[SPARK_N - 7]) / spark[SPARK_N - 7]) * 100;
    const sp15 = ((spark[SPARK_N - 1] - spark[0]) / spark[0]) * 100;
    return {
      rank: idx + 1,
      coin: m.coin,
      price,
      spark,
      windows: [
        { label: "2m", mins: 2, threshold: 1, spikePct: sp2, tier: null, side: sp2 >= 0 ? "SHORT" : "LONG" },
        { label: "5m", mins: 5, threshold: 2, spikePct: sp5, tier: null, side: sp5 >= 0 ? "SHORT" : "LONG" },
        { label: "15m", mins: 15, threshold: 3, spikePct: sp15, tier: null, side: sp15 >= 0 ? "SHORT" : "LONG" },
      ],
      trendPct: sp15,
      volMult: 0.8 + (idx % 3) * 0.6,
      oiDelta5m: (idx % 2 ? 1 : -1) * (0.5 + idx),
      oiDelta15m: (idx % 2 ? 1 : -1) * (1 + idx),
      oiVolRatio: m.oivol ?? null,
      oiUsd: (m.oivol ?? 1) * 20e6,        // синтетика для тултипа
      vol24hUsd: 20e6,
      htfTrend: m.htf,
      fadeHot: null,
      isActive: false,
    };
  });
}

let onStatusRef = null;
function push() {
  onStatusRef?.(buildStatus());
}

// Плавный авто-тур по фазам: цена ходит вход→цель→вход маленькими шагами, чтобы
// увидеть заливку «до храповика», переключение на «до профита» и обратно в убыток.
function step() {
  const dist = target - price;
  // Мелкий шаг (~0.03%/тик): держим под EXTREME/surge, чтобы тур фаз НЕ пулял
  // ракеты — полоса едет плавно, ракеты только с кнопок.
  const stepSz = Math.min(Math.abs(dist), price * 0.0003 + 0.0006);
  price += Math.sign(dist) * stepSz;
  if (Math.abs(target - price) < 0.003) {
    // дошли до края — разворачиваемся
    if (target === POS.tp) {
      target = 3.66;
      phaseDir = 1;
    } else {
      target = POS.tp;
      phaseDir = -1;
    }
  }
  push();
}

// 🚀 Сёрдж: серия мелких под-экстрим тиков вниз (favorable для short) за ~3с —
// должна накопиться в окне и пульнуть ракету через НОВЫЙ surge-путь.
function sharpDrop() {
  let n = 0;
  const iv = setInterval(() => {
    price -= price * 0.001; // ~0.1% за тик (ниже EXTREME 0.12%)
    push();
    if (++n >= 7) clearInterval(iv);
  }, 350);
}

// 🚀 Одиночный экстрим: один тик −0.3% → ракета через EXTREME-путь.
function extremeTick() {
  price -= price * 0.003;
  push();
}

function panel() {
  const el = document.createElement("div");
  el.id = "mock-panel";
  el.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;flex-direction:column;gap:6px;" +
    "background:var(--card-bg,#fff);border:1px solid var(--border,#ccc);border-radius:10px;padding:10px 12px;" +
    "font:12px/1.3 system-ui;box-shadow:0 6px 24px rgba(0,0,0,.18);min-width:180px";
  el.innerHTML =
    '<b style="font-size: var(--fs-label);letter-spacing:.04em;opacity:.7">MOCK · UNI SHORT</b>' +
    '<div id="mock-stat" style="font-family:monospace"></div>' +
    `<button id="mock-auto" class="btn btn--sm">${icon("play")} auto tour</button>` +
    `<button id="mock-surge" class="btn btn--sm">${icon("falling")} sharp slide (surge)</button>` +
    `<button id="mock-extreme" class="btn btn--sm">${icon("falling")} single extreme</button>`;
  document.body.appendChild(el);
  for (const b of el.querySelectorAll("button"))
    b.style.cssText =
      "cursor:pointer;padding:6px 8px;border:1px solid var(--border,#ccc);border-radius:6px;background:var(--card-bg-elev,#f6f8fa)";

  let auto = false;
  const autoBtn = el.querySelector("#mock-auto");
  autoBtn.onclick = () => {
    auto = !auto;
    autoBtn.innerHTML = auto
      ? `${icon("pause")} stop tour`
      : `${icon("play")} auto tour`;
    if (auto) raf = setInterval(step, 700);
    else clearInterval(raf);
  };
  el.querySelector("#mock-surge").onclick = sharpDrop;
  el.querySelector("#mock-extreme").onclick = extremeTick;

  setInterval(() => {
    const stat = el.querySelector("#mock-stat");
    const ph = beArmed(price)
      ? "profit"
      : POS.entry - price >= 0
        ? "ratchet"
        : "stop";
    stat.textContent = `px ${price.toFixed(4)} · ${ph} · ${pnlUsd(price) >= 0 ? "+" : ""}$${pnlUsd(price).toFixed(2)}`;
  }, 200);
}

// Фейковые данные плашки Market Context (структура + медленные метрики).
function mockMcData() {
  return {
    verdict: "MIXED",
    btc: {
      price: btcPx, change24h: 0.66, m15: 0.08, m1h: -0.21, m4h: 0.44,
      volUsd: 2.1e9, oiUsd: 2.0e9, funding: 0.000031,
    },
  };
}

export function startMock({ onStatus }) {
  onStatusRef = onStatus;
  panel();
  renderMarketContext(mockMcData()); // строим плашку BTC (структуру)
  push(); // первый кадр сразу
  // Random-walk цены BTC каждые 1.5с → видно odometer-анимацию плашки (и тест
  // горизонтального скролла: ширина не должна меняться).
  setInterval(() => {
    btcPx += (Math.random() - 0.5) * 50;
    push();
  }, 1500);
  // ?mock=1&tour → сразу гоняем авто-тур фаз (без клика): цена ходит
  // вход→цель→вход, пик SOL уходит выше текущего → виден «призрак» отката.
  if (/[?&]tour\b/.test(location.search)) raf = setInterval(step, 700);
  console.log("[mock] active coin simulated — panel is bottom-right");
}
