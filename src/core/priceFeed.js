// ─────────────────────────────────────────────────
//  Price Feed — WebSocket allMids (Stage 1: shadow)
// ─────────────────────────────────────────────────
//
// Why: бот сэмплит цену 15-сек HTTP-поллингом (scout.js → metaAndAssetCtxs).
// Trailing TP/SL/time-stop считаются раз в 15с и проспают внутри-тиковые вики
// (кейс WLD: peak +$2.2 → close +$0.75). WS-фид allMids даёт мгновенные цены
// по всем монетам сразу и закроет этот разрыв на выходах (Stage 2).
//
// STAGE 1 (этот файл сейчас): только тень. WS поднимается, держит in-memory
// кэш живых цен, reconnect + heartbeat, и СВЕРЯЕТ свою цену с поллинговой
// (comparePoll вызывается из scout). НИКАКАЯ торговая логика не читает этот
// кэш и priceHistory не наполняется отсюда → ни одного решения не меняем.
// Цель стадии — сутки стабильности + увидеть, что WS-цена ≈ поллинг.
//
// allMids отдаёт ТОЛЬКО цены (mids). Funding/OI/premium/vol в WS не приходят —
// остаются на metaAndAssetCtxs HTTP. Архитектура гибридная. Поллинг = floor:
// на разрыве WS бот не слепнет, продолжает жить на 15-сек скане.

import WebSocket from 'ws';
import { logger } from './logger.js';

const WS_URL  = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const ENABLED = (process.env.HL_WS_FEED_ENABLED || 'false') === 'true';

// HL закрывает idle-соединение через ~60с тишины. Пингуем чаще + считаем
// фид «протухшим», если allMids-данных не было дольше STALE_MS.
const PING_INTERVAL_MS = 30_000;
const STALE_MS         = 45_000;
const STATUS_LOG_MS    = 60_000;

// Reconnect c экспоненциальным backoff, потолок 30с.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

// Раз монета двинулась >0.5% между WS и поллингом — это либо реальный вик,
// либо рассинхрон. Логируем такие как WARN-сэмплы (диагностика Stage 1).
const DIVERGENCE_WARN_PCT = 0.5;

// coin(UPPER) -> { price, ts }
const prices = new Map();

let ws = null;
let started = false;
let stopping = false;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;
let statusTimer = null;
let lastMidsAt = 0;          // ts последнего allMids-апдейта
let midsUpdateCount = 0;     // счётчик апдейтов с последнего status-лога

// Окно статистики сверки WS↔поллинг (сбрасывается в каждом status-логе).
let cmpCount = 0;
let cmpSumAbsPct = 0;
let cmpMaxAbsPct = 0;
let cmpMaxCoin = '';

/**
 * Живая цена монеты из WS-кэша (или null, если её там нет).
 * STAGE 1: НЕ вызывать из торговой логики. Только диагностика/сверка.
 * @returns {{price:number, ts:number}|null}
 */
export function getLivePrice(coin) {
  return prices.get(String(coin).toUpperCase()) || null;
}

/** Свежий ли фид: подключён и allMids приходили недавно. */
export function isFeedFresh(maxAgeMs = STALE_MS) {
  return connected && lastMidsAt > 0 && Date.now() - lastMidsAt < maxAgeMs;
}

/**
 * Сверка поллинговой цены с WS-ценой. Вызывается из scout на каждый коин.
 * Решений не меняет — только копит статистику расхождения и логирует выбросы.
 */
export function comparePoll(coin, pollPrice) {
  if (!ENABLED || !Number.isFinite(pollPrice) || pollPrice <= 0) return;
  const live = prices.get(String(coin).toUpperCase());
  if (!live) return;
  const absPct = Math.abs(live.price - pollPrice) / pollPrice * 100;
  cmpCount++;
  cmpSumAbsPct += absPct;
  if (absPct > cmpMaxAbsPct) {
    cmpMaxAbsPct = absPct;
    cmpMaxCoin = coin;
  }
  if (absPct >= DIVERGENCE_WARN_PCT) {
    const age = Date.now() - live.ts;
    logger.warn(
      `[PriceFeed] divergence #${coin}: ws=$${live.price} poll=$${pollPrice} ` +
      `Δ=${absPct.toFixed(3)}% (ws age ${age}ms)`,
    );
  }
}

/** Снимок состояния для health/дашборда. */
export function priceFeedStats() {
  return {
    enabled: ENABLED,
    connected,
    fresh: isFeedFresh(),
    coins: prices.size,
    lastMidsAgeMs: lastMidsAt ? Date.now() - lastMidsAt : null,
    reconnectAttempts,
  };
}

function clearTimers() {
  if (pingTimer)   { clearInterval(pingTimer);   pingTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1),
    RECONNECT_MAX_MS,
  );
  logger.warn(`[PriceFeed] reconnect #${reconnectAttempts} in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleMids(mids) {
  const ts = Date.now();
  let n = 0;
  for (const [sym, raw] of Object.entries(mids)) {
    const price = parseFloat(raw);
    if (!Number.isFinite(price) || price <= 0) continue;
    prices.set(sym.toUpperCase(), { price, ts });
    n++;
  }
  if (n > 0) {
    lastMidsAt = ts;
    midsUpdateCount++;
  }
}

function connect() {
  if (stopping) return;
  logger.info(`[PriceFeed] connecting → ${WS_URL}`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    connected = true;
    reconnectAttempts = 0;
    logger.info('[PriceFeed] ✅ connected, subscribing allMids');
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));

    // Heartbeat: пинг + проверка протухания. Если allMids молчат дольше
    // STALE_MS — рвём и реконнектимся (соединение «живое», но мёртвое).
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
      if (lastMidsAt > 0 && Date.now() - lastMidsAt > STALE_MS) {
        logger.warn('[PriceFeed] mids stale — forcing reconnect');
        try { ws.terminate(); } catch { /* noop */ }
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.channel === 'allMids' && msg.data?.mids) {
      handleMids(msg.data.mids);
    }
    // pong / subscriptionResponse — игнорируем (heartbeat-ack).
  });

  ws.on('error', (err) => {
    logger.warn(`[PriceFeed] ws error: ${err.message}`);
  });

  ws.on('close', (code) => {
    connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (stopping) {
      logger.info('[PriceFeed] closed (shutdown)');
      return;
    }
    logger.warn(`[PriceFeed] closed (code ${code})`);
    scheduleReconnect();
  });
}

function logStatus() {
  if (!connected && reconnectAttempts === 0) return;
  const avg = cmpCount ? (cmpSumAbsPct / cmpCount) : 0;
  const age = lastMidsAt ? Date.now() - lastMidsAt : -1;
  logger.info(
    `[PriceFeed] status: connected=${connected} coins=${prices.size} ` +
    `mids/min=${midsUpdateCount} lastAge=${age}ms | ` +
    `cmp n=${cmpCount} avgΔ=${avg.toFixed(4)}% maxΔ=${cmpMaxAbsPct.toFixed(3)}%` +
    (cmpMaxCoin ? ` (#${cmpMaxCoin})` : ''),
  );
  midsUpdateCount = 0;
  cmpCount = 0;
  cmpSumAbsPct = 0;
  cmpMaxAbsPct = 0;
  cmpMaxCoin = '';
}

/** Поднимает WS-фид. No-op, если HL_WS_FEED_ENABLED != true. */
export function startPriceFeed() {
  if (!ENABLED) {
    logger.info('[PriceFeed] disabled (HL_WS_FEED_ENABLED != true)');
    return;
  }
  if (started) return;
  started = true;
  stopping = false;
  connect();
  statusTimer = setInterval(logStatus, STATUS_LOG_MS);
  logger.info('[PriceFeed] started (Stage 1: shadow, no trade logic touched)');
}

/** Грейсфул-стоп WS-фида (вызывается из shutdown). */
export function stopPriceFeed() {
  if (!started) return;
  stopping = true;
  clearTimers();
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  try { ws?.close(); } catch { /* noop */ }
  started = false;
  logger.info('[PriceFeed] stopped');
}
