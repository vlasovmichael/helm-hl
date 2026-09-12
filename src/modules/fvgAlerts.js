// ─────────────────────────────────────────────────
//  FVG-будильник — ретест широкой зоны на 4h
// ─────────────────────────────────────────────────
// 🚨 НЕ сигнал на вход: гипотеза fvg-wide-retest-4h ещё в форварде, вердикт по
// критериям реестра. Уровни в пуше — материал для насмотренности; это сказано
// и в самом тексте пуша.
//
// Форвард от будильника не зависит: журнал наполняет scripts/fvgForward.mjs из
// свечей, а не из сделок оператора. Метрики тут не считаются.
//
// Живёт ВНУТРИ процесса бота, и это единственная причина, по которой он модуль,
// а не крон-скрипт: колокольчик, бейдж и тост дашборда кормятся из памяти этого
// процесса через fireNtfy → notifyLog. Внешняя запись в тот же файл теряется
// сама и затирает записи бота.
//
// Свечи: история из candles.db (её наполняет крон форварда), свежий хвост —
// через candleCache, то есть под весовой очередью hlClient с низким
// приоритетом: торговый путь всегда впереди, а отвал по дедлайну не авария.
//
// 🚨 Базу читать ПО ОДНОЙ монете и отдавать event loop между ними: выборка за
// 20 дней целиком — сотни тысяч строк и секунды синхронной блокировки, а
// better-sqlite3 синхронный.

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { fireNtfy } from '../core/ntfy.js';
import { state } from '../app/state.js';
import { HL_PRIORITY } from '../core/hlClient.js';
import { getFifteenMinCandles } from './candleCache.js';
import { findLiveSetups, findPendingZones } from '../../tools/fvgZones.mjs';
import { PARAMS } from '../../tools/fvgRule.mjs';

const ENABLED = (process.env.FVG_ALERT_ENABLED || 'true').toLowerCase() === 'true';
const INTERVAL_MS = parseFloat(process.env.FVG_ALERT_INTERVAL_MIN || '5') * 60_000;
// Сколько последних 15m баров считать «только что». 1 = звать в момент касания.
const FRESH_BARS = parseInt(process.env.FVG_ALERT_FRESH_BARS || '1', 10);
// 20 дней: 80 баров 4h (EMA50 + запас) ≈ 14 дней, берём с полем.
const READ_DAYS = parseFloat(process.env.FVG_ALERT_READ_DAYS || '20');
const FETCH_MIN = parseFloat(process.env.FVG_ALERT_FETCH_DAYS || '2') * 1440;
const DB_PATH = process.env.FVG_DB || 'data/candles.db';
const STATE_FILE = 'data/fvg-watch/seen.json';
// Зона живёт максимум wait баров 4h; месяц с запасом покрывает её целиком.
const STATE_TTL_MS = 30 * 86400_000;
const HTF_MS = 4 * 3600_000;

const seen = new Map();     // coin|zoneT → ts пуша
let lastFullAt = 0;         // когда последний раз обходили всю вселенную
let timer = null;

/** Свежая порция из HL поверх истории из базы. Дубли по t решает свежая. */
export function mergeBars(dbBars, fresh) {
  const byT = new Map();
  for (const b of dbBars || []) byT.set(b.t, b);
  for (const c of fresh || []) {
    if (!Number.isFinite(c?.time)) continue;
    byT.set(c.time, { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Сменился ли 4-часовой бар с прошлого полного обхода.
 * Новые зоны рождаются только на закрытии 4h свечи, поэтому вселенную незачем
 * обходить чаще — а каждый проход по ней стоит запрос на монету.
 */
export function isNewHtfBucket(prevTs, now) {
  if (!prevTs) return true;
  return Math.floor(now / HTF_MS) !== Math.floor(prevTs / HTF_MS);
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw.seen ?? {})) seen.set(k, v);
    lastFullAt = raw.lastFullAt ?? 0;
  } catch {
    // нет файла / битый — с нуля
  }
}

function saveState() {
  try {
    mkdirSync('data/fvg-watch', { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ seen: Object.fromEntries(seen), lastFullAt }));
  } catch (err) {
    logger.warn(`[FvgAlerts] state save failed: ${err.message}`);
  }
}

const fmt = (v) => (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
const yieldLoop = () => new Promise((r) => setImmediate(r));

async function runOnce(now = Date.now()) {
  const universe = [...new Set((state.latestHunter || []).map((i) => i?.coin).filter(Boolean))];
  if (universe.length === 0) return;

  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    logger.warn(`[FvgAlerts] база свечей недоступна: ${err.message}`);
    return;
  }

  const full = isNewHtfBucket(lastFullAt, now);
  const since = now - READ_DAYS * 86400_000;
  const q = db.prepare('SELECT t,o,h,l,c FROM candles WHERE coin=? AND t >= ? ORDER BY t');
  let pushed = 0, refreshed = 0;

  for (const [k, ts] of seen) if (now - ts > STATE_TTL_MS) seen.delete(k);

  for (const coin of universe) {
    let bars;
    try { bars = q.all(coin, since); } catch { continue; }
    if (bars.length < 400) { await yieldLoop(); continue; }

    // Зона в силе = вход по ней ещё возможен; только такие монеты и освежаем.
    let pending = [];
    try { pending = findPendingZones(coin, bars); } catch { /* монета не ломает проход */ }

    if (full || pending.length) {
      try {
        const fresh = await getFifteenMinCandles(coin, FETCH_MIN, now, HL_PRIORITY.LOW);
        if (fresh?.length) { bars = mergeBars(bars, fresh); refreshed++; }
      } catch {
        // отвал по весовому бюджету — не авария, посмотрим в следующий проход
      }
    }

    let setups = [];
    try { setups = findLiveSetups(coin, bars, { freshBars: FRESH_BARS }); } catch { /* пропуск */ }

    for (const s of setups) {
      const key = `${coin}|${s.zoneT}`;
      if (seen.has(key)) continue;
      seen.set(key, now);
      logger.info(
        `[FvgAlerts] 🧲 #${coin} ${s.side} зона ${s.zoneWidthPct.toFixed(2)}% · ` +
        `вход ${fmt(s.entry)} · стоп ${fmt(s.stop)}`,
      );
      await fireNtfy({
        topic: process.env.NTFY_TOPIC_FVG || process.env.NTFY_TOPIC_MOVERS || config.ntfy.topic,
        title: `🧲 FVG #${coin} ${s.side} — ретест зоны`,
        message:
          `Зона ${fmt(s.zBot)} … ${fmt(s.zTop)} (ширина ${s.zoneWidthPct.toFixed(2)}%)\n` +
          `Вход ${fmt(s.entry)} · стоп ${fmt(s.stop)} (${s.stopDistPct.toFixed(2)}%) · ` +
          `цель ${fmt(s.tgt)} = ${PARAMS.rr}R\n` +
          `─────────────────────\n` +
          `🚨 Гипотеза НЕ подтверждена: форвард идёт, вердикт по критериям реестра.\n` +
          `Это материал для насмотренности, не разрешение входить.`,
        tags: ['mag'],
      });
      pushed++;
    }
    await yieldLoop();
  }

  db.close();
  if (full) lastFullAt = now;
  saveState();
  if (pushed || full) {
    logger.info(
      `[FvgAlerts] проход${full ? ' полный' : ''}: монет ${universe.length} · ` +
      `освежено ${refreshed} · пушей ${pushed}`,
    );
  }
}

/** Запуск воркера. Независим от открытого дашборда. */
export function startFvgAlerts() {
  if (!ENABLED) {
    logger.info('[FvgAlerts] disabled (FVG_ALERT_ENABLED=false)');
    return;
  }
  loadState();
  timer = setInterval(() => {
    runOnce().catch((err) => logger.warn(`[FvgAlerts] tick failed: ${err.message}`));
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info(
    `[FvgAlerts] started — каждые ${INTERVAL_MS / 60_000}мин, свежесть ${FRESH_BARS} бар(а) 15m, ` +
    `история ${READ_DAYS}д из ${DB_PATH}, полный обход вселенной раз в 4ч`,
  );
}

/** Сброс состояния (тесты). */
export function _resetFvgAlerts() {
  seen.clear();
  lastFullAt = 0;
}
