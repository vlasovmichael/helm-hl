import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// Lab — research-страница: реестр стратегий + предзаявленные форвард-тесты.
//
// Страница живёт под роутером: разметку рисует render(), а живое — опрос
// витрины чужих сигналов, сокет и секундный футер — гасит его остановка.
// ─────────────────────────────────────────────────

import { mountPageHeader } from "./src/core/pageHeader.js";
import {
  initWebSocket,
  startFooterTimer,
} from "./src/core/shell.js";
import { renderStrategies } from "./src/features/strategies.js";
import { refreshWinners } from "./src/features/winners.js";
import { refreshFvgForward } from "./src/features/research.js";
import { refreshTgSignalLab, mountTgSignalLabSkeleton } from "./src/features/tgSignals.js";

// Форвард по чужим прогнозам: позы открываются редко, минуты опроса хватает.
const TG_POLL_MS = 60_000;

const skeletonRow = (cols) =>
  `<tr class="sk-row">${'<td><span class="sk"></span></td>'.repeat(cols)}</tr>`;

function view() {
  return `
    <header id="page-header"></header>

    <!-- 01 / Режимы ведения позиции (реестр-driven). Данные — из WS
         status-payload (msg.data.strategies). Live/Paper/Radar. -->
    <section class="card" id="sec-strategies">
      <div class="card-header">
        <div
          class="card-title"
          data-card="How positions are run, in one place. Live trades real money; Paper accumulates stats in a shadow slot, separate from production."
        >
          How positions are run
        </div>
        <div class="seg" id="strategies-summary"></div>
      </div>
      <div class="table-wrap strat-table-wrap">
        <table class="table table--compact table--sticky-head strat-table" id="strategies-table">
          <thead>
            <tr>
              <th class="strat-col-name">Strategy</th>
              <th data-card="Operating mode">Status</th>
              <th data-card="Open position (slot / paper slot)">Position</th>
              <th class="num" data-card="Virtual equity of the compounding paper sandbox">Equity</th>
              <th class="num" data-card="Number of closed trades">Trades</th>
              <th class="num" data-card="Share of winners">Win%</th>
              <th class="num" data-card="Expectancy per trade (avg net)">Exp</th>
              <th class="num" data-card="Payoff = avgWin / |avgLoss|. ≥2 is a healthy profile">Payoff</th>
              <th class="num" data-card="Max drawdown on the net P&L curve">Max DD</th>
              <th class="num" data-card="Net P&L today">Today</th>
              <th class="num" data-card="Net P&L over 7 days">7d</th>
              <th class="num" data-card="Net P&L all time">All</th>
              <th class="strat-col-spark" data-card="Cumulative P&L curve">Trend</th>
            </tr>
          </thead>
          <tbody id="strategies-tbody">${skeletonRow(13).repeat(5)}</tbody>
        </table>
      </div>
    </section>

    <!-- 01.8 / Wall Street geniuses — предзаявленный форвардный тест: три
         адреса с вершины лидерборда против контрольной группы. Правила в
         docs/winners-preregistration.md. -->
    <section class="card" id="sec-winners">
      <div class="card-header">
        <div
          class="card-title"
          data-card="Question: decile medians say nothing about the three best addresses inside a decile. Here the list of three was frozen IN ADVANCE and is checked forward."
        >
          Wall Street geniuses
        </div>
        <span id="win-meta" class="lab-meta"></span>
      </div>
      <div class="u-scroll-x">
        <table class="table table--sticky-head signals-table" id="win-table">
          <thead>
            <tr>
              <th data-card="Hyperliquid address: the arrow expands its open positions right now (coin, side, leverage, floating PnL); the link itself opens the explorer">Address</th>
              <th class="num" data-card="Edge the address was selected on: profit per dollar of turnover in the month before the freeze">Selection, bp</th>
              <th class="num" data-card="Edge AFTER the freeze — the only number here that means anything">Forward, bp</th>
              <th class="num" data-card="Profit after the freeze">PnL</th>
              <th class="num" data-card="Turnover after the freeze">Turnover</th>
            </tr>
          </thead>
          <tbody id="win-tbody">${skeletonRow(5).repeat(4)}</tbody>
        </table>
      </div>
      <div id="win-stats" class="lab-stats"></div>
      <!-- Лента событий: пуш от winnersWatch холодный и живёт сутки, а таблица
           выше показывает только открытое сейчас. Здесь закрытая позиция
           остаётся вместе с исходом. -->
      <div class="win-log-block">
        <div id="win-log-head">
          <span>What they did (last 7 days)</span>
          <span id="win-log-sum"></span>
        </div>
        <div class="win-log-scroll">
          <table class="table table--compact table--sticky-head" id="win-log-table">
            <thead>
              <tr>
                <th data-card="How long ago the event happened">Age</th>
                <th data-card="OPEN — position opened; CLOSE — closed; FLIP — closed and reopened on the other side">Event</th>
                <th data-card="Coin, side, leverage and notional at the moment of the event">Position</th>
                <th class="num" data-card="How long the position was held before it closed">Held</th>
                <th class="num" data-card="Realised result net of fees; an open position has no result yet">Net</th>
                <th data-card="Which of the three frozen addresses did it">Address</th>
              </tr>
            </thead>
            <tbody id="win-log">${skeletonRow(6).repeat(3)}</tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 01.9 / FVG forward test. Карточка показывает ТОЛЬКО счётчик и возраст
         последней записи: ни E[R], ни winrate. Это условие теста — stopRule
         запрещает промежуточные замеры, а увиденное число не развидеть. -->
    <section class="card" id="sec-fvg">
      <div class="card-header">
        <div
          class="card-title"
          data-card="Preregistered forward tests. Each one is evaluated exactly once, when its own stop rule is met. No interim metrics are shown — that is the point."
        >
          Forward tests
        </div>
        <span id="fvg-meta" class="lab-meta"></span>
      </div>
      <div id="fvg-body" class="lab-mono-body">
        <div class="sk-text">
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
          <span class="sk sk-line"></span>
        </div>
      </div>
    </section>

    <!-- Чужая гипотеза, не наша предзаявленная, — поэтому итог виден, но только
         с доверительным интервалом. Журнал держит и пропуски: без них «канал
         молчал» неотличимо от «не смогли открыть». -->
    <section class="card" id="sec-tg">
      <div class="card-header">
        <div
          class="card-title"
          data-card="What the channels&#39; calls actually did on paper, next to what those same channels publish about themselves."
        >
          Signal forward &middot; posted vs actual
        </div>
        <span id="tg-lab-meta" class="lab-meta"></span>
      </div>
      <div id="tg-lab-body"></div>
    </section>

    <footer id="footer-status">
      <span>Connecting to core…</span>
      <!-- Выход из шапки: ссылку никто не показывает, поэтому она скрыта
           атрибутом, а не инлайновым стилем. -->
      <a href="/logout" class="logout-link" id="logout-link" hidden>Sign out</a>
    </footer>`;
}

export default {
  title: "Helm · Lab",
  nav: "lab",

  render(outlet) {
    outlet.innerHTML = view();

    mountPageHeader({
      status: true,
      eyebrow: "Lab",
      title: "Research · forward tests &amp; verdicts",
    });

    // WS: таблица Strategies — данные приходят в status-payload.
    const stopWs = initWebSocket({
      onStatus: (data) => renderStrategies(data.strategies),
    });

    // Форварды «гениев» и FVG пересчитываются кроном раз в сутки — поллить незачем.
    refreshWinners();
    refreshFvgForward();

    mountTgSignalLabSkeleton();
    refreshTgSignalLab();
    const tgTimer = setInterval(() => {
      if (!document.hidden) refreshTgSignalLab();
    }, TG_POLL_MS);

    const stopFooter = startFooterTimer();

    return () => {
      clearInterval(tgTimer);
      stopFooter();
      stopWs();
    };
  },
};
