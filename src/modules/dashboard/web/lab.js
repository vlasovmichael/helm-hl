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
import { renderStrategies } from "./src/features/strategies.js";
import { refreshSpikeFade } from "./src/features/spikeFade.js";
import { refreshLeaderboardPersistence } from "./src/features/leaderboardPersistence.js";

// ── Bootstrap ──
mountTopnav("lab");
bindTheme();
// WS: push-сигнал btc-divergence (свежий снапшот) + таблица Strategies (перенесена
// со statistics) — данные приходят в status-payload (data.strategies).
initWebSocket({
  onStatus: (data) => renderStrategies(data.strategies),
  onDivergence: () => divRefresh(),
});
initDivergenceUi();
divRefresh();
// Whale-bias подмешивается в таблицу divergence → при обновлении китов
// пере-рендерим divergence (как было на главной).
setOnPositionsUpdated(() => renderBtcDivergence(null));
initWhaleWatch();
// Spike-Fade: forward-замер «скальпа фитилей» (HTTP-поллинг раз в 30с — файл
// дописывается редко, чаще незачем). Данные из /api/spike-fade.
refreshSpikeFade();
setInterval(refreshSpikeFade, 30_000);
// Персистентность лидерборда: снимки недельные, счёт кэширован на 6ч —
// поллить незачем, тянем один раз при открытии страницы.
refreshLeaderboardPersistence();
startFooterTimer();
