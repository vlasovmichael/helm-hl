// Сделки Hyperliquid по нескольким монетам в топик Kafka. Биржу только читает.
// Своё WS-соединение: подписками на сделки в priceFeed управляет нянька.
// Сбой брокера или потока не должен задевать бота, поэтому всё fail-soft.
// Доставка at-least-once: после переподключения биржа может повторить сделки, дубли отсеиваются по tid.

import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { logger } from './logger.js';

const WS_URL = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const TOPIC = process.env.KAFKA_TOPIC || 'market.hl.trades';
const PARTITIONS = 3;

const PING_INTERVAL_MS = 30_000;
const SILENCE_LIMIT_MS = 90_000;
const RECONNECT_MS = 5_000;
const BROKER_RETRY_MS = 30_000;
const STATUS_LOG_MS = 300_000;
// Брокер лёг: новые сделки теряем, а не копим в памяти бота.
const MAX_IN_FLIGHT = 100;
const BUFFER_LIMIT_KB = 16_384;

const SIDES = { B: 'buy', A: 'sell' };

const splitList = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

let producer = null;
let ws = null;
let pingTimer = null;
let statusTimer = null;
let reconnectTimer = null;
let started = false;
let stopping = false;
let lastFrameAt = 0;
let inFlight = 0;
let sent = 0;
let dropped = 0;

/** Сделка биржи в сообщение Kafka; null, если кадр неполный. Ключ держит порядок сделок монеты. */
export function toKafkaMessage(trade) {
  const { coin, side, px, sz, time, tid } = trade ?? {};
  const named = SIDES[side];
  if (typeof coin !== 'string' || !named || typeof px !== 'string' || typeof sz !== 'string') return null;
  if (!Number.isFinite(time) || !Number.isFinite(tid)) return null;
  return {
    key: coin,
    timestamp: String(time),
    value: JSON.stringify({ coin, side: named, px, sz, time, tid }),
  };
}

async function publish(trades) {
  const messages = trades.map(toKafkaMessage).filter(Boolean);
  if (messages.length === 0) return;
  if (inFlight >= MAX_IN_FLIGHT) {
    dropped += messages.length;
    return;
  }
  inFlight += 1;
  try {
    await producer.send({ topic: TOPIC, messages });
    sent += messages.length;
  } catch (err) {
    dropped += messages.length;
    logger.debug(`[KafkaTrades] отправка не прошла: ${err.message}`);
  } finally {
    inFlight -= 1;
  }
}

function connectWs(coins) {
  if (stopping) return;
  ws = new WebSocket(WS_URL);
  const socket = ws;

  socket.on('open', () => {
    lastFrameAt = Date.now();
    for (const coin of coins) {
      socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    }
    pingTimer = setInterval(() => {
      if (Date.now() - lastFrameAt > SILENCE_LIMIT_MS) socket.terminate();
      else socket.send(JSON.stringify({ method: 'ping' }));
    }, PING_INTERVAL_MS);
    logger.info(`[KafkaTrades] поток подключён: ${coins.join(', ')} → ${TOPIC}`);
  });

  socket.on('message', (data) => {
    lastFrameAt = Date.now();
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.channel === 'trades' && Array.isArray(frame.data)) publish(frame.data);
  });

  socket.on('error', (err) => logger.warn(`[KafkaTrades] ws: ${err.message}`));

  socket.on('close', () => {
    clearInterval(pingTimer);
    if (!stopping) reconnectTimer = setTimeout(() => connectWs(coins), RECONNECT_MS);
  });
}

async function connectBroker(brokers) {
  const { KafkaJS } = await import('@confluentinc/kafka-javascript');
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { clientId: 'hl-trades', brokers, logLevel: KafkaJS.logLevel.WARN },
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: PARTITIONS }] });
  } finally {
    await admin.disconnect();
  }
  const connected = kafka.producer({
    kafkaJS: { acks: -1, idempotent: true, compression: KafkaJS.CompressionTypes.LZ4 },
    'queue.buffering.max.kbytes': BUFFER_LIMIT_KB,
  });
  await connected.connect();
  return connected;
}

async function run(brokers, coins) {
  while (!producer) {
    if (stopping) return;
    try {
      producer = await connectBroker(brokers);
    } catch (err) {
      logger.warn(`[KafkaTrades] брокер недоступен: ${err.message}`);
      await sleep(BROKER_RETRY_MS);
    }
  }
  connectWs(coins);
  statusTimer = setInterval(() => {
    logger.info(`[KafkaTrades] отправлено ${sent}, потеряно ${dropped}`);
  }, STATUS_LOG_MS);
  statusTimer.unref?.();
}

/** Поднимает поток, если заданы KAFKA_BROKERS и KAFKA_COINS. Сбой только логируется. */
export function startKafkaTrades() {
  const brokers = splitList(process.env.KAFKA_BROKERS);
  const coins = splitList(process.env.KAFKA_COINS);
  if (started || brokers.length === 0 || coins.length === 0) return;
  started = true;
  run(brokers, coins).catch((err) => logger.warn(`[KafkaTrades] остановлен: ${err.message}`));
}

export function stopKafkaTrades() {
  stopping = true;
  clearInterval(pingTimer);
  clearInterval(statusTimer);
  clearTimeout(reconnectTimer);
  ws?.close();
  producer?.disconnect().catch((err) => logger.debug(`[KafkaTrades] disconnect: ${err.message}`));
}
