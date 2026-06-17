import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  lab.html — research-страница: BTC Divergence + Whale Watch.
//  Вынесены с торгового дашборда (index), чтобы их тяжёлый HL-поллинг
//  (candleSnapshot / metaAndAssetCtxs / whale clearinghouseState) грузился
//  ТОЛЬКО когда открыта Lab, а не на каждой вкладке главной → разгрузка
//  весового бюджета HL и защита торговых чтений от 429. 2026-06-17.
// ─────────────────────────────────────────────────

import {
  bindTheme,
  initWebSocket,
  startFooterTimer,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import {
  initWhaleWatch,
  setOnPositionsUpdated,
} from "./src/features/whaleWatch.js";
import {
  divRefresh,
  renderBtcDivergence,
  initDivergenceUi,
} from "./src/features/divergence.js";

// ── Bootstrap ──
mountTopnav("lab");
bindTheme();
// WS нужен только ради push-сигнала btc-divergence (свежий снапшот). onStatus —
// no-op: equity/позиции Lab не показывает.
initWebSocket({ onStatus: () => {}, onDivergence: () => divRefresh() });
initDivergenceUi();
divRefresh();
// Whale-bias подмешивается в таблицу divergence → при обновлении китов
// пере-рендерим divergence (как было на главной).
setOnPositionsUpdated(() => renderBtcDivergence(null));
initWhaleWatch();
startFooterTimer();
