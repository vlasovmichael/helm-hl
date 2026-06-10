// ─────────────────────────────────────────────────
//  Setup Scanner Swing — entry/exit алерты (ntfy + дашборд)
// ─────────────────────────────────────────────────
// Два вида сигналов поверх setupScannerSwing.js:
//
//  ENTRY: монета с swing-сигналом LONG/SHORT вошла в entry-зону (цена у 1h
//  EMA20) → пуш «иди смотреть глазами». Алерт только на ПЕРЕХОДЕ в зону;
//  первый прогон после рестарта лишь записывает состояние (анти-спам).
//
//  EXIT: по ОТКРЫТОЙ позиции на счёте (ручной или ботовой) swing-контекст
//  уходит → пуш. Два уровня: 'ema20' (цена закрепилась против позиции за 1h
//  EMA20 — импульс теряется) и 'trend' (1h тренд развернулся — контекст
//  сломан). Пуш на эскалации уровня. После рестарта может прислать повторно
//  один раз — это осознанно: инфа по живой позиции важнее анти-спама.
//
// ⚠️ Это КОНТЕКСТ-алерты, не команды: не TP/SL, без цен входа/выхода.
// Решение и инвалидация — у оператора. Fail-soft: ошибки не валят бота.

import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { getSetupScannerRows } from '../core/database.js';
import { getPositions } from './exchange.js';
import { enrichSwingSignals, requestSwingTrendRefresh } from './setupScannerSwing.js';

const ENABLED =
  (process.env.SETUP_SWING_ALERT_ENABLED || 'true').toLowerCase() === 'true';
const INTERVAL_MS =
  parseFloat(process.env.SETUP_SWING_ALERT_INTERVAL_MIN || '5') * 60_000;
const ENTRY_COOLDOWN_MS = 4 * 3_600_000; // повторный entry-пуш по той же монете+стороне
const EXIT_COOLDOWN_MS  = 2 * 3_600_000;

// ── Pure: exit-контекст по позиции ───────────────────────────────────────────

const EXIT_EMA20_PCT = 0.5; // закрепление за 1h EMA20 против позиции

/**
 * Оценивает, не ушёл ли swing-контекст против открытой позиции.
 *
 * @param {'long'|'short'} side
 * @param {{trend1h:string|null, trend4h:string|null, ext1h:number|null}} swing
 * @returns {{ level: null|'ema20'|'trend', reason: string }}
 */
export function evaluateExitContext(side, swing) {
  if (!swing || swing.trend1h == null) {
    return { level: null, reason: 'no trend data' };
  }
  const against = side === 'long' ? 'down' : 'up';
  const arrow = (t) => (t === 'up' ? '↑' : t === 'down' ? '↓' : '−');
  const tfStr = `4h${arrow(swing.trend4h)} 1h${arrow(swing.trend1h)}`;

  if (swing.trend1h === against) {
    return {
      level: 'trend',
      reason: `1h тренд развернулся против ${side.toUpperCase()} (${tfStr}) — контекст сломан`,
    };
  }
  const ext = swing.ext1h;
  if (ext != null) {
    const crossed =
      side === 'long' ? ext <= -EXIT_EMA20_PCT : ext >= EXIT_EMA20_PCT;
    if (crossed) {
      return {
        level: 'ema20',
        reason: `цена закрепилась ${side === 'long' ? 'под' : 'над'} 1h EMA20 (${ext >= 0 ? '+' : ''}${ext.toFixed(1)}%) против ${side.toUpperCase()} — импульс теряется`,
      };
    }
  }
  return { level: null, reason: `контекст за позицию (${tfStr})` };
}

/** assetPositions из clearinghouseState → [{coin, side, sizeUsd}] */
export function parseAccountPositions(assetPositions) {
  const out = [];
  for (const ap of assetPositions ?? []) {
    const p = ap?.position;
    const szi = parseFloat(p?.szi ?? '0');
    if (!p?.coin || !szi) continue;
    out.push({
      coin: p.coin,
      side: szi > 0 ? 'long' : 'short',
      sizeUsd: Math.abs(parseFloat(p.positionValue ?? '0')) || null,
    });
  }
  return out;
}

// ── ntfy ─────────────────────────────────────────────────────────────────────

// Тихий час: 00–08 Europe/Warsaw. Пуши не дропаем — шлём с priority=1 (min):
// ntfy доставляет без звука/вибрации, утром всё видно в ленте.
const QUIET_FROM = parseInt(process.env.SETUP_SWING_QUIET_FROM ?? '0', 10);
const QUIET_TO   = parseInt(process.env.SETUP_SWING_QUIET_TO ?? '8', 10);

export function isQuietHour(now = Date.now()) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric', hour12: false, timeZone: 'Europe/Warsaw',
    }).format(now),
    10,
  );
  // Поддерживает и «через полночь» (22→7), и обычный интервал (0→8).
  return QUIET_FROM <= QUIET_TO
    ? hour >= QUIET_FROM && hour < QUIET_TO
    : hour >= QUIET_FROM || hour < QUIET_TO;
}

async function fireNtfy(title, message, tags) {
  const { url, token } = config.ntfy;
  const topic = process.env.NTFY_TOPIC_SWING || config.ntfy.topic;
  if (!url || !topic) return;
  try {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');
    const priority = isQuietHour() ? 1 : 4;
    const body = JSON.stringify({ topic, title, message, priority, tags });
    const u = new URL(`${url}/`);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await new Promise((resolve, reject) => {
      const req = lib.request(
        { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/', method: 'POST', headers },
        (res) => { res.resume(); res.on('end', resolve); },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    logger.warn(`[SwingAlerts] ntfy failed: ${err.message}`);
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

const prevEntryState = new Map(); // coin → 'LONG'|'SHORT'|null (в зоне ли с сигналом)
const entryAlertAt   = new Map(); // 'coin:side' → ts
const prevExitLevel  = new Map(); // 'coin:side' → null|'ema20'|'trend'
const exitAlertAt    = new Map(); // 'coin:side' → ts
let firstRunDone = false;

const EXIT_RANK = { ema20: 1, trend: 2 };

async function runOnce(now = Date.now()) {
  const rows = getSetupScannerRows();

  let positions = [];
  try {
    positions = parseAccountPositions(await getPositions());
  } catch (err) {
    logger.debug(`[SwingAlerts] getPositions failed: ${err.message}`);
  }

  // Монеты позиций добавляем в скан, даже если collector их не трекает.
  const known = new Set(rows.map((r) => r.coin));
  for (const p of positions) {
    if (!known.has(p.coin)) rows.push({ coin: p.coin });
  }
  if (!rows.length) return;

  // Дожидаемся свежих трендов (поверх TTL-кэшей — обычно мгновенно).
  const refresh = requestSwingTrendRefresh(rows.map((r) => r.coin), now);
  if (refresh) await refresh;
  const enriched = enrichSwingSignals(rows, now);
  const byCoin = new Map(enriched.map((r) => [r.coin, r]));

  // ── ENTRY: переход «сигнал + зона» ──
  for (const r of enriched) {
    const s = r.swing;
    const cur =
      (s.signal === 'LONG' || s.signal === 'SHORT') && s.entryZone === 'zone'
        ? s.signal
        : null;
    const prev = prevEntryState.get(r.coin) ?? null;
    prevEntryState.set(r.coin, cur);
    if (!firstRunDone || !cur || cur === prev) continue;

    const key = `${r.coin}:${cur}`;
    if (now - (entryAlertAt.get(key) ?? 0) < ENTRY_COOLDOWN_MS) continue;
    entryAlertAt.set(key, now);

    const ext = s.ext1h != null ? `${s.ext1h >= 0 ? '+' : ''}${s.ext1h.toFixed(1)}%` : '—';
    logger.info(`[SwingAlerts] 🎯 entry zone: ${cur} #${r.coin} (ext ${ext})`);
    await fireNtfy(
      `🎯 ${cur} zone #${r.coin}`,
      `swing ${cur} · цена у 1h EMA20 (${ext})\n${(s.reasons || []).join(' · ')}\nВход и стоп — твои. Смотри 5m.`,
      [cur === 'LONG' ? 'green_circle' : 'red_circle'],
    );
  }

  // ── EXIT: эскалация уровня по открытым позициям ──
  const activeKeys = new Set();
  for (const p of positions) {
    const r = byCoin.get(p.coin);
    if (!r) continue;
    const ev = evaluateExitContext(p.side, r.swing);
    const key = `${p.coin}:${p.side}`;
    activeKeys.add(key);
    const prev = prevExitLevel.get(key) ?? null;
    prevExitLevel.set(key, ev.level);
    if (!ev.level) continue;
    if ((EXIT_RANK[ev.level] ?? 0) <= (EXIT_RANK[prev] ?? 0)) continue;

    if (now - (exitAlertAt.get(key) ?? 0) < EXIT_COOLDOWN_MS) continue;
    exitAlertAt.set(key, now);

    const sizeTxt = p.sizeUsd ? ` ($${p.sizeUsd.toFixed(0)})` : '';
    logger.info(`[SwingAlerts] ⚠️ exit context: #${p.coin} ${p.side} → ${ev.level}`);
    await fireNtfy(
      `⚠️ #${p.coin} ${p.side.toUpperCase()}${sizeTxt} — контекст уходит`,
      `${ev.reason}\nЭто не команда закрыть — проверь график и свой стоп.`,
      ['warning'],
    );
  }
  // Закрытые позиции — чистим стейт, чтобы новая поза алертила заново.
  for (const k of [...prevExitLevel.keys()]) {
    if (!activeKeys.has(k)) {
      prevExitLevel.delete(k);
      exitAlertAt.delete(k);
    }
  }

  firstRunDone = true;
}

/** Запуск воркера. Независим от открытого дашборда. */
export function startSetupSwingAlerts() {
  if (!ENABLED) {
    logger.info('[SwingAlerts] disabled (SETUP_SWING_ALERT_ENABLED=false)');
    return;
  }
  const timer = setInterval(() => {
    runOnce().catch((err) => logger.warn(`[SwingAlerts] tick failed: ${err.message}`));
  }, INTERVAL_MS);
  timer.unref?.();
  // Первый прогон сразу: прогревает trend-кэш и записывает baseline-состояния.
  runOnce().catch((err) => logger.warn(`[SwingAlerts] warmup failed: ${err.message}`));
  logger.info(`[SwingAlerts] started — every ${INTERVAL_MS / 60_000}min, topic=${process.env.NTFY_TOPIC_SWING || config.ntfy.topic || '—'}`);
}

/** Сброс стейта (тесты). */
export function clearSwingAlertState() {
  prevEntryState.clear();
  entryAlertAt.clear();
  prevExitLevel.clear();
  exitAlertAt.clear();
  firstRunDone = false;
}
