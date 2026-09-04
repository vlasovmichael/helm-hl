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
import { findAsset } from './universe.js';
import { note } from './healthRegistry.js';

const WS_URL  = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const ENABLED = (process.env.HL_WS_FEED_ENABLED || 'false') === 'true';

// Builder-DEX'ы (HIP-3). allMids без параметра `dex` их не отдаёт вовсе, и цена
// таких позиций в статус-кадре жила марком из REST раз в минуту. Подписка
// дешёвая: один кадр на площадку, тикеры приходят с префиксом (`xyz:NOK`).
// 🚨 Префикс площадки ЧУВСТВИТЕЛЕН К РЕГИСТРУ и обязан остаться строчным —
// на `XYZ:NOK` биржа молчит без ошибки (тот же класс, что строчная k в kSHIB).
const BUILDER_DEXES = (process.env.HL_WS_BUILDER_DEXES ?? 'xyz')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

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

// ── Пороги для health-плашки (см. core/healthRegistry.js) ──────────────────
// Два порога на дрифт, а не один: расхождение WS с поллингом на десятые доли
// процента — норма (разные моменты сэмплирования), и если бы плашка краснела
// на нём, её бы перестали читать за день. Красным считается только разрыв,
// который уже не объясняется сэмплированием.
const DRIFT_WARN_PCT  = 0.5;
const DRIFT_FAIL_PCT  = 2.0;
// Возраст последнего кадра allMids. STALE_MS (45с) — это уже «фид мёртв»,
// поэтому предупреждаем заметно раньше.
const FEED_WARN_AGE_MS = 15_000;
// Живой фид отдаёт ~22-24 кадра в минуту. Ноль при connected=true — это ровно
// тот тихий случай, когда сокет открыт, а данных нет (см. tick-starvation 31.07).
const MIDS_MIN_WARN = 5;

// coin -> { price, ts }. Ключ: обычная монета в верхнем регистре, актив
// builder-DEX'а как `xyz:NOK` — префикс площадки строчный (см. выше).
const prices = new Map();

function normCoinKey(coin) {
  const s = String(coin ?? '');
  const i = s.indexOf(':');
  return i > 0
    ? `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1).toUpperCase()}`
    : s.toUpperCase();
}

let ws = null;
let started = false;
let stopping = false;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;
let statusTimer = null;
// ── Подписка на СДЕЛКИ по монетам, которые ведёт нянька ────────────────────
// Зачем отдельно от allMids: мид приходит ~22 раза в минуту, и мгновенное
// касание уровня между кадрами в него не попадает — трейл не взводится там,
// где цена реально была. Лимитка в книге ловит всё, теперь и мы.
//
// Свечи эту дыру тоже закрывают, но с задержкой до полуминуты (троттл + TTL).
// Поток сделок даёт ту же правду мгновенно и без единого запроса к API.
//
// Держим не сами сделки, а running-экстремумы по монете: список сделок на
// ликвидной монете — это мегабайты в минуту, а нужен из них максимум и минимум.
const tradeExtremes = new Map(); // coin → { hi, lo, at, since }
let watchedTradeCoins = new Set();

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
  return prices.get(normCoinKey(coin)) || null;
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
  const absDiff = Math.abs(live.price - pollPrice);
  const absPct  = absDiff / pollPrice * 100;
  cmpCount++;
  cmpSumAbsPct += absPct;

  // Noise floor: у микро-монет ($0.00017) один тик последнего знака — это
  // уже 0.5-0.6%, выше порога варна. Два источника независимо округляют
  // истинный mid и могут разойтись на целый ULP (один вниз, другой вверх).
  // Игнорируем расхождение до 1.5 ULP более грубого (меньше знаков после
  // запятой) источника: это шум округления, а не реальный вик. Реальное
  // расхождение (≥2 тика) всё ещё логируется.
  const ulp = Math.pow(10, -Math.min(decimalsOf(pollPrice), decimalsOf(live.price)));
  if (absDiff <= ulp * 1.5) return;

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

/** Кол-во знаков после запятой в десятичной записи числа (для noise-floor). */
function decimalsOf(x) {
  const s = String(x);
  // Малые числа (< 1e-6) JS печатает в экспоненте: "1e-7".
  if (s.includes('e') || s.includes('E')) {
    const [mant, exp] = s.toLowerCase().split('e');
    const mantDec = mant.includes('.') ? mant.split('.')[1].length : 0;
    return Math.max(0, mantDec - Number(exp));
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
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
    prices.set(normCoinKey(sym), { price, ts });
    n++;
  }
  if (n > 0) {
    lastMidsAt = ts;
    midsUpdateCount++;
  }
}

/** Отправить (или снять) подписку на сделки по монете. */
// 🚨 Подписка на несуществующий тикер РВЁТ ВЕСЬ СОКЕТ: close 1006 без единого
// сообщения об ошибке, и цены по всем остальным монетам умирают вместе с ним.
// Поэтому имя монеты уходит на биржу
// только когда universe его подтвердил: `resolveApiCoin` без загруженного
// universe возвращает исходную строку, а внутри бота она UPPERCASE — у k-монет
// это неверное имя. На старте фид поднимается раньше первого скаут-тика, и
// подписка успевала уйти в этот зазор: два `closed (code 1006)` подряд в логах
// каждого рестарта — ровно она.
function sendTradeSub(coin, on) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  // Отписку шлём всегда: она безопасна, а не отписаться — значит копить поток.
  const asset = findAsset(coin);
  if (on && !asset) {
    logger.debug(`[PriceFeed] trades sub #${coin} отложена — universe ещё не знает тикер`);
    return false;
  }
  try {
    ws.send(JSON.stringify({
      method: on ? 'subscribe' : 'unsubscribe',
      subscription: { type: 'trades', coin: asset ? asset.name : coin },
    }));
    return true;
  } catch (err) {
    logger.debug(`[PriceFeed] trades ${on ? 'sub' : 'unsub'} #${coin} failed: ${err.message}`);
    return false;
  }
}

/** Обновить running-экстремумы по пришедшим сделкам. */
function handleTrades(trades) {
  const now = Date.now();
  for (const t of trades) {
    const coin = normCoinKey(t?.coin);
    const px = parseFloat(t?.px);
    if (!coin || !Number.isFinite(px) || px <= 0) continue;
    const prev = tradeExtremes.get(coin);
    if (!prev) {
      tradeExtremes.set(coin, { hi: px, lo: px, at: now, since: now });
    } else {
      if (px > prev.hi) prev.hi = px;
      if (px < prev.lo) prev.lo = px;
      prev.at = now;
    }
  }
}

/**
 * Задать набор монет, по которым нужен поток сделок (позиции под нянькой).
 * Идемпотентно: подписываемся только на новые, отписываемся от ушедших и
 * ЧИСТИМ их экстремумы — карта не должна копить закрытые позиции.
 */
export function setTradeWatch(coins) {
  const next = new Set((coins || []).filter(Boolean).map(normCoinKey));
  for (const coin of watchedTradeCoins) {
    if (!next.has(coin)) {
      sendTradeSub(coin, false);
      tradeExtremes.delete(coin);
    }
  }
  // Подписанной считается только та монета, чья подписка реально ушла. Иначе
  // отложенная (universe не готов) больше никогда бы не повторилась: вызов
  // идемпотентный, и на следующем тике она уже числилась бы watched.
  const confirmed = new Set();
  for (const coin of next) {
    if (watchedTradeCoins.has(coin) || sendTradeSub(coin, true)) confirmed.add(coin);
  }
  watchedTradeCoins = confirmed;
}

/**
 * Экстремумы цены СДЕЛОК по монете с момента подписки.
 * @returns {{hi:number, lo:number, since:number, at:number}|null}
 */
export function getTradeExtremes(coin) {
  const e = tradeExtremes.get(normCoinKey(coin));
  return e ? { hi: e.hi, lo: e.lo, since: e.since, at: e.at } : null;
}

/** Сброс (тесты + смена позиции по той же монете). */
export function resetTradeExtremes(coin) {
  if (coin == null) tradeExtremes.clear();
  else tradeExtremes.delete(normCoinKey(coin));
}

function connect() {
  if (stopping) return;
  logger.info(`[PriceFeed] connecting → ${WS_URL}`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    connected = true;
    reconnectAttempts = 0;
    logger.info(
      `[PriceFeed] ✅ connected, subscribing allMids` +
      (BUILDER_DEXES.length ? ` (+ builder: ${BUILDER_DEXES.join(', ')})` : ''),
    );
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    for (const dex of BUILDER_DEXES) {
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids', dex } }));
    }
    // Реконнект сбрасывает подписки на стороне биржи — восстанавливаем свои.
    // Экстремумы при этом НЕ обнуляем: пик не убывает, а дыру в потоке за время
    // разрыва закроют свечи (adoptPeakTruth).
    for (const coin of watchedTradeCoins) sendTradeSub(coin, true);

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
    } else if (msg.channel === 'trades' && Array.isArray(msg.data)) {
      handleTrades(msg.data);
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
  noteFeedHealth({ age, avg });

  midsUpdateCount = 0;
  cmpCount = 0;
  cmpSumAbsPct = 0;
  cmpMaxAbsPct = 0;
  cmpMaxCoin = '';
}

/**
 * Те же числа, что ушли в лог, — в health-реестр, откуда их прочитает плашка
 * дашборда. Считать здесь нечего: всё уже посчитано выше, дело только в том,
 * чтобы значения пережили обнуление счётчиков и получили порог.
 *
 * TTL = 3 интервала: разовый пропуск замера — не повод краснеть, а три подряд
 * означают, что statusTimer встал, и молчать об этом нельзя.
 */
function noteFeedHealth({ age, avg }) {
  const ttlMs = STATUS_LOG_MS * 3;

  // Свежесть кадра allMids.
  let status, detail;
  if (!connected) {
    status = 'fail';
    detail = `нет коннекта (попыток ${reconnectAttempts})`;
  } else if (age < 0 || age > STALE_MS) {
    status = 'fail';
    detail = age < 0 ? 'кадров ещё не было' : `последний кадр ${(age / 1000).toFixed(0)}с назад`;
  } else if (age > FEED_WARN_AGE_MS || midsUpdateCount < MIDS_MIN_WARN) {
    status = 'warn';
    detail = `кадр ${(age / 1000).toFixed(1)}с назад, ${midsUpdateCount}/мин`;
  } else {
    status = 'pass';
    detail = `кадр ${(age / 1000).toFixed(1)}с назад, ${midsUpdateCount}/мин`;
  }
  note('price_feed', { category: 'freshness', status, detail, ttlMs });

  // Дрифт WS-цены против поллинговой (сравнение делает comparePoll из scout).
  if (cmpCount > 0) {
    const driftStatus =
      cmpMaxAbsPct >= DRIFT_FAIL_PCT ? 'fail'
      : cmpMaxAbsPct >= DRIFT_WARN_PCT ? 'warn'
      : 'pass';
    note('price_drift', {
      category: 'xref',
      status: driftStatus,
      detail:
        `n=${cmpCount} avgΔ=${avg.toFixed(4)}% maxΔ=${cmpMaxAbsPct.toFixed(3)}%` +
        (cmpMaxCoin ? ` (#${cmpMaxCoin})` : ''),
      ttlMs,
    });
  } else {
    // Сверок не было — сказать «дрифта нет» здесь было бы враньём.
    note('price_drift', {
      category: 'xref',
      status: 'warn',
      detail: 'сверок с поллингом не было',
      ttlMs,
    });
  }

  // Покрытие: сколько монет вообще держит кэш.
  note('price_coverage', {
    category: 'completeness',
    status: prices.size === 0 ? 'fail' : prices.size < 50 ? 'warn' : 'pass',
    detail: `${prices.size} монет в кэше`,
    ttlMs,
  });
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
