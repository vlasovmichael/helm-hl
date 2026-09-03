import "./src/styles/index.scss";
import { mountPageHeader } from "./src/core/pageHeader.js";
// ─────────────────────────────────────────────────
//  lab.html — research-страница: реестр стратегий + закрытые вердикты.
//  2026-08-28: сняты «Копировать некого», «Качество исполнения», «Межбиржевое
//  расхождение» и «Цена дисциплины» — по всем четырём вердикт получен и вопрос
//  закрыт (децили лидерборда все в минусе; достижимых окон арбитража 0; стакан
//  так и не записал ни строки). Вместе с ними сняты кроны, которые продолжали
//  копить данные для уже отвеченных вопросов. «А если взять троих» НЕ тронут:
//  это предзаявленный форвард с датой решения 10.11.2026.
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
