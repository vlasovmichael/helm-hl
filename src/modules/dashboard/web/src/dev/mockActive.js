// ─────────────────────────────────────────────────
//  DEV-ONLY мок активной монеты. Грузится ТОЛЬКО при ?mock=1 (динамический
//  импорт из index.js) → в проде его нет. Гоняет синтетический status-payload
//  через настоящий onStatus(), чтобы вживую проверить:
//   · фазную risk-bar заливку карточки uPnL/Net (стоп → храповик → профит);
//   · ракету при резком ходе цены в мою сторону (одиночный экстрим + сёрдж).
//  Никакого бэка/WS не нужно. Удалить = убрать файл + блок ?mock в index.js.
// ─────────────────────────────────────────────────

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
  return {
    equity: 120 + uPnL,
    sessionProfit: uPnL,
    sessionStartEquity: 120,
    uptimeMin: 42,
    available: 60,
    activePosition,
    manualPositions: [],
    runtimeBans: [],
    // пустые signals → renderHotMovers синтезирует строку активной монеты
    // (с настоящим arrow-узлом), а updateHotMoversLiveArrow гоняет ракету.
    hotMovers: { ts: Date.now(), universeSize: 50, signals: [] },
  };
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
    '<b style="font-size:11px;letter-spacing:.04em;opacity:.7">MOCK · UNI SHORT</b>' +
    '<div id="mock-stat" style="font-family:monospace"></div>' +
    '<button id="mock-auto">▶ авто-тур фаз</button>' +
    '<button id="mock-surge">🚀 резкий слайд (surge)</button>' +
    '<button id="mock-extreme">🚀 одиночный экстрим</button>';
  document.body.appendChild(el);
  for (const b of el.querySelectorAll("button"))
    b.style.cssText =
      "cursor:pointer;padding:6px 8px;border:1px solid var(--border,#ccc);border-radius:6px;background:var(--card-bg-elev,#f6f8fa)";

  let auto = false;
  const autoBtn = el.querySelector("#mock-auto");
  autoBtn.onclick = () => {
    auto = !auto;
    autoBtn.textContent = auto ? "⏸ стоп тур" : "▶ авто-тур фаз";
    if (auto) raf = setInterval(step, 700);
    else clearInterval(raf);
  };
  el.querySelector("#mock-surge").onclick = sharpDrop;
  el.querySelector("#mock-extreme").onclick = extremeTick;

  setInterval(() => {
    const stat = el.querySelector("#mock-stat");
    const ph = beArmed(price)
      ? "профит"
      : POS.entry - price >= 0
        ? "храповик"
        : "стоп";
    stat.textContent = `px ${price.toFixed(4)} · ${ph} · ${pnlUsd(price) >= 0 ? "+" : ""}$${pnlUsd(price).toFixed(2)}`;
  }, 200);
}

export function startMock({ onStatus }) {
  onStatusRef = onStatus;
  panel();
  push(); // первый кадр сразу
  // eslint-disable-next-line no-console
  console.log("[mock] активная монета засимулирована — панель справа снизу");
}
