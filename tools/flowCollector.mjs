// ─────────────────────────────────────────────────────────────────────────────
//  flowCollector — поток ордеров Hyperliquid С АДРЕСАМИ УЧАСТНИКОВ.
//
//  Зачем: HL — ончейн-биржа. Каждая сделка подписана адресами обеих сторон, а
//  clearinghouseState отдаёт позицию, плечо и цену ликвидации ЛЮБОГО кошелька.
//  Ни один CEX такого не даёт: там поток анонимен и состав его можно только
//  угадывать по косвенным признакам. Ретроспективы не существует — ни поток,
//  ни срезы чужих позиций биржа историей не отдаёт. Не записали = данных нет.
//
//  Здесь ТОЛЬКО сбор. Гипотез не проверяет, ордеров не шлёт, торгового бота не
//  касается: свой контейнер, свой fetch, вне весового пула hlClient.
//
//  Что пишем и почему именно так:
//   • flow — оборот пары (адрес, монета) за 5-минутный бар, тейкером и
//     мейкером раздельно. Пофилльно это 9.7М строк и 2.6 ГБ в сутки; бар с
//     порогом FLOW_MIN_USD жмёт примерно в 15 раз, теряя 0.06% оборота.
//   • positions — срезы чужих позиций: размер, вход, плечо и ЦЕНА ЛИКВИДАЦИИ.
//     Вынужденный продавец — единственный участник, чьё направление известно
//     заранее.
//   • wallet_day — суточная сводка по кошельку. Переживает ретеншн flow, и
//     потому длинная история кошелька копится с первого дня.
//
//  🚨 users[0] — ПОКУПАТЕЛЬ, users[1] — ПРОДАВЕЦ, side — сторона ТЕЙКЕРА
//  (B=buy, A=sell). Перепутать местами — записать мейкера агрессором и молча
//  обессмыслить всю базу: ошибка не видна ни в одной проверке размера файла.
//
//  🚨 Вселенная НЕ заморожена: это сбор, а не предзаявка. Любое правило отбора
//  вводится при постановке гипотезы, не здесь.
//
//  Запуск: node tools/flowCollector.mjs (свой контейнер, как funding-spread)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const HL_API = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const HL_WS  = process.env.HL_WS_URL   || 'wss://api.hyperliquid.xyz/ws';
const DIR    = path.join('data', 'flow');
const DB_F   = path.join(DIR, 'flow.db');

const BAR_MS = 300_000;
// Ниже $100 за бар пара (адрес, монета) — это 41% строк и 0.06% оборота.
const MIN_USD = Number(process.env.FLOW_MIN_USD || 100);
// Детальный поток живёт ограниченно, сводка по кошелькам — вечно.
const KEEP_FLOW_DAYS = Number(process.env.FLOW_KEEP_DAYS || 90);
const KEEP_POS_DAYS  = Number(process.env.FLOW_KEEP_POS_DAYS || 180);

// Сколько кошельков опрашиваем на позиции и как часто. Вес clearinghouseState
// в лимите HL — 2 при потолке 1200/мин, то есть 600 запросов в минуту; зазор
// 120мс держит нас втрое ниже потолка.
//
// 🚨 Охват решает, будет ли карта ликвидаций читаемой: из тысячи кошельков
// позиция по конкретной монете есть у единиц. На 300 карта выходит пустой.
const POS_TOP      = Number(process.env.FLOW_POS_TOP || 1200);
const POS_EVERY_MS = Number(process.env.FLOW_POS_EVERY_MS || 600_000);
const POS_GAP_MS   = Number(process.env.FLOW_POS_GAP_MS || 120);

const PING_MS   = 30_000;
const STALE_MS  = 120_000;
const STATUS_MS = 300_000;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Хранилище ───────────────────────────────────────────────────────────────
fs.mkdirSync(DIR, { recursive: true });
const db = new Database(DB_F);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS coins (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS addrs (id INTEGER PRIMARY KEY, addr TEXT UNIQUE NOT NULL);

  CREATE TABLE IF NOT EXISTS flow (
    bar INTEGER NOT NULL, coin INTEGER NOT NULL, addr INTEGER NOT NULL,
    tbuy REAL NOT NULL, tsell REAL NOT NULL,
    mbuy REAL NOT NULL, msell REAL NOT NULL,
    fills INTEGER NOT NULL,
    PRIMARY KEY (bar, coin, addr)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_flow_addr ON flow (addr, bar);

  CREATE TABLE IF NOT EXISTS wallet_day (
    day INTEGER NOT NULL, addr INTEGER NOT NULL, coin INTEGER NOT NULL,
    tbuy REAL NOT NULL, tsell REAL NOT NULL,
    mbuy REAL NOT NULL, msell REAL NOT NULL,
    fills INTEGER NOT NULL,
    PRIMARY KEY (day, addr, coin)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS positions (
    ts INTEGER NOT NULL, addr INTEGER NOT NULL, coin INTEGER NOT NULL,
    szi REAL, entry REAL, liq REAL, lev REAL, ntl REAL,
    PRIMARY KEY (ts, addr, coin)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_pos_coin ON positions (coin, ts);

  CREATE TABLE IF NOT EXISTS accounts (
    ts INTEGER NOT NULL, addr INTEGER NOT NULL,
    equity REAL, upnl REAL, margin REAL,
    PRIMARY KEY (ts, addr)
  ) WITHOUT ROWID;
`);

const insCoin = db.prepare('INSERT OR IGNORE INTO coins (name) VALUES (?)');
const getCoin = db.prepare('SELECT id FROM coins WHERE name = ?');
const insAddr = db.prepare('INSERT OR IGNORE INTO addrs (addr) VALUES (?)');
const getAddr = db.prepare('SELECT id FROM addrs WHERE addr = ?');

const coinIds = new Map();
const addrIds = new Map();

function coinId(name) {
  let id = coinIds.get(name);
  if (id === undefined) {
    insCoin.run(name);
    id = getCoin.get(name).id;
    coinIds.set(name, id);
  }
  return id;
}
function addrId(addr) {
  let id = addrIds.get(addr);
  if (id === undefined) {
    insAddr.run(addr);
    id = getAddr.get(addr).id;
    addrIds.set(addr, id);
  }
  return id;
}

const upFlow = db.prepare(`
  INSERT INTO flow (bar, coin, addr, tbuy, tsell, mbuy, msell, fills)
  VALUES (@bar, @coin, @addr, @tbuy, @tsell, @mbuy, @msell, @fills)
  ON CONFLICT (bar, coin, addr) DO UPDATE SET
    tbuy = tbuy + excluded.tbuy, tsell = tsell + excluded.tsell,
    mbuy = mbuy + excluded.mbuy, msell = msell + excluded.msell,
    fills = fills + excluded.fills`);

const upDay = db.prepare(`
  INSERT INTO wallet_day (day, addr, coin, tbuy, tsell, mbuy, msell, fills)
  VALUES (@day, @addr, @coin, @tbuy, @tsell, @mbuy, @msell, @fills)
  ON CONFLICT (day, addr, coin) DO UPDATE SET
    tbuy = tbuy + excluded.tbuy, tsell = tsell + excluded.tsell,
    mbuy = mbuy + excluded.mbuy, msell = msell + excluded.msell,
    fills = fills + excluded.fills`);

const insPos = db.prepare(`INSERT OR REPLACE INTO positions
  (ts, addr, coin, szi, entry, liq, lev, ntl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insAcc = db.prepare(`INSERT OR REPLACE INTO accounts
  (ts, addr, equity, upnl, margin) VALUES (?, ?, ?, ?, ?)`);

// ── Накопление потока ───────────────────────────────────────────────────────
// Ключ агрегата — "монета|адрес" в пределах текущего бара. Копим в памяти и
// пишем одной транзакцией на смене бара: 6300 строк раз в 5 минут вместо
// 9.7М вставок в сутки.
let bar = Math.floor(Date.now() / BAR_MS);
let acc = new Map();
let lastMsgAt = Date.now();
let fillsSeen = 0;
let usdSeen = 0;

function bump(coin, addr, usd, taker, buy) {
  const key = `${coin}|${addr}`;
  let r = acc.get(key);
  if (!r) { r = { coin, addr, tbuy: 0, tsell: 0, mbuy: 0, msell: 0, fills: 0 }; acc.set(key, r); }
  if (taker) { if (buy) r.tbuy += usd; else r.tsell += usd; }
  else       { if (buy) r.mbuy += usd; else r.msell += usd; }
  r.fills += 1;
}

const flushTx = db.transaction((rows, barId, dayId) => {
  for (const r of rows) {
    const coin = coinId(r.coin);
    const addr = addrId(r.addr);
    const rec = { coin, addr, tbuy: r.tbuy, tsell: r.tsell, mbuy: r.mbuy, msell: r.msell, fills: r.fills };
    upFlow.run({ ...rec, bar: barId });
    upDay.run({ ...rec, day: dayId });
  }
});

function flush(barId) {
  const rows = [...acc.values()].filter(
    (r) => r.tbuy + r.tsell + r.mbuy + r.msell >= MIN_USD,
  );
  acc = new Map();
  if (!rows.length) return;
  const dayId = Math.floor((barId * BAR_MS) / 86_400_000);
  flushTx(rows, barId, dayId);
  log(`бар ${barId}: строк ${rows.length}, филлов ${fillsSeen}, оборот $${(usdSeen / 1e6).toFixed(1)}М`);
  fillsSeen = 0; usdSeen = 0;
}

function onTrades(list) {
  for (const t of list) {
    const px = Number(t.px);
    const sz = Number(t.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    const usd = px * sz;
    const [buyer, seller] = t.users;
    if (!buyer || !seller) continue;
    const takerIsBuyer = t.side === 'B';
    bump(t.coin, buyer,  usd, takerIsBuyer,  true);
    bump(t.coin, seller, usd, !takerIsBuyer, false);
    fillsSeen += 1;
    usdSeen += usd;
  }
}

// ── Подписка на поток ───────────────────────────────────────────────────────
async function universe() {
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  if (!r.ok) throw new Error(`meta http ${r.status}`);
  const { universe: u } = await r.json();
  return u.filter((a) => !a.isDelisted).map((a) => a.name);
}

let ws = null;
let backoff = 1_000;

async function connect() {
  let coins;
  try {
    coins = await universe();
  } catch (err) {
    log(`вселенная недоступна: ${err.message}`);
    setTimeout(connect, backoff = Math.min(backoff * 2, 30_000));
    return;
  }

  ws = new WebSocket(HL_WS);

  ws.on('open', () => {
    backoff = 1_000;
    lastMsgAt = Date.now();
    for (const c of coins) {
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: c } }));
    }
    log(`подписка на ${coins.length} монет`);
  });

  ws.on('message', (raw) => {
    lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.channel === 'trades' && Array.isArray(msg.data)) onTrades(msg.data);
  });

  ws.on('close', () => {
    log('WS закрыт, переподключение');
    setTimeout(connect, backoff = Math.min(backoff * 2, 30_000));
  });
  ws.on('error', (e) => log(`WS ошибка: ${e.message}`));
}

// ── Срезы чужих позиций ─────────────────────────────────────────────────────
// Опрашиваем не всех подряд, а кошельки с наибольшим оборотом за сутки: в
// остальных нет ни размера, ни ликвидации, которые кого-то двинут.
const topWallets = db.prepare(`
  SELECT a.id AS id, a.addr AS addr, SUM(f.tbuy + f.tsell + f.mbuy + f.msell) AS vol
    FROM flow f JOIN addrs a ON a.id = f.addr
   WHERE f.bar >= ?
   GROUP BY f.addr
   ORDER BY vol DESC
   LIMIT ?`);

async function state(addr) {
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: addr }),
  });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

async function sweepPositions() {
  const since = Math.floor((Date.now() - 86_400_000) / BAR_MS);
  const list = topWallets.all(since, POS_TOP);
  if (!list.length) return;

  const ts = Date.now();
  let withPos = 0;
  const batch = [];

  for (const w of list) {
    try {
      const s = await state(w.addr);
      const m = s.marginSummary || {};
      batch.push({
        acc: [ts, w.id, Number(m.accountValue), Number(m.totalUnrealizedPnl ?? 0), Number(m.totalMarginUsed ?? 0)],
        pos: (s.assetPositions || []).map((p) => {
          const P = p.position;
          return [ts, w.id, coinId(P.coin), Number(P.szi), Number(P.entryPx),
            P.liquidationPx === null ? null : Number(P.liquidationPx),
            Number(P.leverage?.value ?? 0), Number(P.positionValue)];
        }),
      });
      if (batch.at(-1).pos.length) withPos += 1;
    } catch {
      // Кошелёк мог исчезнуть или биржа притормозить — пропуск дешевле остановки.
    }
    await sleep(POS_GAP_MS);
  }

  db.transaction(() => {
    for (const b of batch) {
      insAcc.run(...b.acc);
      for (const p of b.pos) insPos.run(...p);
    }
  })();
  log(`срез позиций: опрошено ${batch.length}, с позициями ${withPos}`);
}

// ── Ретеншн ─────────────────────────────────────────────────────────────────
function prune() {
  const barCut = Math.floor((Date.now() - KEEP_FLOW_DAYS * 86_400_000) / BAR_MS);
  const tsCut = Date.now() - KEEP_POS_DAYS * 86_400_000;
  const a = db.prepare('DELETE FROM flow WHERE bar < ?').run(barCut).changes;
  const b = db.prepare('DELETE FROM positions WHERE ts < ?').run(tsCut).changes;
  const c = db.prepare('DELETE FROM accounts WHERE ts < ?').run(tsCut).changes;
  if (a || b || c) log(`ретеншн: flow −${a}, positions −${b}, accounts −${c}`);
}

// ── Жизненный цикл ──────────────────────────────────────────────────────────
process.on('SIGTERM', () => { flush(bar); db.close(); process.exit(0); });
process.on('SIGINT',  () => { flush(bar); db.close(); process.exit(0); });

await connect();

let lastPos = 0;
let lastStatus = 0;
let lastPrune = 0;

for (;;) {
  const now = Date.now();

  const cur = Math.floor(now / BAR_MS);
  if (cur !== bar) { try { flush(bar); } catch (e) { log(`flush: ${e.message}`); } bar = cur; }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.ping();
    // Тишина при живом сокете = фид умер молча; рвём сами, close переподключит.
    if (now - lastMsgAt > STALE_MS) { log('фид молчит, рву соединение'); ws.terminate(); }
  }

  if (now - lastPos > POS_EVERY_MS) {
    lastPos = now;
    sweepPositions().catch((e) => log(`срез позиций: ${e.message}`));
  }

  if (now - lastPrune > 86_400_000) { lastPrune = now; try { prune(); } catch (e) { log(`ретеншн: ${e.message}`); } }

  if (now - lastStatus > STATUS_MS) {
    lastStatus = now;
    const n = db.prepare('SELECT COUNT(*) c FROM flow').get().c;
    const w = db.prepare('SELECT COUNT(*) c FROM addrs').get().c;
    const mb = (fs.statSync(DB_F).size / 1048576).toFixed(0);
    log(`база: flow ${n} строк, кошельков ${w}, ${mb} МБ`);
  }

  await sleep(PING_MS);
}
