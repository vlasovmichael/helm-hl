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
import {
  renderScreen,
  initScreenInteractions,
  initHotMoversToggle,
  hotMoversVisible,
} from "./src/features/screen.js";
import { renderMarketContext, updateBtcLivePrice } from "./src/features/marketContext.js";
import { initModals, renderActivity } from "./src/features/modals.js";
import { initWhatIf } from "./src/features/whatif.js";
import { initManualPaperTrigger, initManualPaperActive } from "./src/features/manualPaper.js";
import { initTradeTicket } from "./src/features/tradeTicket.js";

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
  // Таблица скрыта → не рендерим её вовсе: кадр всё равно приходит (он общий для
  // всех панелей), но перестраивать 30 строк в невидимом DOM смысла нет.
  if (data.hotMovers?.signals && hotMoversVisible()) {
    renderHotMovers(data.hotMovers, fmtTime);
    lastWsHotMoversAt = Date.now();
  }
  // Живой спин стрелки активной монеты в Hot Movers (≤2с) — после рендера, чтобы
  // спин ставился на уже смонтированный узел и не сбрасывался перестроением строк.
  if (hotMoversVisible()) updateHotMoversLiveArrow();
}

// Каждая панель рисуется САМА, как только пришли её данные. Раньше здесь стоял
// `await Promise.allSettled([...])` и рендер шёл после САМОГО МЕДЛЕННОГО ответа:
// /api/market-context ходит в HL и на загруженном весовом бюджете отвечает
// секундами — а ждали его локальные Activity и P/L, которым HL вообще не нужен.
// Отсюда и «страница долго грузится». Ошибка одной панели не роняет остальные.
function tick() {
  const paint = (promise, render) => promise.then(render).catch(() => {});

  // Экран монет: отбор по цене входа + бюджет дня. Ликвидность на сервере
  // кэшируется 120с, так что поллинг тут дешёвый.
  //
  // Свой catch вместо общего paint(): при сетевом сбое (дашборд перезапускается,
  // туннель моргнул) общий проглатывает ошибку молча, и в таблице навсегда
  // висит стартовое «Building screen…». Пробрасываем провал в рендер — он
  // покажет причину и «Retrying…», а уже нарисованный список не тронет.
  fetchJson("/api/screen")
    .then((d) => renderScreen(d))
    .catch((err) =>
      renderScreen({ ok: false, reason: "dashboard unreachable", message: err?.message }),
    );

  // Фолбэк /api/signals только если WS не присылал hotMovers недавно И таблица
  // раскрыта — скрытая карточка не должна дёргать сеть.
  const wsHotFresh = Date.now() - lastWsHotMoversAt < WS_HOTMOVERS_FRESH_MS;
  if (!wsHotFresh && hotMoversVisible()) {
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
    // fees today/7d — цена оборота перед глазами (пожиратель №1, аудит 02.07).
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
function initTradeButton() {
  const btn = document.getElementById("tt-trade-btn");
  if (!btn) return;
  const post = async (path, body) => {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401) window.location.href = "/login";
    return r.json();
  };
  // Закрытие позиции прямо с карточки. Делегируем с контейнера: карточки
  // перерисовываются каждый тик, вешать слушатель на кнопку бессмысленно.
  //
  // Два клика, а не один: первый переводит кнопку в «Sure?», второй закрывает.
  // Это необратимая операция живыми деньгами, и промах мышью тут стоит позиции.
  // Через 4 секунды взвод сам сбрасывается.
  const armed = new Map(); // coin → timeoutId
  document.getElementById("manual-positions-container")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-posclose]");
    if (!btn) return;
    const coin = btn.dataset.posclose;
    const label = btn.querySelector("span") || btn;

    if (!armed.has(coin)) {
      label.textContent = "Sure?";
      btn.classList.add("is-armed");
      armed.set(coin, setTimeout(() => {
        armed.delete(coin);
        label.textContent = "Close";
        btn.classList.remove("is-armed");
      }, 4000));
      return;
    }
    clearTimeout(armed.get(coin));
    armed.delete(coin);
    btn.disabled = true;
    btn.classList.remove("is-armed");
    label.textContent = "…";

    // Общий возврат в исходное. Раньше сброс висел ТОЛЬКО на ветке `!res.ok`,
    // а ветка catch (сеть отвалилась, сервер вернул не-JSON) оставляла кнопку
    // в «failed» навсегда — до перезагрузки страницы.
    const fail = (msg) => {
      label.textContent = "failed";
      btn.title = msg;
      btn.classList.add("is-failed");
      btn.disabled = false;
      setTimeout(() => {
        label.textContent = "Close";
        btn.classList.remove("is-failed");
        btn.title = "Close the whole position at market (taker 4.32 bp, no builder fee)";
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
    getContext: async (coin) => {
      const r = await fetch(`/api/ticket/context?coin=${encodeURIComponent(coin || "")}`);
      if (r.status === 401) window.location.href = "/login";
      return r.json();
    },
    open: (payload) => post("/api/ticket/open", payload),
    close: (payload) => post("/api/ticket/close", payload),
  });
  btn.addEventListener("click", () => ticket.open());

  // Клик по строке экрана открывает тот же тикет на выбранной монете. Сторону и
  // размер оператор выбирает в модалке — карточка ничего за него не решает.
  initScreenInteractions((coin) => ticket.open({ coin }));
}

// ── Bootstrap ──
mountTopnav("dashboard");
bindTheme([]);
bindRange(() => tick());
initModals();
initWhatIf();
initManualPaperTrigger("mp-paper-btn");
initManualPaperActive();
initTradeButton();
// Переключатель Hot Movers ПОСЛЕ инициализации Paper/What-if: он переносит их
// кнопки между шапками, и слушатели должны быть уже навешены на сами узлы.
initHotMoversToggle();
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
