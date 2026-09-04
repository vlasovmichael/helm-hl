// ─────────────────────────────────────────────────
//  Live-цены активных позиций (HL public WS, bbo)
// ─────────────────────────────────────────────────
// Статус-пакет дашборда приходит раз в 2с, и цена в карточке между пакетами
// стоит, а потом прыгает. Здесь браузер подписан на биржу напрямую — тем же
// способом, что и стакан (net/orderbook.js): своё WS-состояние, свой reconnect.
//
// 🚨 Канал именно bbo: allMids отдаёт ~0.2 кадра/сек по 16 КБ на все монеты —
// это МЕДЛЕННЕЕ нынешних двух секунд. bbo даёт 6–10 /сек на монету при ~1 КБ/с;
// цена = середина bid/ask, та же величина, что сервер шлёт в статусе.
//
// 🔒 ГРАНИЦА: отсюда берётся ТОЛЬКО цена и то, что из неё считается (ход в %).
// uPnL, R и пол остаются серверными — второй источник правды на деньгах это
// класс «зеркало ≠ биржа».
//
// Соединение идёт из вкладки прямо на биржу: наш Express не нагружается.

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

// 🚨 Регистр имени значим, и цена ошибки — весь поток. У активов builder-DEX'ов
// (HIP-3) тикер приходит как `xyz:NOK`, и биржа принимает подписку ТОЛЬКО со
// строчным префиксом площадки. У k-монет строчная сама `k`: `kPEPE`, `kSHIB`.
// На `KPEPE` биржа не отвечает ошибкой — она РВЁТ СОЕДИНЕНИЕ (close 1006), и
// цены по всем остальным монетам умирают вместе с ним.
// Дальше reconnect переподписывается на тот же неверный тикер, и цена живёт
// вспышками между разрывами с растущим backoff — «дёргается».
//
// Поэтому ключ и имя для биржи РАЗДЕЛЕНЫ. coinKey — канонический ключ карт:
// он терпит любой регистр от вызывающего, чтобы чтение цены не зависело от
// того, кто как назвал монету. wireName — имя ровно в том виде, в каком его
// дал сервер (в БД лежит точное `kPEPE`), и наружу уходит только оно.
export function coinKey(coin) {
  const s = String(coin || "");
  const i = s.indexOf(":");
  return i > 0
    ? `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1).toUpperCase()}`
    : s.toUpperCase();
}

// Ключ → имя, которым монету зовёт биржа. Заполняется из setWatchedCoins.
const wireNames = new Map();
const wireName = (key) => wireNames.get(key) ?? key;

/** Живая цена монеты. null — нет данных или протухли. */
export function getLivePrice(coin) {
  const rec = prices.get(coinKey(coin));
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

const sub = (key, on) => ({
  method: on ? "subscribe" : "unsubscribe",
  subscription: { type: "bbo", coin: wireName(key) },
});

/**
 * Монеты, за которыми следим. Подписка держится ровно на них: закрыл позицию —
 * поток по её монете сразу гаснет, а не копится до перезагрузки вкладки.
 */
export function setWatchedCoins(coins) {
  const next = new Set();
  for (const raw of coins || []) {
    if (!raw) continue;
    const key = coinKey(raw);
    next.add(key);
    // Имя от сервера — источник истины по регистру, поэтому обновляем всегда.
    wireNames.set(key, String(raw));
  }
  for (const key of watched) {
    if (!next.has(key)) {
      send(sub(key, false));
      watched.delete(key);
      prices.delete(key);
      wireNames.delete(key);
    }
  }
  for (const key of next) {
    if (!watched.has(key)) {
      watched.add(key);
      send(sub(key, true));
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
  // Биржа возвращает имя ровно в том виде, в каком его прислали, поэтому
  // входящий кадр приводим к ключу тем же coinKey, что и подписку.
  const coin = coinKey(data?.coin);
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
    for (const key of watched) send(sub(key, true));
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

// ── возврат во вкладку ──
// Телефон замораживает свёрнутую вкладку и рвёт сокет, но onclose при этом
// доходит не сразу: на резюме цена приезжала через ~5 секунд, тогда как
// нативный кошелёк успевает за полсекунды. Всё это время ждал не сокет, а наш
// backoff-таймер, доросший до секунд в фоне. Поэтому на возврате поднимаемся
// немедленно и с нулевой задержкой — один коннект на разворачивание.
function wake() {
  if (!started || document.visibilityState !== "visible") return;
  if (ws && ws.readyState === WebSocket.OPEN) return; // живой — не трогаем
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  retryDelay = RECONNECT_BASE_MS;
  connect();
}

/** Поднять поток. Повторные вызовы безвредны. */
export function startPriceStream() {
  if (started) return;
  started = true;
  // pageshow ловит возврат из bfcache (iOS Safari), где visibilitychange
  // может не прийти вовсе.
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("pageshow", wake);
  connect();
}
