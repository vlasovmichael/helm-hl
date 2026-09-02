// ─────────────────────────────────────────────────
//  Fill Feed — WS-подписка на СВОИ филлы (userFills)
// ─────────────────────────────────────────────────
// Зачем (02.09.2026): бот узнавал о собственных сделках только опросом —
// Integrity сверял БД с биржей раз в 60с и мог отложить сверку по эвристике.
// В худшем случае это дало четыре часа слепоты: поза закрылась в 18:18, а
// строка в журнале появилась в 22:51 (см. tests/integrityOrphanOrders.test.js).
// Тот же лаг рождал «too old»: ручная поза успевала состариться, пока её
// заметят, и adopt отказывался её подхватывать.
//
// Здесь противоположный путь: биржа сама говорит о филле, и мы будим тик
// немедленно. Опрос остаётся страховкой на случай обрыва WS — событийный канал
// его НЕ заменяет, а опережает.
//
// Гонок нет by design: фид не трогает БД и не закрывает позиции, он только
// сбрасывает интервальный гард Integrity и зовёт tick(), у которого свой
// флаг state.tickRunning.

import WebSocket from 'ws';
import { logger } from './logger.js';
import { config } from './config.js';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SEEN_MAX = 500;          // кольцо виденных филлов, чтобы не разрастаться

let ws = null;
let stopping = false;
let connected = false;
let reconnectAttempts = 0;
let pingTimer = null;
let onFillCb = null;

const seen = new Set();   // Set держит порядок вставки — этого хватает для подрезки
const stats = { events: 0, lastFillAt: 0, connectedAt: 0 };

/**
 * Ключ филла для дедупа. tid уникален у HL; hash+oid — запасной вариант,
 * если tid не пришёл. Без дедупа реконнект переигрывал бы одни и те же филлы.
 */
export function fillKey(f) {
  if (f?.tid != null) return `t:${f.tid}`;
  return `h:${f?.hash ?? ''}:${f?.oid ?? ''}:${f?.time ?? ''}`;
}

/**
 * Отбирает из сообщения филлы, которые бот ещё не видел.
 * Снапшот (isSnapshot) — это история при подписке, а не новые события: его
 * прогоняем через дедуп молча, чтобы не будить тик на каждом реконнекте.
 *
 * Чистая функция — тестируется без сети.
 *
 * @param {{data?: {fills?: Array, isSnapshot?: boolean}}} msg
 * @param {Set<string>} seenSet — пополняется виденными ключами и подрезается
 * @returns {Array} новые филлы (пусто для снапшота)
 */
export function pickFreshFills(msg, seenSet) {
  const fills = msg?.data?.fills;
  if (!Array.isArray(fills) || fills.length === 0) return [];
  const isSnapshot = msg.data.isSnapshot === true;
  const fresh = [];
  for (const f of fills) {
    const key = fillKey(f);
    if (seenSet.has(key)) continue;
    seenSet.add(key);
    if (!isSnapshot) fresh.push(f);
  }
  while (seenSet.size > SEEN_MAX) {
    seenSet.delete(seenSet.values().next().value);   // самый старый ключ
  }
  return fresh;
}

function connect() {
  if (stopping) return;
  const address = config.wallet?.address;
  if (!address) {
    logger.warn('[FillFeed] адрес кошелька не задан — фид не стартует');
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    connected = true;
    reconnectAttempts = 0;
    stats.connectedAt = Date.now();
    logger.info('[FillFeed] ✅ connected, subscribing userFills');
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user: address } }));

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.channel !== 'userFills') return;

    const fresh = pickFreshFills(msg, seen);
    if (fresh.length === 0) return;

    stats.events += fresh.length;
    stats.lastFillAt = Date.now();
    const summary = fresh
      .map((f) => `${f.dir ?? '?'} #${f.coin} ${f.sz}@${f.px}`)
      .join(', ');
    logger.info(`[FillFeed] ⚡ ${fresh.length} филл(ов): ${summary} — бужу сверку`);

    try {
      onFillCb?.(fresh);
    } catch (err) {
      logger.warn(`[FillFeed] обработчик упал: ${err.message}`);
    }
  });

  ws.on('error', (err) => {
    logger.warn(`[FillFeed] ws error: ${err.message}`);
  });

  ws.on('close', (code) => {
    connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (stopping) return;
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
    logger.warn(`[FillFeed] closed (${code}) — reconnect через ${Math.round(delay / 1000)}с`);
    setTimeout(connect, delay);
  });
}

/**
 * @param {{onFill?: (fills: Array) => void}} opts — вызывается на КАЖДОМ новом
 *   филле. Обработчик обязан быть дешёвым и не бросать: фид ему не владелец.
 */
export function startFillFeed({ onFill } = {}) {
  onFillCb = onFill ?? null;
  stopping = false;
  connect();
}

export function stopFillFeed() {
  stopping = true;
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  try { ws?.close(); } catch { /* noop */ }
  ws = null;
  connected = false;
}

export function fillFeedStatus() {
  return {
    connected,
    events: stats.events,
    lastFillAt: stats.lastFillAt,
    ageSec: stats.lastFillAt ? Math.round((Date.now() - stats.lastFillAt) / 1000) : null,
  };
}
