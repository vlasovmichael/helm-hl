// ─────────────────────────────────────────────────
//  Live-цены активных позиций (HL public WS, bbo)
// ─────────────────────────────────────────────────
// Статус-пакет дашборда приходит раз в 2с, и цена в карточке Active Position
// жила его тактом: между пакетами число стояло, потом прыгало. Здесь браузер
// подписан на биржу напрямую — тем же способом, что и стакан (net/orderbook.js),
// и по тем же правилам: своё WS-состояние, свой reconnect, никаких зависимостей
// от остального фронта.
//
// Почему bbo, а не allMids (замерено 31.08.2026):
//   allMids        — 0.2 кадра/сек (раз в ~5с!), 16 КБ на кадр, все 951 монета
//   activeAssetCtx — 1.0 /сек на монету
//   bbo            — 6–10 /сек на монету, ~1 КБ/с
// allMids оказался МЕДЛЕННЕЕ нынешних двух секунд — на нём вышло бы хуже, чем
// было. bbo даёт лучший край стакана на каждое его изменение; цена = середина
// между bid и ask, то есть та же величина, что сервер шлёт в статусе.
//
// 🔒 ГРАНИЦА: отсюда берётся ТОЛЬКО цена и то, что из неё считается (ход в %).
// uPnL, R и пол остаются серверными — у них уже есть владелец, и второй
// источник правды на деньгах это класс «зеркало ≠ биржа», где собрано 8 фиксов.
//
// Сервер этот поток не видит: соединение идёт из вкладки прямо на биржу, наш
// Express не нагружается вовсе (инцидент 26.08 был как раз про вкладку, которая
// дёргала бэкенд).

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Цена старше этого считается протухшей: лучше показать серверную, чем врать
// свежестью. bbo идёт несколько раз в секунду, так что до порога дело доходит
// только когда соединение реально умерло.
const STALE_MS = 15_000;

let ws = null;
let reconnectTimer = null;
let retryDelay = RECONNECT_BASE_MS;
let started = false;

const prices = new Map();       // COIN → { px, ts }
const watched = new Set();      // монеты, на которые подписаны
const listeners = new Set();    // fn(Set<coin>) — какие монеты изменились
let pending = new Set();        // накопленные изменения до следующего кадра
let frame = null;

/** Живая цена монеты. null — нет данных или протухли. */
export function getLivePrice(coin) {
  const rec = prices.get(String(coin || "").toUpperCase());
  if (!rec || Date.now() - rec.ts > STALE_MS) return null;
  return rec.px;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* сокет умирает — переподписка произойдёт на onopen */
    }
  }
}

const sub = (coin, on) => ({
  method: on ? "subscribe" : "unsubscribe",
  subscription: { type: "bbo", coin },
});

/**
 * Монеты, за которыми следим. Подписка держится ровно на них: закрыл позицию —
 * поток по её монете сразу гаснет, а не копится до перезагрузки вкладки.
 */
export function setWatchedCoins(coins) {
  const next = new Set((coins || []).map((c) => String(c).toUpperCase()).filter(Boolean));
  for (const coin of watched) {
    if (!next.has(coin)) {
      send(sub(coin, false));
      watched.delete(coin);
      prices.delete(coin);
    }
  }
  for (const coin of next) {
    if (!watched.has(coin)) {
      watched.add(coin);
      send(sub(coin, true));
    }
  }
}

/** Подписка на тик. Возвращает функцию отписки. */
export function onPriceTick(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Рендер раз в кадр, а не на каждое сообщение: bbo прилетает до десяти раз в
// секунду на монету, и дёргать DOM на каждое было бы дороже самого обновления.
function schedule(coin) {
  pending.add(coin);
  if (frame != null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const changed = pending;
    pending = new Set();
    for (const fn of listeners) {
      try {
        fn(changed);
      } catch (err) {
        console.error("[PriceStream] listener failed:", err);
      }
    }
  });
}

function handleBbo(data) {
  const coin = String(data?.coin || "").toUpperCase();
  if (!coin || !watched.has(coin)) return;
  const bid = Number(data?.bbo?.[0]?.px);
  const ask = Number(data?.bbo?.[1]?.px);
  // Одностороннюю книгу пропускаем: середины у неё нет, а показывать одну
  // сторону как «цену» значит соврать на величину спреда.
  if (!(bid > 0) || !(ask > 0)) return;
  const px = (bid + ask) / 2;
  const prev = prices.get(coin);
  prices.set(coin, { px, ts: Date.now() });
  if (!prev || prev.px !== px) schedule(coin);
}

function connect() {
  let sock;
  try {
    sock = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    retryDelay = RECONNECT_BASE_MS;
    // Переподписываемся на всё, за чем следим: после обрыва биржа нас не помнит.
    for (const coin of watched) send(sub(coin, true));
  };

  sock.onmessage = (e) => {
    if (ws !== sock) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.channel === "bbo") handleBbo(msg.data);
    } catch {
      /* мусорный кадр — ждём следующий */
    }
  };

  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      /* уже закрыт */
    }
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer || !started) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
}

/** Поднять поток. Повторные вызовы безвредны. */
export function startPriceStream() {
  if (started) return;
  started = true;
  connect();
}
