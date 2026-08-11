import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  lab.html — research-страница: реестр стратегий + закрытые вердикты.
//  2026-08-11: сняты BTC Divergence, Whale Watch и Spike-Fade. Первые два не
//  использовались и не валидировались; третий показывал замёрзший снимок —
//  mid-based замер снят 21.07, форвард копит наследник liq-wick (отдельный
//  контейнер, data/liq-wick/events.jsonl). Побочно ушёл их тяжёлый HL-поллинг
//  (candleSnapshot / metaAndAssetCtxs / whale clearinghouseState) — ради него
//  страницу и выносили с главной 2026-06-17.
//  Код фич цел в web/src/features/ — вернуть = импорт + разметка.
// ─────────────────────────────────────────────────

import {
  bindTheme,
  initWebSocket,
  startFooterTimer,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { renderStrategies } from "./src/features/strategies.js";
import { refreshLeaderboardPersistence } from "./src/features/leaderboardPersistence.js";

// ── Bootstrap ──
mountTopnav("lab");
bindTheme();
// WS: таблица Strategies — данные приходят в status-payload (data.strategies).
initWebSocket({
  onStatus: (data) => renderStrategies(data.strategies),
});
// Персистентность лидерборда: снимки недельные, счёт кэширован на 6ч —
// поллить незачем, тянем один раз при открытии страницы.
refreshLeaderboardPersistence();
startFooterTimer();
