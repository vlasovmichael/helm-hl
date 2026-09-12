// ─────────────────────────────────────────────────────────────────────────────
//  Будильник по живым FVG-сетапам: ретест широкой зоны состоялся — пуш в ntfy.
//
//  🚨 ЭТО НЕ СИГНАЛ НА ВХОД. Гипотеза fvg-wide-retest-4h ещё в форварде,
//  порог n=1500, вердикт по критериям реестра. До вердикта уровни в пуше —
//  материал для насмотренности, а не разрешение торговать.
//
//  Форвард-журнал от этого скрипта не зависит: его наполняет fvgForward.mjs
//  из свечей, а не из сделок оператора. Подглядывания тут нет — метрики
//  не считаются и не печатаются, только геометрия текущего сетапа.
//
//  Делит базу свечей с fvgForward.mjs: историю читает из неё, а догружает
//  только свежий хвост — 4h EMA50 требует ~2 недель, качать их каждые 15 мин
//  незачем.
//
//  Запуск: node scripts/fvgWatch.mjs [--dry] [--fetch-days 2] [--read-days 20]
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { findLiveSetups } from '../tools/fvgZones.mjs';
import { PARAMS } from '../tools/fvgRule.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const FETCH_DAYS = parseInt(arg('fetch-days', process.env.FVG_WATCH_FETCH_DAYS || '2'), 10);
// 20 дней: 80 баров 4h (EMA50 + запас) ≈ 14 дней, берём с полем.
const READ_DAYS = parseInt(arg('read-days', process.env.FVG_WATCH_READ_DAYS || '20'), 10);
// Сколько последних 15m баров считать «только что». 1 = звать в момент касания.
const FRESH_BARS = parseInt(process.env.FVG_WATCH_FRESH_BARS || '1', 10);
// Темп догрузки, запросов в минуту. Вес candleSnapshot — 20 единиц, лимит HL —
// 1000 в минуту на IP, и бот ест из того же лимита: скрипт работает отдельным
// процессом и в весовую очередь hlClient не попадает.
//
// 🚨 не качать вселенную залпом: две сотни монет разом = кратно выше лимита за
// одну минуту, и торговый путь бота голодает. 30 запросов/мин = 600 единиц,
// боту остаётся запас.
const FETCH_RPM = parseInt(process.env.FVG_WATCH_RPM || '30', 10);
const DB_PATH = process.env.FVG_DB || 'candles.db';
const STATE_FILE = 'data/fvg-watch/seen.json';
// Зона живёт максимум wait баров 4h; месяц с запасом покрывает её целиком.
const STATE_TTL_MS = 30 * 86400_000;
const API = 'https://api.hyperliquid.xyz/info';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Тихий час и топик — как у остальных пушей. Логику ntfy не импортируем:
// src/core/config.js требует торговое окружение, а скрипт обязан подниматься
// и вне контейнера, ради --dry.
const QUIET_FROM = parseInt(process.env.NTFY_QUIET_FROM ?? '0', 10);
const QUIET_TO = parseInt(process.env.NTFY_QUIET_TO ?? '8', 10);
const NTFY_URL = process.env.NTFY_URL || 'http://ntfy:80';
const TOPIC = process.env.NTFY_TOPIC_FVG || process.env.NTFY_TOPIC_MOVERS || process.env.NTFY_TOPIC || 'hl-signals';
const TOKEN = process.env.NTFY_TOKEN || '';

function isQuietHour(now = Date.now()) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Warsaw' }).format(now),
    10,
  );
  return QUIET_FROM <= QUIET_TO ? hour >= QUIET_FROM && hour < QUIET_TO : hour >= QUIET_FROM || hour < QUIET_TO;
}

async function post(b, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error('HTTP 429 (исчерпаны ретраи)');
}

async function firePush(title, message, now) {
  const priority = isQuietHour(now) ? 1 : 3;
  try {
    const res = await fetch(`${NTFY_URL}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ topic: TOPIC, title, message, priority, tags: ['mag'] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`[ntfy] не ушло: ${err.message}`);
    return;
  }
  // Колокольчик на дашборде. notifyLog не тянет config, поэтому доступен здесь.
  try {
    const { recordNotification } = await import('../src/core/notifyLog.js');
    recordNotification({ title, message, topic: TOPIC, tags: ['mag'], priority, ts: now });
  } catch (err) {
    console.error(`[bell] журнал не записан: ${err.message}`);
  }
}

// ── свежий хвост свечей ─────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS candles (
   coin TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
   PRIMARY KEY (coin, t)
 )`);

if (!process.argv.includes('--no-fetch')) {
  const ins = db.prepare('INSERT OR REPLACE INTO candles (coin,t,o,h,l,c,v) VALUES (?,?,?,?,?,?,?)');
  const many = db.transaction((c, rs) => { for (const k of rs) ins.run(c, k.t, +k.o, +k.h, +k.l, +k.c, +k.v); });
  const meta = await post({ type: 'metaAndAssetCtxs' });
  const coins = meta[0].universe.filter((u) => !u.isDelisted).map((u) => u.name);
  const start = Date.now() - FETCH_DAYS * 86400_000;
  let got = 0;
  // Последовательно и с паузой: параллельные потоки складывают свой вес в одну
  // минуту, а лимит считается по IP, не по соединению.
  const gapMs = Math.ceil(60_000 / Math.max(1, FETCH_RPM));
  for (const coin of coins) {
    try {
      const cs = await post({ type: 'candleSnapshot', req: { coin, interval: '15m', startTime: start, endTime: Date.now() } });
      if (Array.isArray(cs) && cs.length) { many(coin, cs); got += cs.length; }
    } catch { /* пропуск монеты не ломает прогон */ }
    await sleep(gapMs);
  }
  console.log(`[fetch] ${coins.length} монет · +${got} свечей · темп ${FETCH_RPM}/мин`);
}

const rows = db.prepare('SELECT coin,t,o,h,l,c FROM candles WHERE t >= ? ORDER BY coin,t')
  .all(Date.now() - READ_DAYS * 86400_000);
db.close();
const byCoin = new Map();
for (const r of rows) { let a = byCoin.get(r.coin); if (!a) byCoin.set(r.coin, (a = [])); a.push(r); }

// ── дедуп: одна зона = один пуш ─────────────────────────────────────────────
mkdirSync('data/fvg-watch', { recursive: true });
let seen = {};
if (existsSync(STATE_FILE)) {
  try { seen = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { seen = {}; }
}
const now = Date.now();
for (const [k, ts] of Object.entries(seen)) if (now - ts > STATE_TTL_MS) delete seen[k];

const fmt = (v) => (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
let pushed = 0, found = 0;

for (const [coin, bars] of byCoin) {
  let setups;
  try { setups = findLiveSetups(coin, bars, { freshBars: FRESH_BARS }); } catch { continue; }
  for (const s of setups) {
    found++;
    const key = `${coin}|${s.zoneT}`;
    if (seen[key]) continue;
    seen[key] = now;

    const title = `🧲 FVG #${coin} ${s.side} — ретест зоны`;
    const message =
      `Зона ${fmt(s.zBot)} … ${fmt(s.zTop)} (ширина ${s.zoneWidthPct.toFixed(2)}%)\n` +
      `Вход ${fmt(s.entry)} · стоп ${fmt(s.stop)} (${s.stopDistPct.toFixed(2)}%) · цель ${fmt(s.tgt)} = ${PARAMS.rr}R\n` +
      `─────────────────────\n` +
      `🚨 Гипотеза НЕ подтверждена: форвард идёт, вердикт 15.12.2026 по критериям реестра.\n` +
      `Это материал для насмотренности, не разрешение входить.`;

    console.log(`[fvg] ${coin} ${s.side} зона ${s.zoneWidthPct.toFixed(2)}% · вход ${fmt(s.entry)} · стоп ${fmt(s.stop)}`);
    if (!DRY) { await firePush(title, message, now); pushed++; }
  }
}

if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(seen));
console.log(
  `[fvgWatch] монет ${byCoin.size} · свежих сетапов ${found} · пушей ${pushed}` +
  `${DRY ? ' (--dry: ничего не отправлено, состояние не записано)' : ''}`,
);
