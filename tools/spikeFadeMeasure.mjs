// ─────────────────────────────────────────────────
//  Spike-Fade Measure — бумажный замер «скальпа фитилей»
// ─────────────────────────────────────────────────
//
// Гипотеза оператора: держать быстрый WS к волатильным монетам и фейдить резкие
// вики (как AERO 09:30 +6%/1мин). Вопрос НЕ технический (WS тривиален —
// см. src/core/priceFeed.js), а стратегический: есть ли forward-эдж, если
// РЕАЛЬНО реагировать на всплеск (входить уже В движении, не на самом пике).
//
// Этот скрипт — чистый НАБЛЮДАТЕЛЬ. Живого бота не трогает: своё WS-соединение
// к allMids, ноль ордеров, ноль импортов торговой логики. На каждый всплеск
// открывает ГИПОТЕТИЧЕСКИЙ фейд и ведёт его до цели/стопа/тайм-стопа, пишет
// исход в JSONL. Отдельная команда --tally считает expectancy по накопленному.
//
// Запуск (копит forward, нужно держать включённым часы/дни):
//   node tools/spikeFadeMeasure.mjs
// Подсчёт по накопленному:
//   node tools/spikeFadeMeasure.mjs --tally
//
// Все параметры — через env (значения по умолчанию ниже).

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEvents, buildOverview } from './spikeFadeStats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Параметры замера ────────────────────────────────
const WS_URL       = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
// data/spike-fade/ живёт в том же томе, что и дашборд (см. docker-compose),
// поэтому route /api/spike-fade читает ровно этот файл.
const OUT_FILE      = process.env.SPIKE_OUT
  || path.join(REPO_ROOT, 'data', 'spike-fade', 'events.jsonl');

// Всплеск = |движение| ≥ SPIKE_PCT за окно WINDOW_MS (быстрый вик).
const SPIKE_PCT     = parseFloat(process.env.SPIKE_PCT     || '3');    // %
const WINDOW_MS     = parseInt(process.env.SPIKE_WINDOW_MS  || '60000', 10);

// Фейд-выход: цель = реверс на TARGET_PCT, стоп = ход дальше на STOP_PCT,
// тайм-стоп = HORIZON_MS. Комиссия — round-trip taker (2×0.045% на HL).
const TARGET_PCT    = parseFloat(process.env.SPIKE_TARGET_PCT || '1.5'); // % в пользу фейда
const STOP_PCT      = parseFloat(process.env.SPIKE_STOP_PCT   || '1.5'); // % против
const HORIZON_MS    = parseInt(process.env.SPIKE_HORIZON_MS  || '1800000', 10); // 30 мин
const FEE_PCT       = parseFloat(process.env.SPIKE_FEE_PCT   || '0.09');  // round-trip

// После закрытия гипотетики — пауза на монету, чтобы не кластерить один вик.
const COOLDOWN_MS   = parseInt(process.env.SPIKE_COOLDOWN_MS || '900000', 10); // 15 мин

// Монеты из бан-листа оператора (по разбору журнала) — исключаем.
const BANNED = new Set(
  (process.env.SPIKE_BANNED || 'AERO,HMSTR,KAITO,JTO,CASHCAT')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
);

// Опциональный аллоу-лист (если задан — меряем ТОЛЬКО эти монеты).
const ALLOW = new Set(
  (process.env.SPIKE_ALLOW || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
);

// ── Подсчёт по накопленному (--tally) ───────────────
if (process.argv.includes('--tally')) {
  tally();
  process.exit(0);
}

// ── Состояние наблюдателя ───────────────────────────
// coin -> [{ts, price}, ...] rolling буфер (WINDOW + горизонт)
const history = new Map();
// coin -> активная гипотетика { side, entryTs, entryPx, targetPx, stopPx,
//                               deadline, mfePct, maePct, baselinePx, peakPx }
const open = new Map();
// coin -> ts, до которого монета на кулдауне
const cooldownUntil = new Map();

const BUFFER_MS = WINDOW_MS + 1000;
let events = 0, wins = 0, losses = 0, timeouts = 0;

function watched(coin) {
  // allMids отдаёт и спот-пары (@193), и служебные перп-индексы (#8570) —
  // это не именованные торгуемые перпы, мерить их бессмысленно. Берём только
  // символы из букв/цифр (BTC, ZETA, kBONK, 1000PEPE), без @/# префиксов.
  if (!/^[A-Z0-9]+$/.test(coin)) return false;
  if (BANNED.has(coin)) return false;
  if (ALLOW.size > 0) return ALLOW.has(coin);
  return true;
}

function onTick(coin, price, ts) {
  // 1) Ведём активную гипотетику, если она есть.
  const pos = open.get(coin);
  if (pos) {
    updatePosition(coin, pos, price, ts);
    return; // пока позиция открыта — новый всплеск на этой монете не ловим
  }

  // 2) Копим историю.
  let buf = history.get(coin);
  if (!buf) { buf = []; history.set(coin, buf); }
  buf.push({ ts, price });
  // Отрезаем старьё за пределами окна.
  const cutoff = ts - BUFFER_MS;
  while (buf.length > 1 && buf[0].ts < cutoff) buf.shift();

  // 3) Кулдаун?
  if ((cooldownUntil.get(coin) || 0) > ts) return;

  // 4) Детект всплеска: сравниваем с самой старой ценой в окне (baseline).
  if (buf.length < 2) return;
  const baseline = buf[0].price;
  if (!(baseline > 0)) return;
  const movePct = (price - baseline) / baseline * 100;
  if (Math.abs(movePct) < SPIKE_PCT) return;

  // 5) Открываем ГИПОТЕТИЧЕСКИЙ фейд (шорт на рост, лонг на падение).
  const side = movePct > 0 ? 'short' : 'long';
  const dir  = side === 'short' ? -1 : 1; // знак благоприятного движения цены
  open.set(coin, {
    side,
    entryTs: ts,
    entryPx: price,
    baselinePx: baseline,
    spikePct: movePct,
    peakPx: price,
    targetPx: price * (1 + dir * TARGET_PCT / 100),
    stopPx:   price * (1 - dir * STOP_PCT / 100),
    deadline: ts + HORIZON_MS,
    mfePct: 0,
    maePct: 0,
  });
  history.delete(coin); // буфер больше не нужен, пока держим позицию
}

function updatePosition(coin, pos, price, ts) {
  const dir = pos.side === 'short' ? -1 : 1;
  const favPct = dir * (price - pos.entryPx) / pos.entryPx * 100; // + в нашу пользу
  if (favPct > pos.mfePct) pos.mfePct = favPct;
  if (favPct < pos.maePct) pos.maePct = favPct;

  let exitReason = null;
  // Достигли цели / стопа? (проверяем по цене, чтобы учесть сторону)
  if (pos.side === 'short') {
    if (price <= pos.targetPx) exitReason = 'target';
    else if (price >= pos.stopPx) exitReason = 'stop';
  } else {
    if (price >= pos.targetPx) exitReason = 'target';
    else if (price <= pos.stopPx) exitReason = 'stop';
  }
  if (!exitReason && ts >= pos.deadline) exitReason = 'timeout';
  if (!exitReason) return;

  const rawPct = favPct;                 // «идеальный» PnL по последней цене
  // Для target/stop фиксируем на уровне (реалистичнее, чем last tick):
  const fillPct = exitReason === 'target' ?  TARGET_PCT
                : exitReason === 'stop'   ? -STOP_PCT
                : rawPct;
  const netPct = fillPct - FEE_PCT;

  const rec = {
    coin, side: pos.side,
    entry_ts: pos.entryTs, exit_ts: ts,
    held_s: Math.round((ts - pos.entryTs) / 1000),
    entry_px: pos.entryPx, exit_px: price,
    spike_pct: +pos.spikePct.toFixed(3),
    exit_reason: exitReason,
    raw_pct: +fillPct.toFixed(3),
    net_pct: +netPct.toFixed(3),
    mfe_pct: +pos.mfePct.toFixed(3),
    mae_pct: +pos.maePct.toFixed(3),
  };
  fs.appendFileSync(OUT_FILE, JSON.stringify(rec) + '\n');

  events++;
  if (exitReason === 'target') wins++;
  else if (exitReason === 'stop') losses++;
  else timeouts++;

  open.delete(coin);
  cooldownUntil.set(coin, ts + COOLDOWN_MS);

  const sign = netPct >= 0 ? '+' : '';
  console.log(
    `[${new Date(ts).toISOString().slice(11, 19)}] #${coin} ${pos.side} ` +
    `spike ${pos.spikePct > 0 ? '+' : ''}${pos.spikePct.toFixed(1)}% → ${exitReason} ` +
    `${sign}${netPct.toFixed(2)}% (n=${events} W/L/T ${wins}/${losses}/${timeouts})`,
  );
}

// ── WS (паттерн из priceFeed.js, свой инстанс) ──────
let ws = null, stopping = false, reconnectAttempts = 0, pingTimer = null;

function connect() {
  if (stopping) return;
  console.log(`[spike] connecting → ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log('[spike] ✅ connected, subscribing allMids');
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
    }, 30_000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.channel !== 'allMids' || !msg.data?.mids) return;
    const ts = Date.now();
    for (const [sym, raw] of Object.entries(msg.data.mids)) {
      const coin = sym.toUpperCase();
      if (!watched(coin)) continue;
      const price = parseFloat(raw);
      if (!Number.isFinite(price) || price <= 0) continue;
      onTick(coin, price, ts);
    }
  });

  ws.on('error', (err) => console.warn(`[spike] ws error: ${err.message}`));
  ws.on('close', (code) => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (stopping) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempts++, 30_000);
    console.warn(`[spike] closed (${code}), reconnect in ${delay}ms`);
    setTimeout(connect, delay);
  });
}

// ── Tally: expectancy по накопленному JSONL ─────────
function tally() {
  const rows = readEvents(OUT_FILE);
  if (rows.length === 0) {
    console.log(`Пусто: ${OUT_FILE} нет данных. Сначала покрутите сбор.`);
    return;
  }
  const o = buildOverview(rows);

  const fmt = (s) => s
    ? `n=${s.n}  win=${s.winRate.toFixed(0)}%  exp=${s.exp >= 0 ? '+' : ''}${s.exp.toFixed(3)}%/сд  ` +
      `Σ=${s.sum >= 0 ? '+' : ''}${s.sum.toFixed(1)}%  MFE=${s.avgMfe.toFixed(2)}%  MAE=${s.avgMae.toFixed(2)}%`
    : '—';

  console.log('\n═══ Spike-Fade замер ═══');
  console.log('ВСЕ           ', fmt(o.all));
  console.log('  short (рост)', fmt(o.short));
  console.log('  long  (пад.)', fmt(o.long));
  console.log('Выходы        ', Object.entries(o.byReason).map(([k, v]) => `${k}=${v}`).join('  '));

  console.log('\nПо монетам (топ по n):');
  for (const c of o.coins.slice(0, 8)) console.log(`  ${c.coin.padEnd(10)}`, fmt(c));

  console.log(`\nОкно наблюдения: ~${o.spanHours.toFixed(1)}ч,  событий: ${o.count}`);
  console.log('Напоминание: n<20 — шум; ждём накопления, exp считаем на серии.\n');
}

// ── Старт ───────────────────────────────────────────
process.on('SIGINT',  () => { stopping = true; try { ws?.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { stopping = true; try { ws?.close(); } catch {} process.exit(0); });

console.log(
  `[spike] старт наблюдателя | всплеск ≥${SPIKE_PCT}% за ${WINDOW_MS / 1000}с | ` +
  `цель ${TARGET_PCT}% стоп ${STOP_PCT}% тайм ${HORIZON_MS / 60000}м fee ${FEE_PCT}% | ` +
  `out=${path.basename(OUT_FILE)}`,
);
console.log(`[spike] бан: ${[...BANNED].join(',')}${ALLOW.size ? ` | allow: ${[...ALLOW].join(',')}` : ''}`);
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
connect();
