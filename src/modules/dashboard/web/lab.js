import "./src/styles/index.scss";
import { mountPageHeader } from "./src/core/pageHeader.js";
// ─────────────────────────────────────────────────
// lab.html — research-страница: реестр стратегий + закрытые вердикты.
// Витрины с закрытым вердиктом сняты вместе с кронами, которые копили под них
// данные. Код фич цел в web/src/features/ — вернуть = импорт + разметка.
// ─────────────────────────────────────────────────

import {
  bindTheme,
  initWebSocket,
  startFooterTimer,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { renderStrategies } from "./src/features/strategies.js";
import { refreshWinners } from "./src/features/winners.js";
import { refreshFvgForward } from "./src/features/research.js";

// ── Bootstrap ──
mountPageHeader({
  status: true,
  eyebrow: "Lab",
  title: "Research · forward tests &amp; verdicts",
});
mountTopnav("lab");
bindTheme();
// WS: таблица Strategies — данные приходят в status-payload (data.strategies).
initWebSocket({
  onStatus: (data) => renderStrategies(data.strategies),
});
// Предзаявленный тест «а если взять троих»: форвард пересчитывается кроном
// раз в сутки, поллить незачем.
refreshWinners();
// Форвард FVG: коллектор пишет журнал раз в сутки по крону — поллить незачем.
refreshFvgForward();
startFooterTimer();
