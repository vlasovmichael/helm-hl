// ─────────────────────────────────────────────────
//  Liquidation events — поток вынужденных закрытий с OKX
// ─────────────────────────────────────────────────
//
// Уровни ликвидаций (где чужие позиции ОБЯЗАНЫ закрыться) даёт только HL —
// их считает routes/flow.js по нашему сбору позиций. Здесь другой товар:
// СОБЫТИЯ, кого уже вынесло. Уровень пересчитывается от живой цены и потому
// всегда стоит на процент впереди, событие же случилось и не сдвинется.
//
// Площадка одна: OKX отдаёт весь рынок одной подпиской (482 инструмента) и без
// ключей. Bybit подписывается только потикерно и на тринадцати мажорах дал
// два события за минуту — управление подписками ради ручейка не окупается.
//
// ⛔ Это описание случившегося, а не цель движения: «цена идёт за
// ликвидациями» форвардом не проверено, и плашка такого не утверждает.

import WebSocket from 'ws';
import { logger } from './logger.js';
import { note } from './healthRegistry.js';

const WS_URL = process.env.OKX_WS_URL || 'wss://ws.okx.com:8443/ws/v5/public';
const INSTRUMENTS_URL = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
const ENABLED = (process.env.LIQ_EVENTS_ENABLED || 'false') === 'true';

// Окно витрины. Событие старше — выпадает из счёта, а не копится в памяти.
export const WINDOW_MS = 15 * 60_000;

// 🚨 В SWAP у OKX лежат ещё акции и индексы (AAPL, US500, XAU): instCategory
// '1' — крипта, '3' — бумаги, '4' — металлы. Без фильтра в крипто-плашку
// приедут ликвидации Теслы.
const CRYPTO_CATEGORY = '1';

// Таблица множителей живёт долго, но новые листинги появляются — освежаем.
const INSTRUMENTS_TTL_MS = 6 * 3_600_000;

const PING_INTERVAL_MS = 20_000; // OKX рвёт соединение после 30с тишины
const STALE_MS = 10 * 60_000;    // поток редкий: тишина в пару минут — норма
const STATUS_LOG_MS = 300_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// instId → { ctVal, coin }. Только крипта, только то, что умеем считать.
let contracts = new Map();
let contractsAt = 0;

// Скользящее окно событий: { t, coin, usd, side }. side — сторона позиции,
// которую вынесло: 'long' закрывают продажей, 'short' — покупкой.
let events = [];

let ws = null;
let started = false;
let stopping = false;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;
let statusTimer = null;
let lastEventAt = 0;
let seenSinceLog = 0;

/**
 * Номинал одного события в долларах.
 *
 * 🚨 `sz` приходит в КОНТРАКТАХ, а не в монетах: у BTC контракт равен 0.01 BTC,
 * у DOGE — 1000 DOGE. Без множителя число в плашке было бы выдумкой.
 *
 * @returns {number|null} null, если данных не хватает на честный счёт
 */
export function contractUsd(sz, ctVal, px) {
  const s = Number(sz);
  const v = Number(ctVal);
  const p = Number(px);
  if (!Number.isFinite(s) || !Number.isFinite(v) || !Number.isFinite(p)) return null;
  if (s <= 0 || v <= 0 || p <= 0) return null;
  return s * v * p;
}

/** Событие принадлежит окну. Вынесено отдельно ради теста границы. */
export function withinWindow(ev, now, windowMs = WINDOW_MS) {
  return Number.isFinite(ev?.t) && now - ev.t <= windowMs;
}

/**
 * Свод по окну: сколько вынесло лонгов и шортов.
 * `coin` = null → весь крипторынок.
 */
export function summarize(list, { coin = null, now = Date.now(), windowMs = WINDOW_MS } = {}) {
  let longUsd = 0;
  let shortUsd = 0;
  let n = 0;
  for (const ev of list) {
    if (!withinWindow(ev, now, windowMs)) continue;
    if (coin && ev.coin !== coin) continue;
    if (ev.side === 'long') longUsd += ev.usd;
    else shortUsd += ev.usd;
    n += 1;
  }
  return { longUsd, shortUsd, totalUsd: longUsd + shortUsd, n };
}

/** Таблица контрактов OKX. Пустая карта = считать нечего, событие пропускаем. */
async function loadContracts(force = false) {
  if (!force && contracts.size && Date.now() - contractsAt < INSTRUMENTS_TTL_MS) return;
  try {
    const res = await fetch(INSTRUMENTS_URL, { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    if (!Array.isArray(body?.data)) throw new Error('instruments: неожиданный ответ');
    const next = new Map();
    for (const r of body.data) {
      if (r.instCategory !== CRYPTO_CATEGORY) continue;
      const ctVal = Number(r.ctVal);
      if (!Number.isFinite(ctVal) || ctVal <= 0) continue;
      next.set(r.instId, { ctVal, coin: String(r.ctValCcy || '').toUpperCase() });
    }
    if (next.size) {
      contracts = next;
      contractsAt = Date.now();
      logger.info(`[LiqEvents] множителей загружено: ${contracts.size}`);
    }
  } catch (err) {
    logger.warn(`[LiqEvents] не удалось обновить множители: ${err.message}`);
  }
}

function prune(now = Date.now()) {
  if (!events.length) return;
  events = events.filter((ev) => withinWindow(ev, now, WINDOW_MS));
}

function handleRows(rows) {
  const now = Date.now();
  for (const row of rows) {
    const c = contracts.get(row.instId);
    if (!c) continue; // не крипта либо множитель неизвестен — молча мимо
    for (const d of row.details || []) {
      const usd = contractUsd(d.sz, c.ctVal, d.bkPx);
      if (usd == null) continue;
      const t = Number(d.ts);
      events.push({
        t: Number.isFinite(t) ? t : now,
        coin: c.coin,
        usd,
        side: d.posSide === 'long' ? 'long' : 'short',
      });
      seenSinceLog += 1;
      lastEventAt = now;
    }
  }
  prune(now);
}

function clearTimers() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  logger.warn(`[LiqEvents] reconnect #${reconnectAttempts} через ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (stopping) return;
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    connected = true;
    reconnectAttempts = 0;
    logger.info('[LiqEvents] ✅ подключён, подписка liquidation-orders SWAP');
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [{ channel: 'liquidation-orders', instType: 'SWAP' }],
    }));
    if (pingTimer) clearInterval(pingTimer);
    // 🚨 Пинг у OKX — голая строка 'ping', не JSON: на JSON биржа не отвечает
    // и рвёт соединение по таймауту.
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    const text = data.toString();
    if (text === 'pong') return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.event === 'error') {
      logger.warn(`[LiqEvents] отказ подписки: ${msg.msg || 'без причины'}`);
      return;
    }
    if (msg.event || !Array.isArray(msg.data)) return;
    handleRows(msg.data);
  });

  ws.on('error', (err) => logger.warn(`[LiqEvents] ws error: ${err.message}`));

  ws.on('close', (code) => {
    connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (stopping) {
      logger.info('[LiqEvents] закрыт (shutdown)');
      return;
    }
    logger.warn(`[LiqEvents] закрыт (code ${code})`);
    scheduleReconnect();
  });
}

function logStatus() {
  prune();
  const market = summarize(events);
  logger.info(
    `[LiqEvents] status: connected=${connected} событий/5мин=${seenSinceLog} ` +
    `в окне=${market.n} ($${market.totalUsd.toFixed(0)})`,
  );
  const age = lastEventAt ? Date.now() - lastEventAt : -1;
  note('liq_events', {
    category: 'freshness',
    status: !connected ? 'fail' : age < 0 || age > STALE_MS ? 'warn' : 'pass',
    detail: connected
      ? `${market.n} events in window, last ${age < 0 ? 'never' : `${Math.round(age / 1000)}s ago`}`
      : `disconnected (${reconnectAttempts} attempts)`,
    ttlMs: STATUS_LOG_MS * 3,
  });
  seenSinceLog = 0;
}

/**
 * Свод для витрины. Отдаёт и монету, и весь рынок: одна цифра без второй не
 * говорит, это событие по монете или общий каскад.
 */
export function liqEventsWindow(coin = 'BTC') {
  if (!ENABLED) return null;
  const now = Date.now();
  prune(now);
  const sym = String(coin).toUpperCase();
  const one = summarize(events, { coin: sym, now });
  const market = summarize(events, { now });
  return {
    venue: 'OKX',
    coin: sym,
    windowMin: Math.round(WINDOW_MS / 60_000),
    connected,
    longUsd: one.longUsd,
    shortUsd: one.shortUsd,
    n: one.n,
    // 🚨 По одной монете событий часто нет вовсе (BTC молчит минутами), а рынок
    // жив всегда — витрине нужен рыночный срез, иначе строка почти не видна.
    marketLongUsd: market.longUsd,
    marketShortUsd: market.shortUsd,
    marketUsd: market.totalUsd,
    marketN: market.n,
  };
}

/** Поднимает поток событий. No-op, если LIQ_EVENTS_ENABLED != true. */
export function startLiqEvents() {
  if (!ENABLED) {
    logger.info('[LiqEvents] выключен (LIQ_EVENTS_ENABLED != true)');
    return;
  }
  if (started) return;
  started = true;
  stopping = false;
  loadContracts(true).then(() => {
    if (!stopping) connect();
  });
  statusTimer = setInterval(logStatus, STATUS_LOG_MS);
  logger.info('[LiqEvents] запущен (OKX, только показ)');
}

/** Грейсфул-стоп (зовётся из shutdown). */
export function stopLiqEvents() {
  if (!started) return;
  stopping = true;
  clearTimers();
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  try { ws?.close(); } catch { /* noop */ }
  started = false;
  logger.info('[LiqEvents] остановлен');
}

/** Сброс состояния для тестов. */
export function resetLiqEvents() {
  events = [];
  contracts = new Map();
  contractsAt = 0;
  lastEventAt = 0;
}
