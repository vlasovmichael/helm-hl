import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  index.html — «радар»: header/position, divergence, hot movers,
//  market context, setup scanner, whale watch, trade-модалка.
//  Графики/strategies/pnl/logs живут на других страницах — сюда не грузятся.
// ─────────────────────────────────────────────────

import {
  REFRESH_MS,
  fmtTime,
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
} from "./src/features/accountStatus.js";
import { renderHotMovers } from "./src/hotMovers/render.js";
import { renderMarketContext } from "./src/features/marketContext.js";
import {
  initWhaleWatch,
  setOnPositionsUpdated,
} from "./src/features/whaleWatch.js";
import {
  divRefresh,
  renderBtcDivergence,
  initDivergenceUi,
} from "./src/features/divergence.js";
import { initModals } from "./src/features/modals.js";
import {
  initSetupScanner,
  renderSmartSignals,
  fetchMacroIfStale,
  setSwingEquity,
  setHmSignals,
  setBtcMomentum1m,
  markTickReady,
  updateSetupLivePrice,
} from "./src/features/setupScanner.js";

// WS шлёт hotMovers каждые ~2с. Пока поток живой — HTTP-фолбэк /api/signals
// в tick() не дёргаем (был бы дубликат тех же данных).
const WS_HOTMOVERS_FRESH_MS = 8000;
let lastWsHotMoversAt = 0;

function onStatus(data) {
  if (Number.isFinite(data.equity)) setSwingEquity(data.equity);
  renderHeader(data);
  updateActiveCoinSet(data.activePosition, data.manualPositions);
  updateSetupLivePrice(); // живая стрелка цены активной монеты в Setup (≤2с)
  renderPosition(data.activePosition);
  renderManualPositions(data.manualPositions);
  renderBans(data);
  // Hot Movers из WS (≤2с) вместо 10с-поллинга; HTTP /api/signals в tick() = фолбэк.
  if (data.hotMovers?.signals) {
    setHmSignals(data.hotMovers.signals);
    renderHotMovers(data.hotMovers, fmtTime);
    lastWsHotMoversAt = Date.now();
  }
}

async function tick() {
  // Фолбэк /api/signals только если WS не присылал hotMovers недавно.
  const wsHotFresh = Date.now() - lastWsHotMoversAt < WS_HOTMOVERS_FRESH_MS;
  const [hmR, btcR, mcR] = await Promise.allSettled([
    wsHotFresh ? Promise.resolve(null) : fetchJson("/api/signals?limit=30"),
    fetchJson("/api/candles?coin=BTC&interval=1m"),
    fetchJson("/api/market-context"),
  ]);
  if (mcR.status === "fulfilled") renderMarketContext(mcR.value);
  if (hmR.status === "fulfilled" && hmR.value?.signals) {
    setHmSignals(hmR.value.signals);
    renderHotMovers(hmR.value, fmtTime);
  }
  if (
    btcR.status === "fulfilled" &&
    Array.isArray(btcR.value) &&
    btcR.value.length >= 2
  ) {
    const candles = btcR.value;
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const prevClose = prev?.c ?? prev?.close;
    const lastClose = last?.c ?? last?.close;
    if (prevClose && lastClose) {
      setBtcMomentum1m(((lastClose - prevClose) / prevClose) * 100);
    }
  }
  await fetchMacroIfStale();
  markTickReady();
  renderSmartSignals();
  markSuccess();
}

// ── Bootstrap ──
mountTopnav("dashboard");
bindTheme();
bindRange(() => tick());
initModals();
initWebSocket({ onStatus, onDivergence: () => divRefresh() });
tick();
initDivergenceUi();
divRefresh();
setOnPositionsUpdated(() => renderBtcDivergence(null));
initWhaleWatch();
setInterval(tick, REFRESH_MS);
startFooterTimer();
initSetupScanner({ fmtTime });
