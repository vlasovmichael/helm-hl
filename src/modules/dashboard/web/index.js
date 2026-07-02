import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  index.html — «радар»: header/position, hot movers, market context,
//  trade-модалка.
//  Divergence/whale → /lab.html; графики/strategies/pnl/logs — др. страницы.
// ─────────────────────────────────────────────────

import {
  REFRESH_MS,
  fmtTime,
  getRangeHours,
  bindTheme,
  bindRange,
  initWebSocket,
  markSuccess,
  startFooterTimer,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { fetchJson } from "./src/net/api.js";
import { updateActiveCoinSet } from "./src/state/activeCoins.js";
import {
  renderHeader,
  renderPosition,
  renderManualPositions,
  renderBans,
  setDailyPnl,
  setActivePositionsPnl,
} from "./src/features/accountStatus.js";
import {
  renderHotMovers,
  updateHotMoversLiveArrow,
} from "./src/hotMovers/render.js";
import { renderMarketContext, updateBtcLivePrice } from "./src/features/marketContext.js";
import { initModals, renderActivity } from "./src/features/modals.js";
import { initWhatIf } from "./src/features/whatif.js";
import { initManualPaperTrigger, initManualPaperActive } from "./src/features/manualPaper.js";

// WS шлёт hotMovers каждые ~2с. Пока поток живой — HTTP-фолбэк /api/signals
// в tick() не дёргаем (был бы дубликат тех же данных).
const WS_HOTMOVERS_FRESH_MS = 8000;
let lastWsHotMoversAt = 0;

function onStatus(data) {
  renderHeader(data);
  updateActiveCoinSet(data.activePosition, data.manualPositions);
  renderPosition(data.activePosition);
  renderManualPositions(data.manualPositions);
  renderBans(data);
  // Настроение секции Active Position: Σ uPnL открытых поз (бот + ручные) — живёт
  // по WS (≤2с); Today (realized) добавляет setDailyPnl. См. refreshSectionMood.
  const upnl =
    (data.activePosition?.currentPnl?.netMarket ?? 0) +
    (Array.isArray(data.manualPositions)
      ? data.manualPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)
      : 0);
  setActivePositionsPnl(upnl);
  // Живая цена BTC в плашку Market Context (≤2с, из WS-кадра) — не ждём 10с-поллинг.
  updateBtcLivePrice(data.btcLivePrice);
  // Hot Movers из WS (≤2с) вместо 10с-поллинга; HTTP /api/signals в tick() = фолбэк.
  if (data.hotMovers?.signals) {
    renderHotMovers(data.hotMovers, fmtTime);
    lastWsHotMoversAt = Date.now();
  }
  // Живой спин стрелки активной монеты в Hot Movers (≤2с) — после рендера, чтобы
  // спин ставился на уже смонтированный узел и не сбрасывался перестроением строк.
  updateHotMoversLiveArrow();
}

async function tick() {
  // Фолбэк /api/signals только если WS не присылал hotMovers недавно.
  const wsHotFresh = Date.now() - lastWsHotMoversAt < WS_HOTMOVERS_FRESH_MS;
  const [hmR, mcR, actR, pnlR] = await Promise.allSettled([
    wsHotFresh ? Promise.resolve(null) : fetchJson("/api/signals?limit=30"),
    fetchJson("/api/market-context"),
    // Recent Activity — локальный эндпоинт (своя БД, без HL-веса), к 429 не причастен.
    fetchJson(`/api/activity?hours=${getRangeHours()}&limit=10`),
    // Дневной счётчик (Today's P/L + цель) в бот-слоте. Funding-часть кэш 5мин.
    fetchJson("/api/pnl-summary"),
  ]);
  if (mcR.status === "fulfilled") renderMarketContext(mcR.value);
  if (actR.status === "fulfilled") renderActivity(actR.value);
  if (pnlR.status === "fulfilled" && pnlR.value?.periods?.today) {
    const p = pnlR.value.periods;
    // fees today/7d — цена оборота перед глазами (пожиратель №1, аудит 02.07).
    setDailyPnl(p.today.totalPnl ?? 0, {
      today: p.today.totalFees ?? 0,
      d7: p.d7?.totalFees ?? 0,
    });
  }
  if (hmR.status === "fulfilled" && hmR.value?.signals) {
    renderHotMovers(hmR.value, fmtTime);
  }
  markSuccess();
}

// ── Bootstrap ──
mountTopnav("dashboard");
bindTheme([]);
bindRange(() => tick());
initModals();
initWhatIf();
initManualPaperTrigger("mp-paper-btn");
initManualPaperActive();
// BTC Divergence + Whale Watch вынесены на /lab.html — их HL-поллинг
// (candleSnapshot/metaAndAssetCtxs) грузится только когда открыта Lab, а не на
// торговом дашборде (разгрузка весового бюджета HL, защита от 429). 2026-06-17.
initWebSocket({ onStatus });
tick();
setInterval(tick, REFRESH_MS);
startFooterTimer();

// DEV: ?mock=1 → засимулировать активную монету (risk-bar + ракета) без бэка.
// Динамический импорт → в обычной сборке/проде модуль даже не грузится.
if (new URLSearchParams(location.search).has("mock")) {
  import("./src/dev/mockActive.js").then((m) => m.startMock({ onStatus }));
}
