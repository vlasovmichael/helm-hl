// ─────────────────────────────────────────────────
//  Dashboard — «радар»: шапка/позиция, hot movers, screen, market context,
//  лента событий, trade-модалка.
//
//  🚨 Самая нагруженная страница: два таймера, сокет, слушатель возврата
//  вкладки и четыре фичи со своим поллингом. Всё это гасит одна остановка —
//  иначе каждый возврат добавляет ещё один тик и ещё одно соединение.
// ─────────────────────────────────────────────────
import "./src/styles/index.scss";
import { paintIcons } from "./src/core/icon.js";
import {
  REFRESH_MS,
  fmtTime,
  getRangeHours,
  bindRange,
  initWebSocket,
  markSuccess,
  startFooterTimer,
} from "./src/core/shell.js";
import { stampEdition, initBottomNav } from "./src/core/pageChrome.js";
import { initReveal } from "./src/core/reveal.js";
import { initTapeBar } from "./src/features/tapeBar.js";
import { initRadarAccordions } from "./src/features/radarAccordions.js";
import { fetchJson } from "./src/net/api.js";
import { updateActiveCoinSet } from "./src/state/activeCoins.js";
import {
  renderHeader,
  renderPosition,
  renderManualPositions,
  renderBans,
  setDailyPnl,
  setActivePositionsPnl,
  stopFloorTimerTick,
  resetAccountStatus,
} from "./src/features/accountStatus.js";
import {
  renderHotMovers,
  updateHotMoversLiveArrow,
} from "./src/hotMovers/render.js";
import {
  renderScreen,
  initScreenInteractions,
} from "./src/features/screen.js";
import {
  renderMarketContext,
  updateBtcLivePrice,
  resetMarketContext,
} from "./src/features/marketContext.js";
import { initModals, renderActivity } from "./src/features/modals.js";
import { initWhatIf } from "./src/features/whatif.js";
import {
  initManualPaperTrigger,
  initManualPaperActive,
  stopManualPaperActive,
} from "./src/features/manualPaper.js";
import { initTgSignalPositions, stopTgSignalPositions } from "./src/features/tgSignals.js";
import { initTradeTicket } from "./src/features/tradeTicket.js";
import { readJson as parseApi } from "./src/utils/api.js";

// WS шлёт hotMovers каждые ~2с. Пока поток живой — HTTP-фолбэк /api/signals
// в tick() не дёргаем (был бы дубликат тех же данных).
const WS_HOTMOVERS_FRESH_MS = 8000;
const CHASE_FORWARD_MS = 600_000;
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

// Каждая панель рисуется САМА, как только пришли её данные.
// 🚨 Не собирать это обратно в общий await: рендер пойдёт по самому медленному
// ответу, а /api/market-context ходит в HL и на забитом весовом бюджете отвечает
// секундами — локальные панели ждали бы биржу без всякой нужды.
function tick() {
  const paint = (promise, render) => promise.then(render).catch(() => {});

  // Экран монет: отбор по цене входа + бюджет дня. Ликвидность на сервере
  // кэшируется 120с, так что поллинг тут дешёвый.
  //
  // Свой catch вместо общего paint(): при сетевом сбое общий проглатывает ошибку
  // молча, и в таблице навсегда висит стартовое «Building screen…». Пробрасываем
  // провал в рендер — он покажет причину и «Retrying…».
  fetchJson("/api/screen")
    .then((d) => renderScreen(d))
    .catch((err) =>
      renderScreen({ ok: false, reason: "dashboard unreachable", message: err?.message }),
    );

  // Фолбэк /api/signals только если WS не присылал hotMovers недавно.
  const wsHotFresh = Date.now() - lastWsHotMoversAt < WS_HOTMOVERS_FRESH_MS;
  if (!wsHotFresh) {
    paint(fetchJson("/api/signals?limit=30"), (d) => {
      if (d?.signals) renderHotMovers(d, fmtTime);
    });
  }

  // Локальные эндпоинты (своя БД, без HL-веса) — рисуются первыми, не ждут биржу.
  paint(
    fetchJson(`/api/activity?hours=${getRangeHours()}&limit=10`),
    (d) => renderActivity(d),
  );
  // Дневной счётчик (Today's P/L + цель) в бот-слоте. Funding-часть кэш 5мин.
  paint(fetchJson("/api/pnl-summary"), (d) => {
    if (!d?.periods?.today) return;
    const p = d.periods;
    // fees today/7d — цена оборота перед глазами (пожиратель №1).
    setDailyPnl(p.today.totalPnl ?? 0, {
      today: p.today.totalFees ?? 0,
      d7: p.d7?.totalFees ?? 0,
    });
  });

  // Единственная панель, зависящая от HL — приходит когда придёт, никого не держит.
  paint(fetchJson("/api/market-context"), (d) => renderMarketContext(d));

  markSuccess();
}

// ── Trade Ticket: кнопка в шапке Active Position ──
// Ордера уходят на биржу через API-кошелёк бота: builder-fee 0 бп и кошелёк не
// всплывает. Стоп и сопровождение остаются у няньки — модалка их только
// показывает (см. features/tradeTicket.js, «граница ответственности»).
const toLogin = () => {
  window.location.href = "/login";
};

function initTradeButton() {
  const btn = document.getElementById("tt-trade-btn");
  if (!btn) return;
  const post = async (path, body) =>
    parseApi(
      await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      toLogin,
    );
  // Закрытие позиции прямо с карточки. Делегируем с контейнера: карточки
  // перерисовываются каждый тик, вешать слушатель на кнопку бессмысленно.
  //
  // Два клика, а не один: первый переводит кнопку в «Sure?», второй закрывает.
  // Это необратимая операция живыми деньгами, и промах мышью тут стоит позиции.
  // Через 4 секунды взвод сам сбрасывается.
  const armed = new Map(); // coin → timeoutId
  document.getElementById("manual-positions-container")?.addEventListener("click", async (e) => {
    const closeBtn = e.target.closest("[data-posclose]");
    if (!closeBtn) return;
    const coin = closeBtn.dataset.posclose;
    const label = closeBtn.querySelector("span") || closeBtn;

    if (!armed.has(coin)) {
      label.textContent = "Sure?";
      closeBtn.classList.add("is-armed");
      armed.set(coin, setTimeout(() => {
        armed.delete(coin);
        label.textContent = "Close";
        closeBtn.classList.remove("is-armed");
      }, 4000));
      return;
    }
    clearTimeout(armed.get(coin));
    armed.delete(coin);
    closeBtn.disabled = true;
    closeBtn.classList.remove("is-armed");
    label.textContent = "…";

    // 🚨 Общий возврат в исходное нужен и ветке catch: без него сетевой сбой
    // оставлял кнопку в «failed» навсегда — до перезагрузки страницы.
    const fail = (msg) => {
      label.textContent = "failed";
      closeBtn.dataset.card = msg;
      closeBtn.classList.add("is-failed");
      closeBtn.disabled = false;
      setTimeout(() => {
        label.textContent = "Close";
        closeBtn.classList.remove("is-failed");
        closeBtn.dataset.card = "Close the whole position at market (taker 4.32 bp, no builder fee)";
      }, 4000);
    };

    try {
      const res = await post("/api/ticket/close", { coin, pct: 100, orderType: "market" });
      if (res?.ok) {
        label.textContent = "closed";
        // Кнопку не разблокируем: позиция уходит, карточка исчезнет сама на
        // ближайшем тике. Разблокировка тут дала бы окно для второго закрытия.
      } else {
        fail(res?.error || "exchange rejected the order");
      }
    } catch (err) {
      fail(err?.message || "network unavailable");
    }
  });

  const ticket = initTradeTicket({
    getContext: async (coin) =>
      parseApi(await fetch(`/api/ticket/context?coin=${encodeURIComponent(coin || "")}`), toLogin),
    open: (payload) => post("/api/ticket/open", payload),
    close: (payload) => post("/api/ticket/close", payload),
  });
  btn.addEventListener("click", () => ticket.open());

  // Клик по строке экрана открывает тот же тикет на выбранной монете. Сторону и
  // размер оператор выбирает в модалке — карточка ничего за него не решает.
  initScreenInteractions((coin) => ticket.open({ coin }));
}

// Счётчик форвард-замера под таблицей: сколько сделок из 60 набрано с момента
// регистрации гипотезы, за которую отвечают метка COSTLY и колонка Move.
// Счётчик двигается только на закрытии сделки, поэтому опрос редкий.
async function loadChaseForward() {
  const el = document.getElementById("hm-chase-fwd");
  if (!el) return;
  try {
    const d = await fetchJson("/api/entry-filter");
    const fw = d?.forward;
    if (!fw || fw.n == null) return;
    el.hidden = false;
    el.innerHTML = `<b>COSTLY mark — forward check:</b> <b>${fw.n}</b> of <b>${fw.target}</b>
      fresh trades logged since the rule was registered. It was found in past data, so it is
      judged <b>once</b>, at ${fw.target} — looking earlier is what turned five previous ideas
      into noise.`;
  } catch {
    /* счётчик — не данные для решения: сетевой сбой оставляет строку скрытой */
  }
}

// ── Вкладка вернулась из фона: доигрываем застрявшие transition'ы ──────────
// 🚨 В СКРЫТОЙ вкладке таймлайн анимаций стоит, и переход висит на СТАРТОВОМ
// значении: плашка остаётся с серым базовым цветом, хотя класс на ней уже
// другой. Лечим не отключением анимации, а доигрыванием на возврате.
function finishStuckTransitions() {
  if (document.visibilityState !== "visible") return;
  for (const a of document.getAnimations()) {
    // Только переходы: у бесконечных keyframes-анимаций finish() бросает.
    if (a.playState !== "running" || a.constructor.name !== "CSSTransition") continue;
    try { a.finish(); } catch { /* бесконечная — не наше дело */ }
  }
}

// DEV-моки без бэка. Динамический импорт → в проде модули даже не грузятся.
//   ?mock=1  — активная монета (risk-bar + ракета);
//   ?mock=hm — тики Hot Movers: порядок монет меняется каждые 2с.
function startMocks() {
  const params = new URLSearchParams(location.search);
  const mock = params.get("mock");
  if (mock === "hm" && params.get("states")) {
    import("./src/dev/mockHotMovers.js").then((m) =>
      m.startHotMoversStates({ flushDir: params.get("flush") || "up" }),
    );
  } else if (mock === "hm") {
    // &pos=SOL,BTC — открытые позиции: с ними у строк появляются под-строки,
    // на которых и проверяется высота карточки.
    const pos = (params.get("pos") || "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    import("./src/dev/mockHotMovers.js").then((m) =>
      m.startHotMoversMock({ positions: pos }),
    );
  } else if (mock != null) {
    import("./src/dev/mockActive.js").then((m) => m.startMock({ onStatus }));
  }
}

const skeletonRow = (cols) =>
  `<tr class="sk-row">${'<td><span class="sk"></span></td>'.repeat(cols)}</tr>`;

function view() {
  return `
    <header data-edition="">
      <div class="equity-group">
        <div class="label">Total Equity</div>
        <!-- 🚨 Не «$0.00»: до первого кадра это НЕ ноль на счету, а
             отсутствие данных, и выглядели они одинаково. -->
        <div class="value animated-value" id="equity-value">
          <span class="sk sk-num sk-num--lg"></span>
        </div>
        <div class="delta" id="equity-delta"><span class="sk sk-chip"></span></div>
      </div>
      <div class="meta-group">
        <div class="pill-row">
          <div id="ws-pill" class="status-pill offline">WS connecting…</div>
          <!-- Плашка здоровья фидов. Пока состояние неизвестно — скелетон,
               а не пустое место: дырка в шапке читалась как «всё хорошо». -->
          <div id="health-pill" class="status-pill is-loading">
            <span class="sk sk-chip"></span>
          </div>
        </div>
        <div class="meta-info">
          <span id="uptime-val">Uptime: —</span>
          <span id="available-val">Available: —</span>
          <!-- 🚨 Прячет его renderHeader через style.display — поэтому инлайн. -->
          <span id="wallet-total-val" style="display: none"></span>
        </div>
      </div>
    </header>

    <!-- Market Context — живая статистика по BTC (цена по биржевому WS);
         цвет рамки = фон (risk-on/off). Стоит вплотную НАД позициями: фон
         рынка читается в одном движении глаза с тем, что открыто. -->
    <div
      id="market-context"
      class="market-context unknown mc-loading"
      data-card="Live BTC stats. Green frame = clear trend (RISK-ON/OFF), trade with the backdrop. Yellow = range, trading against structure is risky. Bias 15m = side suggested by the BTC lag (measured, not yet confirmed) — FLAT means BTC is quiet, the worst time to enter."
    >
      <span class="mc-loader" aria-hidden="true"><span class="loader-spinner"></span></span>
      <span class="mc-head" id="mc-head"></span>
      <span class="mc-spark-wrap" id="mc-spark" data-card="BTC price, last 24h"></span>
      <span class="mc-stats" id="mc-stats"></span>
    </div>

    <!-- 01 / Active Position -->
    <section class="card" id="sec-position">
      <div class="card-header">
        <div class="card-title">Active Position</div>
        <div id="daily-goal-badge" class="daily-goal-badge" hidden></div>
      </div>
      <div id="position-container"></div>
      <div id="manual-positions-container"></div>
      <div id="mp-active-container"></div>
      <!-- Позы по сигналам TG-каналов. Отдельная таблица, а не строки в
           бумажной: иначе не видно, в плюс ли чужие прогнозы. -->
      <div id="tg-active-container"></div>

      <!-- Ручной вход/выход прямо с дашборда. Ордера уходят через SDK, поэтому
           builder-fee = 0 бп и кошелёк не всплывает. Стоп ставит нянька.
           Стоит ПОД позициями намеренно: сначала смотришь, что уже открыто. -->
      <button
        id="tt-trade-btn"
        class="btn btn--primary btn--cta"
        type="button"
        data-card="Open or close a position. Orders go straight to Hyperliquid via the API wallet — no builder fee, no wallet popup. The bot still places the stop and runs the exit."
      >
        <i data-icon="rising"></i>Trade
      </button>
    </section>

    <!-- 01.5 / Hot Movers — live price spikes + OI delta -->
    <section class="card" id="sec-movers">
      <div class="card-header">
        <div
          class="card-title"
          data-card="Coins with the largest price moves. Setup is a context direction (dump → SHORT, pump → LONG) — NOT a trade: continuation backtests negative."
        >
          Hot Movers
        </div>
        <div class="hm-header-right">
          <span id="hm-actions-slot"></span>
          <span id="hot-movers-meta" class="hm-meta"></span>
        </div>
      </div>
      <div class="u-scroll-x hm-scroll-wrap">
        <table class="table table--sticky-head signals-table hm-table">
          <thead>
            <tr>
              <th class="hm-col-idx">#</th>
              <th>Coin</th>
              <th
                class="center"
                data-card="Side that would be an entry into the move that already happened — the journal paid for it. Silence is not a green light."
              >
                Costly side
              </th>
              <th
                class="center"
                data-card="Chase meter: how far price has already run IN THE TRADE DIRECTION from the short average (15m, 5m fallback). Lit only on a confirmed setup. Near the base — no chase; stretched — let it pull back; already gone your way — too late, wait for a retrace. You pick the 5m entry yourself."
              >
                Enter
              </th>
              <th class="num">Price</th>
              <th class="num">2m%</th>
              <th class="num">5m%</th>
              <th class="num">15m%</th>
              <th
                class="num"
                data-card="Acceleration: |2m| vs 5m extrapolation. Down = exhausting (fade), up = accelerating (avoid)"
              >
                Acc
              </th>
              <th
                class="num"
                data-card="OI change over 5 minutes. Rising = new positions; falling = closes/liquidations"
              >
                OI 5m
              </th>
              <th class="num" data-card="15m trend">
                Trend
              </th>
              <th class="num" data-card="How far the move has already gone: extreme = the hour moved 5%+, strong = 3%+, fast 15m = 1.5%+ in 15 minutes">
                Move
              </th>
            </tr>
          </thead>
          <tbody id="hot-movers-tbody">${skeletonRow(12).repeat(6)}</tbody>
        </table>
      </div>
      <!-- Счётчик форвард-замера гипотезы entry-into-continuation (метка
           COSTLY и колонка Move). Стоп-правило: смотреть результат ровно один
           раз, на 60 сделках. Счётчик живёт здесь, потому что здесь метка. -->
      <p class="hm-fwd" id="hm-chase-fwd" hidden></p>
    </section>

    <!-- 01.4 / Screen — монеты, отобранные по цене входа, + бюджет дня.
         Отбор идёт по трению (спред + комиссии), а не по движению. Обоснование
         и порог — routes/screen.js. Предсказаний здесь нет и быть не должно. -->
    <section class="card" id="sec-screen">
      <div class="card-header">
        <div
          class="card-title"
          data-card="Coins where entering is cheap. «Friction» = what share of your risk budget the round trip (book spread + two taker fees) eats. These are NOT signals: the list is filtered by cost of entry and ordered by payoff (how many round trips the last hour’s range covers), movement is shown as fact — the call is yours."
        >
          Screen
        </div>
        <div class="scr-header-right">
          <span id="screen-actions-slot"></span>
          <!-- Действия по монете живут на карточке, которая отвечает
               «куда смотреть» на главной. -->
          <button
            id="mp-paper-btn"
            class="btn"
            type="button"
            data-card="Open a paper trade (your own paper, Rabbit-style): coin, side, leverage, size off equity. The bot doesn't trade it — you run it by hand."
          >
            <i data-icon="add"></i>Paper
          </button>
          <button
            id="whatif-btn"
            class="btn"
            type="button"
            data-card="Itchy hands? Type a coin and side — the coach lays out trend, levels and a plan with stop and target, and says whether the verified edge is with you"
          >
            <i data-icon="search"></i>Check coin
          </button>
          <label class="scr-search">
            <i data-icon="search" class="scr-search-icon"></i>
            <input
              id="screen-search"
              class="field field--sm field--ticker"
              type="search"
              placeholder="Coin…"
              autocomplete="off"
              spellcheck="false"
              data-card="Filter the board by ticker. Narrows before the top-12 cut, so a coin outside the dozen is still findable. Esc clears."
            />
            <button
              class="scr-search-clear"
              type="button"
              data-screen-clear
              aria-label="Clear search"
            >
              &times;
            </button>
          </label>
          <span id="screen-meta" class="scr-meta"></span>
        </div>
      </div>
      <div id="screen-budget" class="scr-budget"></div>
      <div class="u-scroll-x">
        <table class="table scr-table">
          <thead>
            <tr>
              <th data-sort="coin" data-card="Sort by ticker">Coin</th>
              <th
                class="num"
                data-sort="payoff"
                data-card="How many times the last hour's range covers one round trip. Range is undirected and it is the one thing that persists in this data (autocorrelation 0.25); direction does not (−0.01). Below 3× the cost eats most of a typical move. This is the default order — not the size of the move, which was measured and is worse than random."
              >
                Payoff
              </th>
              <th class="num" data-sort="price" data-card="Sort by price">Price</th>
              <th
                class="num"
                data-sort="move"
                data-card="Short-window move from the bot's live price buffer (15m, falls back to 1h). Sort by size of move."
              >
                Move
              </th>
              <th class="num" data-sort="chg24h" data-card="Sort by 24h change">24h</th>
              <th
                class="num"
                data-sort="friction"
                data-card="What share of your risk budget the round trip eats: book spread + two taker fees (4.32 bp each). Small print is the raw spread. Sort cheapest first."
              >
                Friction
              </th>
              <th
                class="num"
                data-card="Same round trip, but entered and exited with a limit order: maker fee 1.44 bp each way and no spread paid. The gap to Friction is what a filled limit is worth."
              >
                Limit
              </th>
              <th class="num" data-card="Open interest in dollars, with its 1h change underneath. OI counts both sides at once — it says positions are held, never which way.">OI</th>
              <th
                data-card="Who is long. Top bar: large accounts by position size. Bottom bar: all accounts by count. a swap mark shows a gap of 12+ points between them. Source: Binance, same coin — not HL positions."
              >
                Long
              </th>
              <th class="num" data-card="Hourly funding rate. Positive means longs pay shorts.">Funding</th>
              <th
                data-card="When this coin actually moves: average bar range per UTC hour over the last week. The highlighted bar is the current hour."
              >
                Hours
              </th>
              <th
                class="num"
                data-sort="mine"
                data-card="Your own track record on this coin: net P&L, number of trades and winrate. Not a prediction about the market — a fact about you."
              >
                Mine
              </th>
              <th class="num" data-sort="volume" data-card="Sort by 24h volume">Volume</th>
            </tr>
          </thead>
          <tbody id="screen-tbody">${skeletonRow(11).repeat(5)}</tbody>
        </table>
      </div>
    </section>

    <!-- Recent Activity — лента open/close (/api/activity — локальный эндпоинт,
         своя БД сделок, без вызовов HL). -->
    <section class="card" id="sec-activity">
      <div class="card-header">
        <div class="card-title">Recent Activity</div>
      </div>
      <div id="bans-strip"></div>
      <div id="activity-container">
        <div class="activity-skeleton">
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
        </div>
      </div>
    </section>

    <footer id="footer-status">
      <span>Connecting to core…</span>
      <!-- Ссылку выхода никто не показывает — скрыта атрибутом, не стилем. -->
      <a href="/logout" class="logout-link" id="logout-link" hidden>Sign out</a>
    </footer>

    <!-- Mobile bottom navigation: scroll-spy across main sections -->
    <nav class="bottom-nav" aria-label="Sections">
      <button
        class="bottom-nav-btn active"
        data-target="sec-position"
        aria-label="Position"
      >
        <span class="nav-icon" aria-hidden="true"></span>
        <span>Pos</span>
      </button>
      <button class="bottom-nav-btn" data-target="sec-screen" aria-label="Screen">
        <span class="nav-icon" aria-hidden="true"></span>
        <span>Screen</span>
      </button>
      <button
        class="bottom-nav-btn"
        data-target="sec-movers"
        aria-label="Hot Movers"
      >
        <span class="nav-icon" aria-hidden="true"></span>
        <span>Movers</span>
      </button>
      <button
        class="bottom-nav-btn"
        data-target="sec-activity"
        aria-label="Recent Activity"
      >
        <span class="nav-icon" aria-hidden="true"></span>
        <span>Log</span>
      </button>
    </nav>

    <div id="help-modal" class="modal" hidden>
      <div class="modal__backdrop" data-close="1"></div>
      <div class="modal__panel modal__panel--wide" role="dialog" aria-modal="true">
        <div class="modal__content"></div>
      </div>
    </div>
    <div id="trade-modal" class="modal" hidden>
      <div class="modal__backdrop" data-close="1"></div>
      <div class="modal__panel" role="dialog" aria-modal="true">
        <div class="modal__content"></div>
      </div>
    </div>
    <div id="whatif-modal" class="modal" hidden>
      <div class="modal__backdrop" data-close="1"></div>
      <div class="modal__panel modal__panel--wide" role="dialog" aria-modal="true">
        <div class="modal__content"></div>
      </div>
    </div>`;
}

export default {
  title: "Helm",
  nav: "dashboard",

  render(outlet) {
    outlet.innerHTML = view();
    // 🚨 Разметка новая, а модули помнят прошлую: без сброса плашка BTC висит
    // на спиннере, а секция позиций остаётся пустой до смены состава монет.
    resetMarketContext();
    resetAccountStatus();

    // <i data-icon="…"> в статической разметке → настоящие svg.
    paintIcons();
    stampEdition();

    bindRange(() => tick());
    initModals();
    initWhatIf();
    initManualPaperTrigger("mp-paper-btn");
    initManualPaperActive();
    initTgSignalPositions();
    initTradeButton();

    const stopWs = initWebSocket({ onStatus });
    tick();
    const ticker = setInterval(tick, REFRESH_MS);
    const stopFooter = startFooterTimer();

    const stopTape = initTapeBar();
    const stopBottomNav = initBottomNav();
    const stopAccordions = initRadarAccordions();
    const stopReveal = initReveal("section.card, #market-context");

    loadChaseForward();
    const chaseTimer = setInterval(loadChaseForward, CHASE_FORWARD_MS);

    document.addEventListener("visibilitychange", finishStuckTransitions);
    startMocks();

    return () => {
      clearInterval(ticker);
      clearInterval(chaseTimer);
      stopWs();
      stopFooter();
      stopTape();
      stopBottomNav();
      stopAccordions();
      stopReveal();
      stopTgSignalPositions();
      stopManualPaperActive();
      stopFloorTimerTick();
      document.removeEventListener("visibilitychange", finishStuckTransitions);
    };
  },
};
